import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";
import { createPostgresStore } from "../src/data/postgres-store.js";
import { cleanupArchivedEventResources, deleteArchivedEvent } from "../src/services/resource-cleanup.js";

function jsonRequest(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function json(response) {
  const body = await response.json();
  assert.equal(response.ok, true, body.error || `request failed with ${response.status}`);
  return body;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeFixture(dbPath, tempDir) {
  const uploadRoot = path.join(tempDir, "uploads");
  const paths = {
    targetCertificate: path.join(uploadRoot, "certificates", "old.png"),
    otherCertificate: path.join(uploadRoot, "certificates", "other.png"),
    targetImport: path.join(uploadRoot, "import-staging", "B-OLD", "7-1.png"),
    targetSubmission: path.join(uploadRoot, "submission-assets", "SA-OLD", "work.png"),
    credential: path.join(uploadRoot, "organization-credentials", "O1002", "license.pdf")
  };
  await Promise.all(Object.values(paths).map((filePath) => fs.mkdir(path.dirname(filePath), { recursive: true })));
  await Promise.all([
    fs.writeFile(paths.targetCertificate, Buffer.alloc(11)),
    fs.writeFile(paths.otherCertificate, Buffer.alloc(13)),
    fs.writeFile(paths.targetImport, Buffer.alloc(17)),
    fs.writeFile(paths.targetSubmission, Buffer.alloc(23)),
    fs.writeFile(paths.credential, Buffer.alloc(19))
  ]);

  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  db.events.push(
    { id: "E-OLD", name: "2025 航空赛", status: "archived", isCurrent: false, archivedAt: "2026-01-01T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "E-OTHER", name: "2024 航空赛", status: "published", isCurrent: false, archivedAt: null, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" }
  );
  db.projects.push(
    { id: "P-OLD", eventId: "E-OLD", name: "旧赛项", allowedGroups: ["小学低段"] },
    { id: "P-OTHER", eventId: "E-OTHER", name: "其他赛项", allowedGroups: ["小学低段"] }
  );
  db.projectGroups.push(
    { projectId: "P-OLD", groupName: "小学低段" },
    { projectId: "P-OTHER", groupName: "小学低段" }
  );
  db.organizationEventParticipations.push(
    { organizationId: "O1002", eventId: "E-OLD", joinedByUserId: "U2002", joinedAt: "2026-01-01T00:00:00.000Z" },
    { organizationId: "O1002", eventId: "E-OTHER", joinedByUserId: "U2002", joinedAt: "2026-01-01T00:00:00.000Z" }
  );
  db.registrations.push(
    { id: "R-OLD", eventId: "E-OLD", projectId: "P-OLD", userId: "U1001", organizationId: "O1002", athlete: { name: "旧赛事选手" } },
    { id: "R-OTHER", eventId: "E-OTHER", projectId: "P-OTHER", userId: "U1001", organizationId: "O1002", athlete: { name: "其他赛事选手" } }
  );
  db.registrationIdentities.push(
    { registrationId: "R-OLD", ciphertext: "old-ciphertext", iv: "old-iv", authTag: "old-tag", keyVersion: 1, idFingerprint: "old-fingerprint", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { registrationId: "R-OTHER", ciphertext: "other-ciphertext", iv: "other-iv", authTag: "other-tag", keyVersion: 1, idFingerprint: "other-fingerprint", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
  );
  db.registrationParticipants.push(
    { id: "RP-OLD", registrationId: "R-OLD", displayOrder: 1, name: "旧赛事团队选手", school: "旧学校", grade: "三年级", phone: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "RP-OTHER", registrationId: "R-OTHER", displayOrder: 1, name: "其他赛事团队选手", school: "其他学校", grade: "三年级", phone: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
  );
  db.registrationParticipantIdentities.push(
    { participantId: "RP-OLD", ciphertext: "old-participant-ciphertext", iv: "old-participant-iv", authTag: "old-participant-tag", keyVersion: 1, idFingerprint: "old-participant-fingerprint", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { participantId: "RP-OTHER", ciphertext: "other-participant-ciphertext", iv: "other-participant-iv", authTag: "other-participant-tag", keyVersion: 1, idFingerprint: "other-participant-fingerprint", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
  );
  db.certificates.push(
    { id: "C-OLD", registrationId: "R-OLD", slot: 1, title: "旧赛事证书", fileName: "old.png", storedName: "old.png", filePath: paths.targetCertificate, status: "draft", source: "manual", importBatchId: null, uploadedAt: "2026-01-01T00:00:00.000Z", publishedAt: "", cleanedAt: "" },
    { id: "C-OLD-MISSING", registrationId: "R-OLD", slot: 2, title: "缺失的旧赛事证书", fileName: "missing.png", storedName: "", filePath: "", status: "draft", source: "manual", importBatchId: null, uploadedAt: "2026-01-01T00:00:00.000Z", publishedAt: "", cleanedAt: "" },
    { id: "C-OTHER", registrationId: "R-OTHER", slot: 1, title: "其他赛事证书", fileName: "other.png", storedName: "other.png", filePath: paths.otherCertificate, status: "draft", source: "manual", importBatchId: null, uploadedAt: "2026-01-01T00:00:00.000Z", publishedAt: "", cleanedAt: "" }
  );
  db.certificateImportBatches.push({
    id: "B-OLD", eventId: "E-OLD", createdBy: "U9001", originalName: "old.xlsx", status: "preview",
    previewJson: [{ rowNumber: 7, certificates: [{ slot: 1, relativePath: "7-1.png" }] }],
    validCount: 1, errorCount: 0, replaceCount: 0, createdAt: "2026-01-01T00:00:00.000Z", committedAt: null
  });
  db.registrationUploadSessions.push({
    id: "US-OLD", eventId: "E-OLD", projectId: "P-OLD", ownerUserId: "U1001", organizationId: null,
    state: "committed", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z", committedAt: "2026-01-01T00:00:00.000Z"
  });
  db.registrationSubmissionAssets.push({
    id: "SA-OLD", registrationId: "R-OLD", uploadSessionId: "US-OLD", kind: "artwork_image", originalName: "work.png",
    storedName: "work.png", filePath: paths.targetSubmission, mimeType: "image/png", sizeBytes: 23, width: 1, height: 1,
    durationMs: null, uploadedByUserId: "U1001", uploadedAt: "2026-01-01T00:00:00.000Z", cleanedAt: null, cleanupReason: ""
  });
  db.organizationDocuments.push({
    id: "DOC-CLEANUP", organizationId: "O1002", documentType: "business_license", originalName: "license.pdf",
    storedName: "license.pdf", filePath: paths.credential, mimeType: "application/pdf", sizeBytes: 19,
    uploadedAt: "2026-01-01T00:00:00.000Z", cleanedAt: null
  }, {
    id: "DOC-MISSING", organizationId: "O1002", documentType: "business_license", originalName: "missing.pdf",
    storedName: "", filePath: "", mimeType: "application/pdf", sizeBytes: 0,
    uploadedAt: "2025-01-01T00:00:00.000Z", cleanedAt: null
  });
  const organization = db.organizations.find((row) => row.id === "O1002");
  organization.currentDocumentId = "DOC-CLEANUP";
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
  return { paths, before: { users: db.users.length, organizations: db.organizations.length, memberships: db.memberships.length } };
}

test("resource cleanup summarizes and cleans only archived event attachments", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const fixture = await writeFixture(dbPath, tempDir);

    const storage = await json(await fetch(`${baseUrl}/api/admin/events/E-OLD/storage`, withSession(admin.cookie)));
    assert.deepEqual(storage, { certificateFiles: 1, importFiles: 1, totalBytes: 28 });

    const cleanup = await json(await fetch(`${baseUrl}/api/admin/events/E-OLD/cleanup`, jsonRequest("POST", {
      categories: ["certificates", "imports"]
    }, admin.cookie)));
    assert.deepEqual({ certificateFiles: cleanup.certificateFiles, importFiles: cleanup.importFiles, totalBytes: cleanup.totalBytes, deletedFiles: cleanup.deletedFiles }, {
      certificateFiles: 1, importFiles: 1, totalBytes: 28, deletedFiles: 2
    });
    assert.deepEqual(cleanup.failedFiles, []);
    assert.equal(await exists(fixture.paths.targetCertificate), false);
    assert.equal(await exists(fixture.paths.targetImport), false);
    assert.equal(await exists(fixture.paths.targetSubmission), true);
    assert.equal(await exists(fixture.paths.otherCertificate), true);
    assert.equal(await exists(fixture.paths.credential), true);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const cleaned = persisted.certificates.find((row) => row.id === "C-OLD");
    assert.ok(cleaned.cleanedAt);
    assert.equal(cleaned.filePath, "");
    assert.equal(cleaned.storedName, "");
    assert.ok(persisted.certificates.find((row) => row.id === "C-OLD-MISSING").cleanedAt);
    assert.ok(persisted.certificates.some((row) => row.id === "C-OTHER" && !row.cleanedAt));
    assert.deepEqual(persisted.certificateImportBatches.find((row) => row.id === "B-OLD").previewJson, []);
    assert.ok(persisted.auditLogs.some((row) => row.action === "event.resource-cleanup" && row.targetId === "E-OLD"));

    const unarchived = await fetch(`${baseUrl}/api/admin/events/E-OTHER/cleanup`, jsonRequest("POST", { categories: ["certificates"] }, admin.cookie));
    assert.equal(unarchived.status, 409);
  }, { prefix: "resource-cleanup-event-" });
});

test("resource cleanup requires disabled organization and exact name before cleaning credentials", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const fixture = await writeFixture(dbPath, tempDir);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const organization = db.organizations.find((row) => row.id === "O1002");

    const active = await fetch(`${baseUrl}/api/admin/organizations/O1002/credential-cleanup`, jsonRequest("POST", { confirmName: organization.name }, admin.cookie));
    assert.equal(active.status, 409);

    organization.status = "disabled";
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
    const wrongName = await fetch(`${baseUrl}/api/admin/organizations/O1002/credential-cleanup`, jsonRequest("POST", { confirmName: "错误名称" }, admin.cookie));
    assert.equal(wrongName.status, 422);

    const cleanup = await json(await fetch(`${baseUrl}/api/admin/organizations/O1002/credential-cleanup`, jsonRequest("POST", { confirmName: organization.name }, admin.cookie)));
    assert.equal(cleanup.deletedFiles, 1);
    assert.deepEqual(cleanup.failedFiles, []);
    assert.equal(await exists(fixture.paths.credential), false);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const cleanedDocument = persisted.organizationDocuments.find((row) => row.id === "DOC-CLEANUP");
    assert.ok(cleanedDocument.cleanedAt);
    assert.equal(cleanedDocument.filePath, "");
    assert.equal(cleanedDocument.storedName, "");
    assert.ok(persisted.organizationDocuments.find((row) => row.id === "DOC-MISSING").cleanedAt);
    assert.equal(persisted.organizations.find((row) => row.id === "O1002").currentDocumentId, null);
    assert.equal(persisted.organizations.length, fixture.before.organizations);
    assert.equal(persisted.users.length, fixture.before.users);
    assert.equal(persisted.memberships.length, fixture.before.memberships);
    assert.ok(persisted.auditLogs.some((row) => row.action === "organization.credential-cleanup" && row.targetId === "O1002"));
  }, { prefix: "resource-cleanup-organization-" });
});

test("resource cleanup rejects an archived event that is still current without changing data or files", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const fixture = await writeFixture(dbPath, tempDir);
    const before = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const targetEvent = before.events.find((row) => row.id === "E-OLD");
    targetEvent.isCurrent = true;
    await fs.writeFile(dbPath, JSON.stringify(before, null, 2), "utf8");
    const expectedSnapshot = structuredClone(before);

    const response = await fetch(`${baseUrl}/api/admin/events/E-OLD/cleanup`, jsonRequest("POST", {
      categories: ["certificates", "imports"]
    }, admin.cookie));
    assert.equal(response.status, 409);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.deepEqual(persisted, expectedSnapshot);
    assert.deepEqual(persisted.fileCleanupJournal, expectedSnapshot.fileCleanupJournal);
    assert.deepEqual(persisted.auditLogs, expectedSnapshot.auditLogs);
    assert.deepEqual(
      persisted.certificates.filter((row) => ["C-OLD", "C-OLD-MISSING"].includes(row.id)),
      expectedSnapshot.certificates.filter((row) => ["C-OLD", "C-OLD-MISSING"].includes(row.id))
    );
    assert.deepEqual(
      persisted.certificateImportBatches.find((row) => row.id === "B-OLD"),
      expectedSnapshot.certificateImportBatches.find((row) => row.id === "B-OLD")
    );
    assert.equal(await exists(fixture.paths.targetCertificate), true);
    assert.equal(await exists(fixture.paths.targetImport), true);
    assert.equal(await exists(fixture.paths.otherCertificate), true);
    assert.equal(await exists(fixture.paths.credential), true);
  }, { prefix: "resource-cleanup-current-archived-" });
});

test("resource cleanup thoroughly deletes only a confirmed non-current archived event", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const fixture = await writeFixture(dbPath, tempDir);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.eventPublicProfiles.push({
      eventId: "E-OLD", slug: "old-event", slogan: "旧赛事", summary: "归档赛事资料",
      isVisible: true, displayOrder: 0, heroMediaId: null, version: 1, updatedAt: "2026-01-01T00:00:00.000Z"
    });
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const wrongName = await fetch(`${baseUrl}/api/admin/events/E-OLD`, jsonRequest("DELETE", { confirmName: "错误名称" }, admin.cookie));
    assert.equal(wrongName.status, 422);
    const current = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, jsonRequest("DELETE", { confirmName: "2026年温州市青少年航空航天创新比赛" }, admin.cookie));
    assert.equal(current.status, 409);

    const deleted = await json(await fetch(`${baseUrl}/api/admin/events/E-OLD`, jsonRequest("DELETE", { confirmName: "2025 航空赛" }, admin.cookie)));
    assert.equal(deleted.deletedEventId, "E-OLD");
    assert.deepEqual(deleted.failedFiles, []);
    assert.equal(await exists(fixture.paths.targetCertificate), false);
    assert.equal(await exists(fixture.paths.targetImport), false);
    assert.equal(await exists(fixture.paths.targetSubmission), false);
    assert.equal(await exists(fixture.paths.otherCertificate), true);
    assert.equal(await exists(fixture.paths.credential), true);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.events.some((row) => row.id === "E-OLD"), false);
    assert.equal(persisted.eventPublicProfiles.some((row) => row.eventId === "E-OLD"), false);
    assert.equal(persisted.projects.some((row) => row.eventId === "E-OLD"), false);
    assert.equal(persisted.projectGroups.some((row) => row.projectId === "P-OLD"), false);
    assert.equal(persisted.organizationEventParticipations.some((row) => row.eventId === "E-OLD"), false);
    assert.equal(persisted.organizationEventParticipations.some((row) => row.eventId === "E-OTHER"), true);
    assert.equal(persisted.registrations.some((row) => row.eventId === "E-OLD"), false);
    assert.equal(persisted.registrationIdentities.some((row) => row.registrationId === "R-OLD"), false);
    assert.equal(persisted.registrationIdentities.some((row) => row.registrationId === "R-OTHER"), true);
    assert.equal(persisted.registrationParticipants.some((row) => row.registrationId === "R-OLD"), false);
    assert.equal(persisted.registrationParticipants.some((row) => row.registrationId === "R-OTHER"), true);
    assert.equal(persisted.registrationParticipantIdentities.some((row) => row.participantId === "RP-OLD"), false);
    assert.equal(persisted.registrationParticipantIdentities.some((row) => row.participantId === "RP-OTHER"), true);
    assert.equal(persisted.certificates.some((row) => row.id === "C-OLD"), false);
    assert.equal(persisted.certificateImportBatches.some((row) => row.eventId === "E-OLD"), false);
    assert.equal(persisted.registrationUploadSessions.some((row) => row.eventId === "E-OLD"), false);
    assert.equal(persisted.registrationSubmissionAssets.some((row) => row.id === "SA-OLD"), false);
    assert.equal(persisted.users.length, fixture.before.users);
    assert.equal(persisted.organizations.length, fixture.before.organizations);
    assert.equal(persisted.memberships.length, fixture.before.memberships);
    assert.ok(persisted.auditLogs.some((row) => row.action === "event.delete" && row.targetId === "E-OLD"));
  }, { prefix: "resource-cleanup-delete-" });
});

test("resource cleanup deletes a team registration through PostgreSQL without foreign-key failures", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool, { testOnlyPgMemCompatibility: true });
  const now = "2026-09-01T12:00:00.000Z";

  try {
    await store.initialize();
    const db = await store.readDb();
    const sourceEvent = db.events[0];
    const sourceProject = db.projects.find((row) => row.eventId === sourceEvent.id);
    const sourceRegistration = db.registrations[0];
    const eventId = "E-PG-TEAM-CLEANUP";
    const projectId = "P-PG-TEAM-CLEANUP";
    const registrationId = "R-PG-TEAM-CLEANUP";
    const participantId = "RP-PG-TEAM-CLEANUP";
    const eventName = "PostgreSQL 团队清理回归赛事";

    db.events.push({
      ...sourceEvent, id: eventId, name: eventName, status: "archived", isCurrent: false,
      archivedAt: now, createdAt: now, updatedAt: now
    });
    db.projects.push({
      ...sourceProject, id: projectId, eventId, name: "PostgreSQL 团队清理赛项", type: "team",
      instructorRequired: true, teamMinMembers: 1, teamMaxMembers: 8
    });
    db.projectGroups.push(...db.projectGroups
      .filter((row) => row.projectId === sourceProject.id)
      .map((row) => ({ ...row, projectId })));
    db.registrations.push({
      ...sourceRegistration, id: registrationId, eventId, projectId,
      projectName: "PostgreSQL 团队清理赛项", projectType: "team", teamCode: "PG-CLEANUP-1",
      createdAt: now, updatedAt: now
    });
    db.registrationIdentities.push({
      registrationId, ciphertext: "registration-ciphertext", iv: "registration-iv",
      authTag: "registration-tag", keyVersion: 1, idFingerprint: "registration-fingerprint",
      createdAt: now, updatedAt: now
    });
    db.registrationParticipants.push({
      id: participantId, registrationId, displayOrder: 1, name: "团队清理队员", school: "测试学校",
      grade: "三年级", phone: "", createdAt: now, updatedAt: now
    });
    db.registrationParticipantIdentities.push({
      participantId, ciphertext: "participant-ciphertext", iv: "participant-iv",
      authTag: "participant-tag", keyVersion: 1, idFingerprint: "participant-fingerprint",
      createdAt: now, updatedAt: now
    });
    await store.writeDb(db);

    const result = await deleteArchivedEvent({
      store, eventId, confirmName: eventName, actor: { id: "U9001", name: "管理员" },
      makeId: (prefix) => `${prefix}-PG-CLEANUP`, now: () => now, removeFile: async () => {}
    });
    assert.equal(result.deletedEventId, eventId);

    for (const [table, column, id] of [
      ["registration_participant_identities", "participant_id", participantId],
      ["registration_participants", "id", participantId],
      ["registration_identities", "registration_id", registrationId],
      ["registrations", "id", registrationId]
    ]) {
      const rows = await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]);
      assert.equal(rows.rowCount, 0, `${table} retained the deleted event fixture`);
    }
  } finally {
    await store.close();
  }
});

test("resource cleanup journals physical failures, audits them, and retries on the next cleanup", async () => {
  let persisted = {
    events: [{ id: "E1", name: "归档赛事", status: "archived", isCurrent: false }],
    registrations: [{ id: "R1", eventId: "E1" }],
    certificates: [{ id: "C1", registrationId: "R1", fileName: "award.png", storedName: "award.png", filePath: "/data/uploads/certificates/award.png", cleanedAt: "" }],
    certificateImportBatches: [], certificateImportErrors: [], projects: [], projectGroups: [],
    organizations: [], organizationDocuments: [], users: [], memberships: [], fileCleanupJournal: [], auditLogs: []
  };
  const store = {
    readDb: async () => structuredClone(persisted),
    writeDb: async (db) => { persisted = structuredClone(db); }
  };
  let attempts = 0;
  const removeFile = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk is busy");
  };
  let sequence = 0;
  const dependencies = {
    store, eventId: "E1", categories: ["certificates"], actor: { id: "ADMIN", name: "管理员" },
    makeId: (prefix) => `${prefix}${++sequence}`, now: () => "2026-07-18T10:00:00.000Z", removeFile,
    statFile: async () => ({ size: 21 })
  };

  const first = await cleanupArchivedEventResources(dependencies);
  assert.equal(first.deletedFiles, 0);
  assert.equal(first.failedFiles.length, 1);
  assert.equal(persisted.fileCleanupJournal.length, 1);
  assert.equal(persisted.fileCleanupJournal[0].attempts, 1);
  assert.ok(persisted.auditLogs.some((row) => row.action === "event.resource-cleanup-failed"));

  const second = await cleanupArchivedEventResources(dependencies);
  assert.equal(second.deletedFiles, 1);
  assert.deepEqual(second.failedFiles, []);
  assert.deepEqual(persisted.fileCleanupJournal, []);
  assert.equal(attempts, 2);
});
