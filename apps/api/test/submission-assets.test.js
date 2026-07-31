import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import express from "express";

import { createSubmissionAssetsRouter } from "../src/routes/submission-assets.js";
import { cleanupExpiredSubmissionSessions, startSubmissionSessionExpiryCleanup } from "../src/services/submission-assets.js";
import { replayFileCleanupJournal } from "../src/services/organizations.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082", "hex");
const EVENT_ID = "wz-aerospace-2026";
const IMAGE_VIDEO_PROJECT = "rocket-duration";

async function json(response) {
  return response.json();
}

async function configureImageVideoProject(dbPath) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  db.events.find((row) => row.id === EVENT_ID).registrationMode = "force_open";
  db.projects.find((row) => row.id === IMAGE_VIDEO_PROJECT).submissionMode = "image_video";
  await fs.writeFile(dbPath, JSON.stringify(db));
}

function imageForm() {
  const form = new FormData();
  form.set("file", new Blob([PNG], { type: "image/png" }), "work.png");
  return form;
}

async function withRouter(router, fn) {
  const app = express();
  app.use("/api", router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function routeFixture({ asset = null } = {}) {
  return {
    users: [{ id: "U-owner", type: "ordinary", status: "active" }],
    organizations: [],
    organizationEventParticipations: [],
    events: [{ id: "E-upload", status: "published", registrationMode: "force_open", archivedAt: null }],
    projects: [{ id: "P-upload", eventId: "E-upload", enabled: true, submissionMode: "image_video" }],
    registrations: [],
    registrationUploadSessions: [{
      id: "US-upload", eventId: "E-upload", projectId: "P-upload", ownerUserId: "U-owner", organizationId: null,
      state: "active", createdAt: "2026-07-31T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", committedAt: null
    }],
    registrationSubmissionAssets: asset ? [asset] : [],
    fileCleanupJournal: []
  };
}

function assetRecord(uploadRoot, id = "SA-old") {
  const storedName = "old.png";
  return {
    id, registrationId: null, uploadSessionId: "US-upload", kind: "artwork_image", originalName: "old.png", storedName,
    filePath: path.join(uploadRoot, "submission-assets", id, storedName), mimeType: "image/png", sizeBytes: PNG.length,
    width: 1, height: 1, durationMs: null, uploadedByUserId: "U-owner", uploadedAt: "2026-07-31T00:00:00.000Z", cleanedAt: null, cleanupReason: ""
  };
}

function submissionRouter({ db, uploadRoot, deleteFile = async () => {}, storageStatus, assertCapacity, inspectFile, writeDb, logger, makeId = (prefix) => `${prefix}-new` }) {
  const store = {
    readDb: async () => structuredClone(db),
    writeDb: writeDb || (async (next) => { Object.assign(db, structuredClone(next)); })
  };
  const pass = (req, _res, next) => { req.user = { id: "U-owner", type: "ordinary", status: "active" }; next(); };
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  return createSubmissionAssetsRouter({
    store, requireUser: pass, requireAdmin: pass, requirePasswordReady: pass, asyncRoute: wrap,
    makeId, now: () => "2026-07-31T00:00:00.000Z", uploadRoot, deleteFile, storageStatus, assertCapacity, inspectFile, logger
  });
}

test("ordinary users create sessions only for published writable image-video projects", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await configureImageVideoProject(dbPath);
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");

    const created = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/projects/${IMAGE_VIDEO_PROJECT}/upload-sessions`, withSession(ordinary.cookie, { method: "POST" }));
    assert.equal(created.status, 201);
    const payload = await json(created);
    assert.match(payload.row.id, /^US/);
    assert.equal(payload.row.eventId, EVENT_ID);
    assert.equal(payload.row.assets.artwork_image, null);
    assert.equal(Object.hasOwn(payload.row, "filePath"), false);

    const uploaded = await fetch(`${baseUrl}/api/upload-sessions/${payload.row.id}/artwork-image`, withSession(ordinary.cookie, { method: "PUT", body: imageForm() }));
    assert.equal(uploaded.status, 201);
    const uploadedPayload = await json(uploaded);
    assert.equal(uploadedPayload.row.mimeType, "image/png");
    assert.equal(Object.hasOwn(uploadedPayload.row, "filePath"), false);
    assert.equal(Object.hasOwn(uploadedPayload.row, "storedName"), false);
    assert.equal(uploadedPayload.session.assets.artwork_image.originalName, "work.png");
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8")).registrationSubmissionAssets
      .find((asset) => asset.id === uploadedPayload.row.id);
    assert.equal(persisted.filePath, path.join(path.dirname(path.dirname(persisted.filePath)), persisted.id, persisted.storedName));

    const unsupported = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/projects/paper-plane-gate/upload-sessions`, withSession(ordinary.cookie, { method: "POST" }));
    assert.equal(unsupported.status, 422);
  });
});

test("upload session authorization happens before disk upload and rejects expired or committed sessions", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await configureImageVideoProject(dbPath);
    const owner = await loginAs(baseUrl, "13800000001", "123456");
    const second = await fetch(`${baseUrl}/api/auth/register/ordinary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second ordinary", phone: "13800008888", password: "Strong123" })
    });
    assert.equal(second.status, 201);
    const other = await loginAs(baseUrl, "13800008888", "Strong123");
    const created = await json(await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/projects/${IMAGE_VIDEO_PROJECT}/upload-sessions`, withSession(owner.cookie, { method: "POST" })));

    const forbidden = await fetch(`${baseUrl}/api/upload-sessions/${created.row.id}/artwork-image`, withSession(other.cookie, { method: "PUT", body: imageForm() }));
    assert.equal(forbidden.status, 403);

    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const session = db.registrationUploadSessions.find((row) => row.id === created.row.id);
    session.expiresAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(dbPath, JSON.stringify(db));
    const expired = await fetch(`${baseUrl}/api/upload-sessions/${created.row.id}/artwork-image`, withSession(owner.cookie, { method: "PUT", body: imageForm() }));
    assert.equal(expired.status, 409);

    const next = JSON.parse(await fs.readFile(dbPath, "utf8"));
    next.registrationUploadSessions.find((row) => row.id === created.row.id).state = "committed";
    await fs.writeFile(dbPath, JSON.stringify(next));
    const committed = await fetch(`${baseUrl}/api/upload-sessions/${created.row.id}/artwork-image`, withSession(owner.cookie, { method: "PUT", body: imageForm() }));
    assert.equal(committed.status, 409);
  });
});

test("organization upload sessions require the sole approved owner and event participation", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await configureImageVideoProject(dbPath);
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const blocked = await fetch(`${baseUrl}/api/organization/events/${EVENT_ID}/projects/${IMAGE_VIDEO_PROJECT}/upload-sessions`, withSession(owner.cookie, { method: "POST" }));
    assert.equal(blocked.status, 403);

    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.organizationEventParticipations.push({ id: "OE-upload-test", organizationId: "O1001", eventId: EVENT_ID, joinedAt: "2026-07-31T00:00:00.000Z" });
    await fs.writeFile(dbPath, JSON.stringify(db));
    const created = await fetch(`${baseUrl}/api/organization/events/${EVENT_ID}/projects/${IMAGE_VIDEO_PROJECT}/upload-sessions`, withSession(owner.cookie, { method: "POST" }));
    assert.equal(created.status, 201);
    assert.equal((await json(created)).row.organizationId, "O1001");
  });
});

test("administrators create and upload through their own replacement session", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await configureImageVideoProject(dbPath);
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const created = await fetch(`${baseUrl}/api/admin/events/${EVENT_ID}/projects/${IMAGE_VIDEO_PROJECT}/upload-sessions`, withSession(admin.cookie, { method: "POST" }));
    assert.equal(created.status, 201);
    const payload = await json(created);
    assert.equal(payload.row.eventId, EVENT_ID);
    assert.equal(payload.row.projectId, IMAGE_VIDEO_PROJECT);

    const uploaded = await fetch(`${baseUrl}/api/upload-sessions/${payload.row.id}/artwork-image`, withSession(admin.cookie, { method: "PUT", body: imageForm() }));
    assert.equal(uploaded.status, 201);
    assert.equal((await json(uploaded)).row.originalName, "work.png");

    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(db.registrationUploadSessions.find((row) => row.id === payload.row.id).ownerUserId, "U9001");
    assert.equal(db.registrationUploadSessions.find((row) => row.id === payload.row.id).channel, "admin");
  });
});

test("private asset reads resolve registration identifiers and enforce user organization and admin scopes", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const assetId = "SA-private-read";
    const storedName = "work.png";
    const filePath = path.join(tempDir, "uploads", "submission-assets", assetId, storedName);
    const videoId = "SA-private-video";
    const videoName = "creation.mp4";
    const videoPath = path.join(tempDir, "uploads", "submission-assets", videoId, videoName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, PNG);
    await fs.mkdir(path.dirname(videoPath), { recursive: true });
    await fs.writeFile(videoPath, "0123456789");
    db.registrationSubmissionAssets.push({
      id: assetId,
      registrationId: "R20260627001",
      uploadSessionId: "US-private-read",
      kind: "artwork_image",
      originalName: "work.png",
      storedName,
      filePath,
      mimeType: "image/png",
      sizeBytes: PNG.length,
      width: 1,
      height: 1,
      durationMs: null,
      uploadedByUserId: "U1001",
      uploadedAt: "2026-07-31T00:00:00.000Z",
      cleanedAt: null,
      cleanupReason: ""
    });
    db.registrationSubmissionAssets.push({
      id: videoId, registrationId: "R20260627001", uploadSessionId: "US-private-read", kind: "creation_video",
      originalName: videoName, storedName: videoName, filePath: videoPath, mimeType: "video/mp4",
      sizeBytes: 10, width: 1280, height: 720, durationMs: 1_000, uploadedByUserId: "U1001",
      uploadedAt: "2026-07-31T00:00:00.000Z", cleanedAt: null, cleanupReason: ""
    });
    db.organizationEventParticipations.push({
      id: "OE-private-read", organizationId: "O1001", eventId: EVENT_ID, joinedAt: "2026-07-31T00:00:00.000Z"
    });
    await fs.writeFile(dbPath, JSON.stringify(db));

    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const orgOwner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const target = `/events/${EVENT_ID}/registrations/R20260627001/assets/artwork_image`;

    const userRead = await fetch(`${baseUrl}/api/me${target}`, withSession(ordinary.cookie));
    assert.equal(userRead.status, 200);
    assert.equal(userRead.headers.get("content-type"), "image/png");
    assert.equal(await userRead.arrayBuffer().then((value) => value.byteLength), PNG.length);
    const orgRead = await fetch(`${baseUrl}/api/organization${target}`, withSession(orgOwner.cookie));
    assert.equal(orgRead.status, 200);
    const adminRead = await fetch(`${baseUrl}/api/admin${target}`, withSession(admin.cookie));
    assert.equal(adminRead.status, 200);
    const range = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations/R20260627001/assets/creation_video`, withSession(ordinary.cookie, {
      headers: { Range: "bytes=2-5" }
    }));
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await range.text(), "2345");
    const invalidRange = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations/R20260627001/assets/creation_video`, withSession(ordinary.cookie, {
      headers: { Range: "bytes=10-" }
    }));
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), "bytes */10");
  });
});

test("journals a failed post-commit replacement cleanup without exposing storage fields", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-journal-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const previous = assetRecord(uploadRoot);
  const db = routeFixture({ asset: previous });
  const router = submissionRouter({
    db,
    uploadRoot,
    deleteFile: async () => { throw new Error("disk unavailable"); },
    inspectFile: async () => ({ mimeType: "image/png", sizeBytes: PNG.length, width: 1, height: 1, durationMs: null, warnings: [] })
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/upload-sessions/US-upload/artwork-image`, { method: "PUT", body: imageForm() });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(Object.hasOwn(payload.row, "filePath"), false);
    assert.equal(Object.hasOwn(payload.row, "storedName"), false);
  });
  assert.equal(db.registrationSubmissionAssets.length, 1);
  assert.deepEqual(db.fileCleanupJournal.map((marker) => ({
    filePath: marker.filePath, category: marker.category, attempts: marker.attempts, lastError: marker.lastError
  })), [{
    filePath: previous.filePath, category: "submission-session-asset-replaced", attempts: 1, lastError: "disk unavailable"
  }]);
});

test("journals a failed post-commit session-asset deletion", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-delete-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const asset = assetRecord(uploadRoot);
  const db = routeFixture({ asset });
  const router = submissionRouter({ db, uploadRoot, deleteFile: async () => { throw new Error("disk unavailable"); } });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/upload-sessions/US-upload/assets/artwork_image`, { method: "DELETE" });
    assert.equal(response.status, 200);
  });
  assert.equal(db.registrationSubmissionAssets.length, 0);
  assert.equal(db.fileCleanupJournal.length, 1);
  assert.equal(db.fileCleanupJournal[0].filePath, asset.filePath);
  assert.equal(db.fileCleanupJournal[0].category, "submission-session-asset-deleted");
});

test("keeps a committed replacement when cleanup journaling cannot be persisted", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-journal-write-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const previous = assetRecord(uploadRoot);
  const db = routeFixture({ asset: previous });
  let writes = 0;
  const logs = [];
  const router = submissionRouter({
    db,
    uploadRoot,
    deleteFile: async () => { throw new Error(`cannot remove ${previous.filePath}`); },
    writeDb: async (next) => {
      writes += 1;
      if (writes === 2) throw new Error("journal unavailable");
      Object.assign(db, structuredClone(next));
    },
    logger: { error: (...entry) => logs.push(entry) }
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/upload-sessions/US-upload/artwork-image`, { method: "PUT", body: imageForm() });
    assert.equal(response.status, 201);
  });
  const replacement = db.registrationSubmissionAssets[0];
  assert.notEqual(replacement.id, previous.id);
  assert.deepEqual(await fs.readFile(replacement.filePath), PNG);
  assert.equal(db.fileCleanupJournal.length, 0);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(previous.filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("reports successful deletion when cleanup journaling cannot be persisted", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-delete-write-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const asset = assetRecord(uploadRoot);
  const db = routeFixture({ asset });
  let writes = 0;
  const logs = [];
  const router = submissionRouter({
    db,
    uploadRoot,
    deleteFile: async () => { throw new Error(`cannot remove ${asset.filePath}`); },
    writeDb: async (next) => {
      writes += 1;
      if (writes === 2) throw new Error("journal unavailable");
      Object.assign(db, structuredClone(next));
    },
    logger: { error: (...entry) => logs.push(entry) }
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/upload-sessions/US-upload/assets/artwork_image`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
  assert.equal(db.registrationSubmissionAssets.length, 0);
  assert.equal(db.fileCleanupJournal.length, 0);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(asset.filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("rejects a video when the post-write capacity check crosses 90 percent and removes its temporary file", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-capacity-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const db = routeFixture();
  let calls = 0;
  const router = submissionRouter({
    db, uploadRoot, makeId: () => "SA-capacity",
    storageStatus: async () => ({ disk: { totalBytes: 100, usedBytes: calls++ === 0 ? 80 : 90 }, level: calls === 1 ? "warning" : "critical" }),
    assertCapacity: (status) => {
      if (status.level === "critical") throw Object.assign(new Error("disk full"), { status: 507 });
    },
    inspectFile: async () => ({ mimeType: "video/mp4", sizeBytes: PNG.length, width: 1280, height: 720, durationMs: 1_000, warnings: [] })
  });
  const form = new FormData();
  form.set("file", new Blob([PNG], { type: "video/mp4" }), "creation.mp4");

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/upload-sessions/US-upload/creation-video`, { method: "PUT", body: form });
    assert.equal(response.status, 507);
  });
  assert.equal(db.registrationSubmissionAssets.length, 0);
  await assert.rejects(fs.access(path.join(uploadRoot, "submission-assets", "SA-capacity")), { code: "ENOENT" });
});

test("does not consult the capacity guard for an image upload", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-image-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const db = routeFixture();
  const router = submissionRouter({
    db, uploadRoot, storageStatus: async () => { throw new Error("image upload must not read disk capacity"); },
    assertCapacity: () => { throw new Error("image upload must not assert disk capacity"); },
    inspectFile: async () => ({ mimeType: "image/png", sizeBytes: PNG.length, width: 1, height: 1, durationMs: null, warnings: [] })
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/upload-sessions/US-upload/artwork-image`, { method: "PUT", body: imageForm() });
    assert.equal(response.status, 201);
  });
});

test("expires only active sessions and removes only their unbound submission files", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-expiry-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const expired = assetRecord(uploadRoot, "SA-expired");
  expired.uploadSessionId = "US-expired";
  const bound = assetRecord(uploadRoot, "SA-bound");
  bound.registrationId = "R-bound";
  bound.uploadSessionId = "US-expired";
  const current = assetRecord(uploadRoot, "SA-current");
  current.uploadSessionId = "US-current";
  const committed = assetRecord(uploadRoot, "SA-committed");
  committed.uploadSessionId = "US-committed";
  for (const asset of [expired, bound, current, committed]) {
    await fs.mkdir(path.dirname(asset.filePath), { recursive: true });
    await fs.writeFile(asset.filePath, PNG);
  }
  const db = routeFixture();
  db.registrationUploadSessions = [
    { ...db.registrationUploadSessions[0], id: "US-expired", expiresAt: "2026-07-30T23:59:59.999Z" },
    { ...db.registrationUploadSessions[0], id: "US-current", expiresAt: "2026-08-01T00:00:00.000Z" },
    { ...db.registrationUploadSessions[0], id: "US-committed", state: "committed", expiresAt: "2026-07-30T23:59:59.999Z", committedAt: "2026-07-30T00:00:00.000Z" }
  ];
  db.registrationSubmissionAssets = [expired, bound, current, committed];
  const store = {
    readDb: async () => structuredClone(db),
    writeDb: async (next) => Object.assign(db, structuredClone(next)),
    withMutationLock: async (work) => work()
  };

  const cleanup = await cleanupExpiredSubmissionSessions({
    store, now: "2026-07-31T00:00:00.000Z", uploadRoot, makeId: (prefix) => `${prefix}-expiry`
  });

  assert.deepEqual(cleanup.removedAssetIds, ["SA-expired"]);
  assert.equal(db.registrationUploadSessions.find((session) => session.id === "US-expired").state, "expired");
  assert.equal(db.registrationUploadSessions.find((session) => session.id === "US-current").state, "active");
  assert.equal(db.registrationUploadSessions.find((session) => session.id === "US-committed").state, "committed");
  assert.deepEqual(db.registrationSubmissionAssets.map((asset) => asset.id).sort(), ["SA-bound", "SA-committed", "SA-current"]);
  await assert.rejects(fs.access(expired.filePath), { code: "ENOENT" });
  await fs.access(bound.filePath);
  await fs.access(current.filePath);
  await fs.access(committed.filePath);
});

test("retains a pending expiry marker when file deletion fails and a later journal write would fail", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-expiry-journal-"));
  const asset = assetRecord(uploadRoot, "SA-expiry-failure");
  const db = routeFixture({ asset });
  db.registrationUploadSessions[0].expiresAt = "2026-07-30T23:59:59.999Z";
  let writes = 0;
  const store = {
    readDb: async () => structuredClone(db),
    writeDb: async (next) => {
      writes += 1;
      if (writes === 2) throw new Error("journal write unavailable");
      Object.assign(db, structuredClone(next));
    },
    withMutationLock: async (work) => work()
  };

  await cleanupExpiredSubmissionSessions({
    store, now: "2026-07-31T00:00:00.000Z", uploadRoot, makeId: (prefix) => `${prefix}-expiry`,
    deleteFile: async () => { throw new Error("disk unavailable"); }
  });

  assert.equal(writes, 1);
  assert.equal(db.registrationUploadSessions[0].state, "expired");
  assert.equal(db.registrationSubmissionAssets.length, 0);
  assert.equal(db.fileCleanupJournal.length, 1);
  assert.deepEqual(db.fileCleanupJournal[0], {
    id: "CLN-expiry", filePath: asset.filePath, category: "submission-session-expired", attempts: 1,
    lastError: "pending cleanup", createdAt: "2026-07-31T00:00:00.000Z", lastAttemptAt: "2026-07-31T00:00:00.000Z"
  });
});

test("deduplicates existing pending expiry markers for the same controlled asset", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-expiry-dedupe-"));
  const asset = assetRecord(uploadRoot, "SA-expiry-dedupe");
  const db = routeFixture({ asset });
  db.registrationUploadSessions[0].expiresAt = "2026-07-30T23:59:59.999Z";
  db.fileCleanupJournal = [
    { id: "CLN-first", filePath: asset.filePath, category: "submission-session-expired", attempts: 1, lastError: "pending cleanup", createdAt: "2026-07-30T00:00:00.000Z", lastAttemptAt: "2026-07-30T00:00:00.000Z" },
    { id: "CLN-duplicate", filePath: asset.filePath, category: "submission-session-expired", attempts: 2, lastError: "pending cleanup", createdAt: "2026-07-30T00:00:00.000Z", lastAttemptAt: "2026-07-30T01:00:00.000Z" }
  ];
  const store = {
    readDb: async () => structuredClone(db),
    writeDb: async (next) => { Object.assign(db, structuredClone(next)); },
    withMutationLock: async (work) => work()
  };

  await cleanupExpiredSubmissionSessions({
    store, now: "2026-07-31T00:00:00.000Z", uploadRoot,
    deleteFile: async () => { throw new Error("disk unavailable"); }
  });

  assert.deepEqual(db.fileCleanupJournal.map((marker) => marker.id), ["CLN-first"]);
});

test("keeps a pending expiry marker for generic replay when marker removal persistence fails", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-expiry-replay-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const asset = assetRecord(uploadRoot, "SA-expiry-replay");
  await fs.mkdir(path.dirname(asset.filePath), { recursive: true });
  await fs.writeFile(asset.filePath, PNG);
  const db = routeFixture({ asset });
  db.registrationUploadSessions[0].expiresAt = "2026-07-30T23:59:59.999Z";
  let writes = 0;
  const store = {
    readDb: async () => structuredClone(db),
    writeDb: async (next) => {
      writes += 1;
      if (writes === 2) throw new Error("marker removal unavailable");
      Object.assign(db, structuredClone(next));
    },
    withMutationLock: async (work) => work()
  };

  await cleanupExpiredSubmissionSessions({
    store, now: "2026-07-31T00:00:00.000Z", uploadRoot, makeId: (prefix) => `${prefix}-expiry`, logger: { error: () => {} }
  });

  await assert.rejects(fs.access(asset.filePath), { code: "ENOENT" });
  assert.equal(db.fileCleanupJournal.length, 1);
  const replay = await replayFileCleanupJournal({
    store, removePrivateFile: async () => { throw Object.assign(new Error("already removed"), { code: "ENOENT" }); },
    now: () => "2026-07-31T00:00:01.000Z"
  });
  assert.deepEqual(replay, { removed: 1, retained: 0 });
  assert.deepEqual(db.fileCleanupJournal, []);
});

test("does not delete an expired-session file when the initial database commit fails", async (t) => {
  const uploadRoot = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "submission-assets-expiry-first-write-"));
  t.after(() => fs.rm(uploadRoot, { recursive: true, force: true }));
  const asset = assetRecord(uploadRoot, "SA-expiry-first-write");
  await fs.mkdir(path.dirname(asset.filePath), { recursive: true });
  await fs.writeFile(asset.filePath, PNG);
  const db = routeFixture({ asset });
  db.registrationUploadSessions[0].expiresAt = "2026-07-30T23:59:59.999Z";
  let deleteCalls = 0;
  const store = {
    readDb: async () => structuredClone(db),
    writeDb: async () => { throw new Error("initial write unavailable"); },
    withMutationLock: async (work) => work()
  };

  await assert.rejects(cleanupExpiredSubmissionSessions({
    store, now: "2026-07-31T00:00:00.000Z", uploadRoot,
    deleteFile: async () => { deleteCalls += 1; await fs.unlink(asset.filePath); }
  }), /initial write unavailable/);

  assert.equal(deleteCalls, 0);
  assert.equal(db.registrationUploadSessions[0].state, "active");
  assert.equal(db.fileCleanupJournal.length, 0);
  await fs.access(asset.filePath);
});

test("production expiry cleanup runs once, schedules an unref timer, and can be stopped", async () => {
  let scheduled;
  let stopped;
  let unrefCalls = 0;
  let runs = 0;
  const stop = startSubmissionSessionExpiryCleanup({
    store: {}, intervalMs: 12_345,
    cleanup: async () => { runs += 1; },
    setIntervalFn: (handler, delay) => {
      scheduled = { handler, delay, unref: () => { unrefCalls += 1; } };
      return scheduled;
    },
    clearIntervalFn: (timer) => { stopped = timer; }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(scheduled.delay, 12_345);
  assert.equal(unrefCalls, 1);
  await scheduled.handler();
  assert.equal(runs, 2);
  stop();
  assert.equal(stopped, scheduled);
});
