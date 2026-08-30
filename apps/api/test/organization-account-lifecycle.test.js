import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import express from "express";
import { newDb } from "pg-mem";

import { createPostgresStore } from "../src/data/postgres-store.js";
import { createMutationAsyncRoute } from "../src/data/mutation-lock.js";
import { ensureDbShape, seedDb } from "../src/data/seed.js";
import { createOrganizationsRouter } from "../src/routes/organizations.js";
import { deleteOrganizationAccount, organizationHistoryFields } from "../src/services/organization-account-lifecycle.js";
import { replayFileCleanupJournal } from "../src/services/organizations.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const deletedAt = "2026-08-06T09:00:00.000Z";

function lifecycleFixture() {
  const db = ensureDbShape(structuredClone(seedDb));
  const organization = db.organizations.find((row) => row.id === "O1001");
  const owner = db.users.find((row) => row.id === organization.ownerUserId);
  const member = db.users.find((row) => row.id === "U1001");
  const registration = {
    ...structuredClone(db.registrations[1]),
    id: "R-DELETE-HISTORY",
    organizationId: organization.id,
    organization: organization.name,
    createdByUserId: owner.id,
    personalUserId: null,
    createdVia: "organization",
    source: "organization_proxy",
    athlete: { name: "历史学生", school: organization.name, grade: "六年级", phone: "13800008888" },
    athleteKey: "历史学生|历史学校|六年级|13800008888",
    awardName: "一等奖",
    rank: "1",
    score: "98",
    resultRecordedAt: "2026-08-05T08:00:00.000Z"
  };
  db.registrations.push(registration);
  db.certificates.push({
    id: "C-DELETE-HISTORY", registrationId: registration.id, slot: 1,
    title: "一等奖证书", fileName: "history.png", storedName: "history.png",
    filePath: "/safe/history.png", awardName: "一等奖", rank: "1", score: "98",
    status: "published", source: "manual", importBatchId: null,
    uploadedAt: "2026-08-05T08:30:00.000Z", publishedAt: "2026-08-05T09:00:00.000Z", cleanedAt: ""
  });
  db.organizationDocuments.push(
    { id: "OD-CURRENT", organizationId: organization.id, documentType: "business_license", originalName: "license.pdf", storedName: "license.pdf", filePath: "/private/license.pdf", mimeType: "application/pdf", sizeBytes: 100, uploadedAt: "2026-08-01T00:00:00.000Z", cleanedAt: null },
    { id: "OD-CLEANED", organizationId: organization.id, documentType: "business_license", originalName: "old.pdf", storedName: "old.pdf", filePath: "/private/old.pdf", mimeType: "application/pdf", sizeBytes: 100, uploadedAt: "2026-07-01T00:00:00.000Z", cleanedAt: "2026-07-10T00:00:00.000Z" }
  );
  organization.currentDocumentId = "OD-CURRENT";
  db.organizationEventParticipations.push({ organizationId: organization.id, eventId: db.events[0].id, joinedByUserId: owner.id, joinedAt: "2026-08-01T00:00:00.000Z" });
  db.memberships.push({ id: "M-INVITE", userId: null, invitedPhone: "13800007777", invitedName: "待邀请成员", organizationId: organization.id, role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" });
  db.registrationUploadSessions.push(
    {
      id: "US-COMMITTED", eventId: registration.eventId, projectId: registration.projectId,
      ownerUserId: owner.id, organizationId: organization.id, channel: "organization", state: "committed",
      createdAt: "2026-08-05T07:00:00.000Z", expiresAt: "2026-08-06T07:00:00.000Z", committedAt: "2026-08-05T08:00:00.000Z"
    },
    {
      id: "US-TEMPORARY", eventId: registration.eventId, projectId: registration.projectId,
      ownerUserId: owner.id, organizationId: organization.id, channel: "organization", state: "active",
      createdAt: "2026-08-05T07:00:00.000Z", expiresAt: "2026-08-06T07:00:00.000Z", committedAt: null
    }
  );
  db.registrationSubmissionAssets.push(
    {
      id: "SA-COMMITTED", registrationId: registration.id, uploadSessionId: "US-COMMITTED", kind: "artwork_image",
      originalName: "history-work.png", storedName: "history-work.png", filePath: "/private/history-work.png",
      mimeType: "image/png", sizeBytes: 1024, width: 800, height: 600, durationMs: null, warnings: [],
      uploadedByUserId: owner.id, uploadedAt: "2026-08-05T07:30:00.000Z", cleanedAt: null, cleanupReason: ""
    },
    {
      id: "SA-TEMPORARY", registrationId: null, uploadSessionId: "US-TEMPORARY", kind: "creation_video",
      originalName: "unfinished.mp4", storedName: "unfinished.mp4", filePath: "/private/unfinished.mp4",
      mimeType: "video/mp4", sizeBytes: 2048, width: null, height: null, durationMs: 1000, warnings: [],
      uploadedByUserId: owner.id, uploadedAt: "2026-08-05T07:30:00.000Z", cleanedAt: null, cleanupReason: ""
    }
  );
  db.certificateImportBatches.push({
    id: "B-OWNER-HISTORY", eventId: registration.eventId, createdBy: owner.id,
    originalName: "history.xlsx", status: "committed", previewJson: [], validCount: 1, errorCount: 0,
    replaceCount: 0, createdAt: "2026-08-05T08:00:00.000Z", committedAt: "2026-08-05T08:05:00.000Z"
  });
  db.auditLogs.push({
    id: "AUDIT-OWNER-HISTORY", actorUserId: owner.id, actorName: owner.name,
    action: "registration.create", targetType: "registration", targetId: registration.id,
    summary: "历史操作", createdAt: "2026-08-05T08:00:00.000Z"
  });
  return { db, organization, owner, member, registration };
}

test("delete organization account retains registration, result, certificate, and ordinary member history", () => {
  const { db, organization, owner, member, registration } = lifecycleFixture();
  const actor = db.users.find((row) => row.type === "admin");

  const result = deleteOrganizationAccount(db, {
    organizationId: organization.id,
    actor,
    makeId: (prefix) => `${prefix}-DELETE-1`,
    now: () => deletedAt
  });

  assert.deepEqual(result, {
    ownerUserId: owner.id,
    organizationName: organization.name,
    retainedRegistrationCount: 2,
    queuedFileCount: 2
  });
  assert.equal(db.users.some((row) => row.id === owner.id), false);
  assert.equal(db.users.some((row) => row.id === member.id), true);
  assert.equal(db.organizations.some((row) => row.id === organization.id), false);
  assert.equal(db.memberships.some((row) => row.organizationId === organization.id), false);
  assert.equal(db.organizationEventParticipations.some((row) => row.organizationId === organization.id), false);
  assert.equal(db.organizationDocuments.some((row) => row.organizationId === organization.id), false);

  const retained = db.registrations.find((row) => row.id === registration.id);
  assert.equal(retained.organizationId, null);
  assert.equal(retained.createdByUserId, null);
  assert.equal(retained.organization, organization.name);
  assert.equal(retained.organizationDeleted, true);
  assert.equal(retained.awardName, "一等奖");
  assert.ok(db.certificates.some((row) => row.registrationId === registration.id));
  assert.deepEqual(db.fileCleanupJournal.map(({ filePath, category }) => ({ filePath, category })).sort((a, b) => a.filePath.localeCompare(b.filePath)), [
    { filePath: "/private/license.pdf", category: "organization-deleted" },
    { filePath: "/private/unfinished.mp4", category: "organization-deleted" }
  ]);
  assert.deepEqual(db.registrationUploadSessions.map((row) => ({ id: row.id, ownerUserId: row.ownerUserId, organizationId: row.organizationId })), [
    { id: "US-COMMITTED", ownerUserId: null, organizationId: null }
  ]);
  assert.deepEqual(db.registrationSubmissionAssets.map((row) => ({ id: row.id, registrationId: row.registrationId, uploadedByUserId: row.uploadedByUserId })), [
    { id: "SA-COMMITTED", registrationId: registration.id, uploadedByUserId: null }
  ]);
  assert.equal(db.certificateImportBatches.find((row) => row.id === "B-OWNER-HISTORY").createdBy, null);
  assert.equal(db.auditLogs.find((row) => row.id === "AUDIT-OWNER-HISTORY").actorUserId, null);
  const audit = db.auditLogs.find((row) => row.action === "organization.delete");
  assert.ok(audit);
  assert.equal(audit.actorUserId, actor.id);
  assert.match(audit.summary, /历史|报名|保留/);
  assert.doesNotMatch(JSON.stringify(audit), /admin123|password|temporaryPassword/i);
});

test("organization history labels require an explicit deletion tombstone", () => {
  assert.deepEqual(organizationHistoryFields({ organizationId: null, organization: "手工解除关联的组织" }), {
    organizationSnapshot: "手工解除关联的组织",
    organizationDeleted: false,
    organization: "手工解除关联的组织"
  });
  assert.deepEqual(organizationHistoryFields({ organizationId: null, organization: "已删除组织", organizationDeleted: true }), {
    organizationSnapshot: "已删除组织",
    organizationDeleted: true,
    organization: "已删除组织（原组织已删除）"
  });
});

test("delete organization account endpoint is platform-admin only and persists atomically", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    assert.equal((await fetch(`${baseUrl}/api/admin/organizations/O1001`, withSession(ordinary.cookie, { method: "DELETE" }))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/admin/organizations/O1001`, withSession(owner.cookie, { method: "DELETE" }))).status, 403);

    const before = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const credentialPath = path.join(tempDir, "uploads", "organization-documents", "O1001", "license.pdf");
    await fs.mkdir(path.dirname(credentialPath), { recursive: true });
    await fs.writeFile(credentialPath, "credential", "utf8");
    before.organizationDocuments.push({ id: "OD-DELETE", organizationId: "O1001", documentType: "business_license", originalName: "license.pdf", storedName: "license.pdf", filePath: credentialPath, mimeType: "application/pdf", sizeBytes: 100, uploadedAt: deletedAt, cleanedAt: null });
    before.organizations.find((row) => row.id === "O1001").currentDocumentId = "OD-DELETE";
    const retainedRegistration = before.registrations.find((row) => row.id === "R20260627001");
    const committedPath = path.join(tempDir, "uploads", "submission-assets", "SA-ROUTE-COMMITTED", "work.png");
    const temporaryPath = path.join(tempDir, "uploads", "submission-assets", "SA-ROUTE-TEMPORARY", "unfinished.mp4");
    await fs.mkdir(path.dirname(committedPath), { recursive: true });
    await fs.mkdir(path.dirname(temporaryPath), { recursive: true });
    await fs.writeFile(committedPath, "committed-work", "utf8");
    await fs.writeFile(temporaryPath, "temporary-work", "utf8");
    before.registrationUploadSessions.push(
      { id: "US-ROUTE-COMMITTED", eventId: retainedRegistration.eventId, projectId: retainedRegistration.projectId, ownerUserId: "U2001", organizationId: "O1001", channel: "organization", state: "committed", createdAt: deletedAt, expiresAt: deletedAt, committedAt: deletedAt },
      { id: "US-ROUTE-TEMPORARY", eventId: retainedRegistration.eventId, projectId: retainedRegistration.projectId, ownerUserId: "U2001", organizationId: "O1001", channel: "organization", state: "active", createdAt: deletedAt, expiresAt: deletedAt, committedAt: null }
    );
    before.registrationSubmissionAssets.push(
      { id: "SA-ROUTE-COMMITTED", registrationId: retainedRegistration.id, uploadSessionId: "US-ROUTE-COMMITTED", kind: "artwork_image", originalName: "work.png", storedName: "work.png", filePath: committedPath, mimeType: "image/png", sizeBytes: 14, width: 800, height: 600, durationMs: null, warnings: [], uploadedByUserId: "U2001", uploadedAt: deletedAt, cleanedAt: null, cleanupReason: "" },
      { id: "SA-ROUTE-TEMPORARY", registrationId: null, uploadSessionId: "US-ROUTE-TEMPORARY", kind: "creation_video", originalName: "unfinished.mp4", storedName: "unfinished.mp4", filePath: temporaryPath, mimeType: "video/mp4", sizeBytes: 14, width: null, height: null, durationMs: 1000, warnings: [], uploadedByUserId: "U2001", uploadedAt: deletedAt, cleanedAt: null, cleanupReason: "" }
    );
    await fs.writeFile(dbPath, JSON.stringify(before), "utf8");

    const response = await fetch(`${baseUrl}/api/admin/organizations/O1001`, withSession(admin.cookie, { method: "DELETE" }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.ownerUserId, "U2001");
    assert.equal(payload.retainedRegistrationCount, 1);
    assert.equal(payload.queuedFileCount, 2);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.organizations.some((row) => row.id === "O1001"), false);
    assert.equal(persisted.users.some((row) => row.id === "U2001"), false);
    assert.equal(persisted.users.some((row) => row.id === "U1001"), true);
    const retained = persisted.registrations.find((row) => row.id === "R20260627001");
    assert.equal(retained.organizationId, null);
    assert.equal(Object.hasOwn(retained, "createdByUserId"), true);
    assert.equal(persisted.fileCleanupJournal.some((row) => row.category === "organization-deleted"), false);
    await assert.rejects(fs.access(credentialPath), { code: "ENOENT" });
    await assert.rejects(fs.access(temporaryPath), { code: "ENOENT" });
    assert.equal(persisted.registrationSubmissionAssets.some((row) => row.id === "SA-ROUTE-TEMPORARY"), false);
    assert.ok(persisted.registrationSubmissionAssets.some((row) => row.id === "SA-ROUTE-COMMITTED"));
    await fs.access(committedPath);

    const assetList = await fetch(`${baseUrl}/api/admin/events/${retained.eventId}/submission-assets`, withSession(admin.cookie));
    assert.equal(assetList.status, 200);
    assert.ok((await assetList.json()).rows.some((row) => row.id === "SA-ROUTE-COMMITTED"));
    const assetResponse = await fetch(`${baseUrl}/api/admin/events/${retained.eventId}/registrations/${retained.id}/assets/artwork_image`, withSession(admin.cookie));
    assert.equal(assetResponse.status, 200);
    assert.equal(await assetResponse.text(), "committed-work");
  }, { prefix: "organization-account-delete-route-" });
});

test("organization account lifecycle round-trips retained history through PostgreSQL", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const store = createPostgresStore(new Pool());
  try {
    await store.initialize();
    const initial = await store.readDb();
    const { db, organization, owner, member, registration } = lifecycleFixture();
    // Preserve the initialized site-content rows while installing the focused lifecycle fixture.
    Object.assign(db, {
      siteSettings: initial.siteSettings,
      eventPublicProfiles: initial.eventPublicProfiles,
      contentPosts: initial.contentPosts,
      mediaAssets: initial.mediaAssets,
      contentAttachments: initial.contentAttachments
    });
    await store.writeDb(db);

    await store.withMutationLock(async () => {
      const working = await store.readDb();
      deleteOrganizationAccount(working, {
        organizationId: organization.id,
        actor: working.users.find((row) => row.type === "admin"),
        makeId: (prefix) => `${prefix}-PG-DELETE`,
        now: () => deletedAt
      });
      await store.writeDb(working);
    });

    const persisted = await store.readDb();
    assert.equal(persisted.users.some((row) => row.id === owner.id), false);
    assert.equal(persisted.users.some((row) => row.id === member.id), true);
    assert.equal(persisted.organizations.some((row) => row.id === organization.id), false);
    const retained = persisted.registrations.find((row) => row.id === registration.id);
    assert.equal(retained.organizationId, null);
    assert.equal(retained.createdByUserId, null);
    assert.equal(retained.organization, organization.name);
    assert.equal(retained.organizationDeleted, true);
    assert.equal(retained.awardName, "一等奖");
    assert.ok(persisted.certificates.some((row) => row.registrationId === registration.id));
    assert.ok(persisted.registrationSubmissionAssets.some((row) => row.id === "SA-COMMITTED" && row.uploadedByUserId === null));
    assert.equal(persisted.registrationSubmissionAssets.some((row) => row.id === "SA-TEMPORARY"), false);
    assert.ok(persisted.registrationUploadSessions.some((row) => row.id === "US-COMMITTED" && row.ownerUserId === null && row.organizationId === null));
    assert.equal(persisted.registrationUploadSessions.some((row) => row.id === "US-TEMPORARY"), false);
    assert.equal(persisted.certificateImportBatches.find((row) => row.id === "B-OWNER-HISTORY").createdBy, null);
    assert.equal(persisted.auditLogs.find((row) => row.id === "AUDIT-OWNER-HISTORY").actorUserId, null);
    assert.ok(persisted.fileCleanupJournal.some((row) => row.category === "organization-deleted"));
  } finally {
    await store.close();
  }
});

test("PostgreSQL migration upgrades legacy organization-deletion references without dropping history", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool);
  try {
    await store.initialize();
    await pool.query("ALTER TABLE registrations DROP COLUMN organization_deleted");
    await pool.query("ALTER TABLE certificate_import_batches DROP CONSTRAINT certificate_import_batches_created_by_fkey");
    await pool.query("ALTER TABLE certificate_import_batches ALTER COLUMN created_by SET NOT NULL");
    await pool.query("ALTER TABLE certificate_import_batches ADD CONSTRAINT certificate_import_batches_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id)");
    await pool.query("ALTER TABLE registration_upload_sessions DROP CONSTRAINT registration_upload_sessions_owner_user_id_fkey");
    await pool.query("ALTER TABLE registration_upload_sessions ALTER COLUMN owner_user_id SET NOT NULL");
    await pool.query("ALTER TABLE registration_upload_sessions ADD CONSTRAINT registration_upload_sessions_owner_user_id_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE");
    await pool.query("ALTER TABLE registration_upload_sessions DROP CONSTRAINT registration_upload_sessions_organization_id_fkey");
    await pool.query("ALTER TABLE registration_upload_sessions ADD CONSTRAINT registration_upload_sessions_organization_id_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE");
    await pool.query("ALTER TABLE registration_submission_assets DROP CONSTRAINT registration_submission_assets_uploaded_by_user_id_fkey");
    await pool.query("ALTER TABLE registration_submission_assets ALTER COLUMN uploaded_by_user_id SET NOT NULL");
    await pool.query("ALTER TABLE registration_submission_assets ADD CONSTRAINT registration_submission_assets_uploaded_by_user_id_fk FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)");
    await pool.query("DELETE FROM schema_migrations WHERE name = '014-organization-deletion-history.sql'");

    await store.initialize();

    const tombstoneColumn = await pool.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'registrations' AND column_name = 'organization_deleted'
    `);
    assert.equal(tombstoneColumn.rowCount, 1);
    await pool.query(`
      INSERT INTO certificate_import_batches
        (id, event_id, created_by, original_name, status, preview_json, created_at)
      SELECT 'B-UPGRADED-NULL-OWNER', id, NULL, 'history.xlsx', 'committed', '[]'::jsonb, NOW()
      FROM events LIMIT 1
    `);
    await pool.query(`
      INSERT INTO registration_upload_sessions
        (id, event_id, project_id, owner_user_id, organization_id, channel, state, created_at, expires_at)
      SELECT 'US-UPGRADED-NULL-OWNER', event_id, id, NULL, NULL, 'organization', 'committed', NOW(), NOW()
      FROM projects LIMIT 1
    `);
    await pool.query(`
      INSERT INTO registration_submission_assets
        (id, registration_id, upload_session_id, kind, original_name, stored_name, file_path, mime_type,
         size_bytes, warnings, uploaded_by_user_id, uploaded_at)
      VALUES
        ('SA-UPGRADED-NULL-OWNER', NULL, 'US-UPGRADED-NULL-OWNER', 'artwork_image', 'history.png',
         'history.png', '/private/history.png', 'image/png', 100, '[]'::jsonb, NULL, NOW())
    `);
    assert.equal((await pool.query("SELECT 1 FROM certificate_import_batches WHERE id = 'B-UPGRADED-NULL-OWNER' AND created_by IS NULL")).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM registration_upload_sessions WHERE id = 'US-UPGRADED-NULL-OWNER' AND owner_user_id IS NULL")).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM registration_submission_assets WHERE id = 'SA-UPGRADED-NULL-OWNER' AND uploaded_by_user_id IS NULL")).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name = '014-organization-deletion-history.sql'")).rowCount, 1);
  } finally {
    await store.close();
  }
});

test("delete organization account leaves persisted data unchanged when its atomic write fails", async () => {
  const { db, organization, owner, registration } = lifecycleFixture();
  const persisted = structuredClone(db);
  const before = structuredClone(persisted);
  const store = {
    readDb: async () => structuredClone(persisted),
    writeDb: async () => { throw new Error("simulated database failure"); },
    withMutationLock: async (handler) => handler()
  };
  const app = express();
  app.use(express.json());
  app.use("/api", createOrganizationsRouter({
    store,
    requireUser: (_req, _res, next) => next(),
    requireAdmin: (req, _res, next) => {
      req.user = persisted.users.find((row) => row.type === "admin");
      next();
    },
    requirePasswordReady: (_req, _res, next) => next(),
    asyncRoute: createMutationAsyncRoute(store),
    hashPassword: async (value) => value,
    validatePassword: () => {},
    verifyPhoneRegistration: async () => true,
    makeId: (prefix) => `${prefix}-WRITE-FAILURE`,
    now: () => deletedAt,
    publicUser: (user) => user
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/organizations/${organization.id}`, { method: "DELETE" });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /simulated database failure/);
    assert.deepEqual(persisted, before);
    assert.ok(persisted.users.some((row) => row.id === owner.id));
    assert.ok(persisted.organizations.some((row) => row.id === organization.id));
    assert.ok(persisted.memberships.some((row) => row.organizationId === organization.id));
    const unchanged = persisted.registrations.find((row) => row.id === registration.id);
    assert.equal(unchanged.organizationId, organization.id);
    assert.equal(unchanged.createdByUserId, owner.id);
    assert.equal(persisted.fileCleanupJournal.some((row) => row.category === "organization-deleted"), false);
    assert.equal(persisted.auditLogs.some((row) => row.action === "organization.delete"), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("organization deletion cascades leader data and retains a cleanup marker while another leader references the same file", async () => {
  const { db, organization } = lifecycleFixture();
  const actor = db.users.find((row) => row.type === "admin");
  const now = "2026-08-07T09:00:00.000Z";
  db.organizationLeaders.push(
    {
      id: "leader-deleted", organizationId: organization.id, name: "待删领队", phone: "13800009555",
      email: "", notes: "", currentDocumentId: "leader-document-shared", reviewStatus: "approved",
      rejectionReason: "", enabled: true, submissionVersion: 1, reviewedBy: actor.id, reviewedAt: now,
      createdAt: now, updatedAt: now
    },
    {
      id: "leader-retained", organizationId: "O1002", name: "保留领队", phone: "13800009666",
      email: "", notes: "", currentDocumentId: "leader-document-retained", reviewStatus: "approved",
      rejectionReason: "", enabled: true, submissionVersion: 1, reviewedBy: actor.id, reviewedAt: now,
      createdAt: now, updatedAt: now
    }
  );
  db.organizationLeaderDocuments.push(
    {
      id: "leader-document-deleted", leaderId: "leader-deleted", version: 1,
      originalName: "deleted.pdf", storedName: "deleted.pdf", filePath: "/private/deleted-leader.pdf",
      mimeType: "application/pdf", sizeBytes: 100, uploadedAt: now, cleanedAt: null
    },
    {
      id: "leader-document-shared", leaderId: "leader-deleted", version: 2,
      originalName: "shared.pdf", storedName: "shared.pdf", filePath: "/private/shared-leader.pdf",
      mimeType: "application/pdf", sizeBytes: 100, uploadedAt: now, cleanedAt: null
    },
    {
      id: "leader-document-retained", leaderId: "leader-retained", version: 1,
      originalName: "shared.pdf", storedName: "shared.pdf", filePath: "/private/shared-leader.pdf",
      mimeType: "application/pdf", sizeBytes: 100, uploadedAt: now, cleanedAt: null
    }
  );
  db.organizationLeaderReviews.push({
    id: "leader-review-deleted", leaderId: "leader-deleted", organizationId: organization.id,
    submissionVersion: 1, action: "approved", actorId: actor.id, reason: "", snapshot: {},
    documentId: "leader-document-shared", createdAt: now
  });

  deleteOrganizationAccount(db, {
    organizationId: organization.id,
    actor,
    makeId: (prefix) => `${prefix}-${db.fileCleanupJournal.length + 1}`,
    now: () => now
  });

  assert.equal(db.organizationLeaders.some((row) => row.id === "leader-deleted"), false);
  assert.equal(db.organizationLeaderDocuments.some((row) => row.leaderId === "leader-deleted"), false);
  assert.equal(db.organizationLeaderReviews.some((row) => row.leaderId === "leader-deleted"), false);
  assert.ok(db.organizationLeaders.some((row) => row.id === "leader-retained"));
  const sharedMarker = db.fileCleanupJournal.find((row) => row.filePath === "/private/shared-leader.pdf");
  assert.ok(sharedMarker);
  assert.ok(db.fileCleanupJournal.some((row) => row.filePath === "/private/deleted-leader.pdf"));

  const removed = [];
  const store = {
    readDb: async () => db,
    writeDb: async () => {},
    withMutationLock: async (handler) => handler()
  };
  const replay = await replayFileCleanupJournal({
    store,
    markerIds: [sharedMarker.id],
    removePrivateFile: async (marker) => { removed.push(marker.filePath); }
  });
  assert.deepEqual(replay, { removed: 0, retained: 1 });
  assert.deepEqual(removed, []);
  assert.ok(db.fileCleanupJournal.some((row) => row.id === sharedMarker.id));
});
