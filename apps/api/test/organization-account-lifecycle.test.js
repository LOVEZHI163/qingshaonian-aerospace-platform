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
import { deleteOrganizationAccount } from "../src/services/organization-account-lifecycle.js";
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
    queuedFileCount: 1
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
  assert.equal(retained.awardName, "一等奖");
  assert.ok(db.certificates.some((row) => row.registrationId === registration.id));
  assert.deepEqual(db.fileCleanupJournal.map(({ filePath, category }) => ({ filePath, category })), [
    { filePath: "/private/license.pdf", category: "organization-deleted" }
  ]);
  const audit = db.auditLogs.find((row) => row.action === "organization.delete");
  assert.ok(audit);
  assert.equal(audit.actorUserId, actor.id);
  assert.match(audit.summary, /历史|报名|保留/);
  assert.doesNotMatch(JSON.stringify(audit), /admin123|password|temporaryPassword/i);
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
    await fs.writeFile(dbPath, JSON.stringify(before), "utf8");

    const response = await fetch(`${baseUrl}/api/admin/organizations/O1001`, withSession(admin.cookie, { method: "DELETE" }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.ownerUserId, "U2001");
    assert.equal(payload.retainedRegistrationCount, 1);
    assert.equal(payload.queuedFileCount, 1);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.organizations.some((row) => row.id === "O1001"), false);
    assert.equal(persisted.users.some((row) => row.id === "U2001"), false);
    assert.equal(persisted.users.some((row) => row.id === "U1001"), true);
    const retained = persisted.registrations.find((row) => row.id === "R20260627001");
    assert.equal(retained.organizationId, null);
    assert.equal(Object.hasOwn(retained, "createdByUserId"), true);
    assert.equal(persisted.fileCleanupJournal.some((row) => row.category === "organization-deleted"), false);
    await assert.rejects(fs.access(credentialPath), { code: "ENOENT" });
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
    assert.equal(retained.awardName, "一等奖");
    assert.ok(persisted.certificates.some((row) => row.registrationId === registration.id));
    assert.ok(persisted.fileCleanupJournal.some((row) => row.category === "organization-deleted"));
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
