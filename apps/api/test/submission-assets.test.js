import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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
  });
});
