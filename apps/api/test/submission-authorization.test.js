import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import express from "express";

import { createRegistrationsRouter } from "../src/routes/registrations.js";
import { encryptStudentId } from "../src/security/registration-identities.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const EVENT_ID = "wz-aerospace-2026";
const PROJECT_ID = "aviation-painting";
const validStudentIdNumber = "11010519491231002X";
const previousEncryptionKey = process.env.REGISTRATION_ID_ENCRYPTION_KEY;
process.env.REGISTRATION_ID_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
test.after(() => {
  if (previousEncryptionKey === undefined) delete process.env.REGISTRATION_ID_ENCRYPTION_KEY;
  else process.env.REGISTRATION_ID_ENCRYPTION_KEY = previousEncryptionKey;
});

async function mutateDb(dbPath, mutate) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutate(db);
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

function registrationInput(overrides = {}) {
  return {
    studentIdNumber: validStudentIdNumber,
    athlete: { name: "素材校验学生", school: "测试学校", grade: "五年级", phone: "13600005001" },
    projectId: PROJECT_ID,
    ...overrides
  };
}

function session(id, overrides = {}) {
  const row = {
    id, eventId: EVENT_ID, projectId: PROJECT_ID, ownerUserId: "U1001", organizationId: null,
    state: "active", createdAt: "2026-07-31T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", committedAt: null,
    ...overrides
  };
  row.channel ||= row.organizationId ? "organization" : "personal";
  return row;
}

function asset(id, uploadSessionId, kind, overrides = {}) {
  return {
    id, registrationId: null, uploadSessionId, kind, originalName: `${kind}.png`, storedName: `${id}.bin`,
    filePath: `C:\\private\\${id}.bin`, mimeType: kind === "artwork_image" ? "image/png" : "video/mp4",
    sizeBytes: 100, width: 800, height: 720, durationMs: kind === "artwork_image" ? null : 1_000,
    uploadedByUserId: "U1001", uploadedAt: "2026-07-31T00:00:00.000Z", cleanedAt: null, cleanupReason: "",
    warnings: [], ...overrides
  };
}

async function writeAssetFile(assetRecord) {
  await fs.mkdir(path.dirname(assetRecord.filePath), { recursive: true });
  await fs.writeFile(assetRecord.filePath, "submission-file");
}

async function withRouter(router, fn) {
  const app = express();
  app.use(express.json());
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

test("image-video registration requires an upload session", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === PROJECT_ID).submissionMode = "image_video";
    });

    const response = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationInput())
    }));

    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /上传会话|作品材料/);
  }, { prefix: "submission-auth-" });
});

test("ordinary projects retain the JSON registration flow without an upload session", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => { db.events[0].registrationMode = "force_open"; });
    const response = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationInput({
        athlete: { name: "普通赛项学生", school: "测试学校", grade: "五年级", phone: "13600005002" },
        projectId: "paper-plane-gate"
      }))
    }));
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.row.projectId, "paper-plane-gate");
    assert.equal(Object.hasOwn(payload.row, "submission"), false);
  }, { prefix: "submission-auth-" });
});

test("image-video registration names the missing required material and leaves its session reusable", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === PROJECT_ID).submissionMode = "image_video";
      db.registrationUploadSessions.push(session("US-image-only"));
      db.registrationSubmissionAssets.push(asset("SA-image-only", "US-image-only", "artwork_image"));
    });

    const response = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationInput({ uploadSessionId: "US-image-only" }))
    }));

    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /作画视频/);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(db.registrationUploadSessions.find((row) => row.id === "US-image-only").state, "active");
    assert.equal(db.registrationSubmissionAssets.find((row) => row.id === "SA-image-only").registrationId, null);
  }, { prefix: "submission-auth-" });
});

test("committing a complete image-video session binds both assets and returns only safe submission fields", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === PROJECT_ID).submissionMode = "image_video";
      db.registrationUploadSessions.push(session("US-complete"));
      db.registrationSubmissionAssets.push(
        asset("SA-image", "US-complete", "artwork_image"),
        asset("SA-video", "US-complete", "creation_video", { warnings: ["建议提高视频分辨率"] })
      );
    });

    const response = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationInput({ uploadSessionId: "US-complete" }))
    }));

    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.deepEqual(payload.row.submission, {
      required: true,
      complete: true,
      warnings: ["建议提高视频分辨率"],
      assets: {
        artwork_image: {
          kind: "artwork_image", originalName: "artwork_image.png", mimeType: "image/png", sizeBytes: 100,
          width: 800, height: 720, durationMs: null, uploadedAt: "2026-07-31T00:00:00.000Z", cleanedAt: null,
          cleanupReason: "", warnings: []
        },
        creation_video: {
          kind: "creation_video", originalName: "creation_video.png", mimeType: "video/mp4", sizeBytes: 100,
          width: 800, height: 720, durationMs: 1_000, uploadedAt: "2026-07-31T00:00:00.000Z", cleanedAt: null,
          cleanupReason: "", warnings: ["建议提高视频分辨率"]
        }
      }
    });
    assert.doesNotMatch(JSON.stringify(payload), /filePath|storedName|C:\\private/);

    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(db.registrationUploadSessions.find((row) => row.id === "US-complete").state, "committed");
    assert.equal(db.registrationSubmissionAssets.every((row) => row.registrationId === payload.row.id), true);

    const secondCommit = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationInput({
        uploadSessionId: "US-complete",
        athlete: { name: "不可复用会话学生", school: "测试学校", grade: "五年级", phone: "13600005003" }
      }))
    }));
    assert.equal(secondCommit.status, 409);
    const afterSecondCommit = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(afterSecondCommit.registrations.some((row) => row.athlete?.name === "不可复用会话学生"), false);
  }, { prefix: "submission-auth-" });
});

test("an image-video session cannot be committed into an existing registration that already has bound materials", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      const registration = db.registrations.find((row) => row.id === "R20260627001");
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === registration.projectId).submissionMode = "image_video";
      db.registrationUploadSessions.push(session("US-existing", { projectId: registration.projectId }));
      db.registrationSubmissionAssets.push(
        asset("SA-existing-image", "US-existing", "artwork_image", { registrationId: registration.id }),
        asset("SA-existing-video", "US-existing", "creation_video", { registrationId: registration.id }),
        asset("SA-new-image", "US-new", "artwork_image"),
        asset("SA-new-video", "US-new", "creation_video")
      );
      db.registrationUploadSessions.push(session("US-new", { projectId: registration.projectId }));
      db.registrationIdentities.push({
        registrationId: registration.id,
        ...encryptStudentId(validStudentIdNumber),
        createdAt: registration.createdAt,
        updatedAt: registration.updatedAt
      });
    });
    const existing = JSON.parse(await fs.readFile(dbPath, "utf8")).registrations.find((row) => row.id === "R20260627001");
    const response = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ athlete: existing.athlete, projectId: existing.projectId, uploadSessionId: "US-new", studentIdNumber: validStudentIdNumber })
    }));

    assert.equal(response.status, 409);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(db.registrationSubmissionAssets.filter((row) => row.registrationId === existing.id).length, 2);
    assert.equal(db.registrationSubmissionAssets.filter((row) => row.uploadSessionId === "US-new" && !row.registrationId).length, 2);
    assert.equal(db.registrationUploadSessions.find((row) => row.id === "US-new").state, "active");
  }, { prefix: "submission-auth-" });
});

test("administrator replacement switches the registration asset, resets approval, and audits without exposing storage paths", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const oldAsset = asset("SA-old", "US-old", "artwork_image", {
      registrationId: "R20260627001", storedName: "old.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-old", "old.png"),
      originalName: "approved-old.jpeg", mimeType: "image/jpeg", sizeBytes: 123, width: 780, height: 600,
      uploadedAt: "2026-07-30T00:00:00.000Z"
    });
    const replacement = asset("SA-replacement", "US-replacement", "artwork_image", {
      storedName: "replacement.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-replacement", "replacement.png")
    });
    await writeAssetFile(oldAsset);
    await writeAssetFile(replacement);
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === "paper-plane-gate").submissionMode = "image_video";
      db.registrations.find((row) => row.id === "R20260627001").status = "approved";
      db.registrationUploadSessions.push(session("US-replacement", { projectId: "paper-plane-gate", ownerUserId: "U9001", channel: "admin" }));
      db.registrationSubmissionAssets.push(oldAsset, replacement);
    });

    const response = await fetch(`${baseUrl}/api/admin/events/${EVENT_ID}/registrations/R20260627001/assets/artwork_image`, withSession(admin.cookie, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadSessionId: "US-replacement" })
    }));

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.registration.status, "pending");
    assert.equal(payload.row.originalName, "artwork_image.png");
    assert.doesNotMatch(JSON.stringify(payload), /filePath|storedName|submission-assets/);
    await assert.rejects(fs.access(oldAsset.filePath), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(replacement.filePath), Buffer.from("submission-file"));
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const audit = db.auditLogs.find((row) => row.action === "registration_asset_replace" && row.targetId === "R20260627001");
    assert.ok(audit);
    assert.match(audit.summary, /approved-old\.jpeg/);
    assert.match(audit.summary, /image\/jpeg/);
    assert.match(audit.summary, /123/);
    assert.doesNotMatch(audit.summary, /submission-assets|old\.png/);
    const resetAudit = db.auditLogs.find((row) => row.action === "registration_review_reset_after_asset_replace" && row.targetId === "R20260627001");
    assert.ok(resetAudit);
    const resetSummary = JSON.parse(resetAudit.summary);
    assert.equal(resetSummary.eventId, EVENT_ID);
    assert.equal(resetSummary.organizationId, "O1001");
    assert.equal(resetSummary.registrationId, "R20260627001");
    assert.equal(resetSummary.uploadBatchId, "US-replacement");
    assert.equal(resetSummary.asset.assetId, "SA-old");
    assert.equal(resetSummary.asset.assetKind, "artwork_image");
    assert.equal(resetSummary.channel, "admin");
    assert.equal(resetSummary.previousStatus, "approved");
    assert.equal(resetSummary.nextStatus, "pending");
    assert.doesNotMatch(resetAudit.summary, /filePath|storedName|submission-assets/);
  }, { prefix: "submission-auth-" });
});

test("administrator cannot consume personal, organization, or another administrator replacement sessions", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const oldAsset = asset("SA-admin-current", "US-admin-current", "artwork_image", {
      registrationId: "R20260627001", storedName: "current.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-admin-current", "current.png")
    });
    const sources = [
      asset("SA-admin-personal", "US-admin-personal", "artwork_image", { storedName: "personal.png", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-admin-personal", "personal.png") }),
      asset("SA-admin-org", "US-admin-org", "artwork_image", { storedName: "organization.png", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-admin-org", "organization.png") }),
      asset("SA-admin-other", "US-admin-other", "artwork_image", { storedName: "other.png", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-admin-other", "other.png") })
    ];
    await Promise.all([writeAssetFile(oldAsset), ...sources.map(writeAssetFile)]);
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === "paper-plane-gate").submissionMode = "image_video";
      db.registrationUploadSessions.push(
        session("US-admin-personal", { projectId: "paper-plane-gate", channel: "personal" }),
        session("US-admin-org", { projectId: "paper-plane-gate", ownerUserId: "U2001", organizationId: "O1001", channel: "organization" }),
        session("US-admin-other", { projectId: "paper-plane-gate", ownerUserId: "U9002", channel: "admin" })
      );
      db.registrationSubmissionAssets.push(oldAsset, ...sources);
    });

    for (const sessionId of ["US-admin-personal", "US-admin-org", "US-admin-other"]) {
      const response = await fetch(`${baseUrl}/api/admin/events/${EVENT_ID}/registrations/R20260627001/assets/artwork_image`, withSession(admin.cookie, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadSessionId: sessionId })
      }));
      assert.equal(response.status, 403);
    }
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(db.registrationSubmissionAssets.find((row) => row.registrationId === "R20260627001").id, "SA-admin-current");
    assert.equal(db.registrationSubmissionAssets.filter((row) => row.id.startsWith("SA-admin-") && !row.registrationId).length, 3);
  }, { prefix: "submission-auth-" });
});

test("administrator cannot approve a required submission when a material is missing or cleaned", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      const registration = db.registrations.find((row) => row.id === "R20260627001");
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === registration.projectId).submissionMode = "image_video";
      db.registrationSubmissionAssets.push(asset("SA-cleaned-video", "US-cleaned-video", "creation_video", {
        registrationId: registration.id,
        cleanedAt: "2026-07-31T09:00:00.000Z",
        cleanupReason: "管理员清理"
      }));
    });

    const response = await fetch(`${baseUrl}/api/admin/events/${EVENT_ID}/registrations/R20260627001/status`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" })
    }));

    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /作品材料|完整|清理/);
  }, { prefix: "submission-auth-" });
});

test("administrator list marks absent submission files missing and refuses approval", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      const registration = db.registrations.find((row) => row.id === "R20260627001");
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === registration.projectId).submissionMode = "image_video";
      db.registrationSubmissionAssets.push(
        asset("SA-absent-image", "US-absent", "artwork_image", { registrationId: registration.id, storedName: "image.png", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-absent-image", "image.png") }),
        asset("SA-absent-video", "US-absent", "creation_video", { registrationId: registration.id, storedName: "video.mp4", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-absent-video", "video.mp4") })
      );
    });

    const listed = await fetch(`${baseUrl}/api/admin/events/${EVENT_ID}/registrations?pageSize=10`, withSession(admin.cookie));
    const row = (await listed.json()).rows.find((item) => item.id === "R20260627001");
    assert.equal(row.submission.complete, false);
    assert.deepEqual(row.submission.missingKinds, ["artwork_image", "creation_video"]);
    assert.doesNotMatch(JSON.stringify(row.submission), /filePath|storedName|submission-assets/);

    const response = await fetch(`${baseUrl}/api/admin/events/${EVENT_ID}/registrations/R20260627001/status`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved" })
    }));
    assert.equal(response.status, 422);
  }, { prefix: "submission-auth-" });
});

test("administrator approves an image-video registration only when both controlled files exist", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const image = asset("SA-present-image", "US-present", "artwork_image", {
      registrationId: "R20260627001", storedName: "image.png", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-present-image", "image.png")
    });
    const video = asset("SA-present-video", "US-present", "creation_video", {
      registrationId: "R20260627001", storedName: "video.mp4", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-present-video", "video.mp4")
    });
    await Promise.all([writeAssetFile(image), writeAssetFile(video)]);
    await mutateDb(dbPath, (db) => {
      const registration = db.registrations.find((row) => row.id === "R20260627001");
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === registration.projectId).submissionMode = "image_video";
      db.registrationSubmissionAssets.push(image, video);
    });

    const response = await fetch(`${baseUrl}/api/admin/events/${EVENT_ID}/registrations/R20260627001/status`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved" })
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).row.status, "approved");
  }, { prefix: "submission-auth-" });
});

test("administrator registration summaries expose material metadata without storage paths", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const image = asset("SA-summary-image", "US-summary", "artwork_image", {
      registrationId: "R20260627001", storedName: "private-image.png", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-summary-image", "private-image.png")
    });
    const video = asset("SA-summary-video", "US-summary", "creation_video", {
      registrationId: "R20260627001", storedName: "private-video.mp4", filePath: path.join(tempDir, "uploads", "submission-assets", "SA-summary-video", "private-video.mp4")
    });
    await Promise.all([writeAssetFile(image), writeAssetFile(video)]);
    await mutateDb(dbPath, (db) => {
      const registration = db.registrations.find((row) => row.id === "R20260627001");
      db.projects.find((project) => project.id === registration.projectId).submissionMode = "image_video";
      db.registrationSubmissionAssets.push(image, video);
    });

    const response = await fetch(`${baseUrl}/api/admin/events/${EVENT_ID}/registrations?pageSize=10`, withSession(admin.cookie));
    assert.equal(response.status, 200);
    const row = (await response.json()).rows.find((item) => item.id === "R20260627001");
    assert.equal(row.submission.complete, true);
    assert.doesNotMatch(JSON.stringify(row.submission), /filePath|storedName|C:\\private/);
  }, { prefix: "submission-auth-" });
});

test("organization owner may replace its approved asset but cannot replace another organization asset", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const owner = await loginAs(baseUrl, "13800000012", "123456");
    const otherOwner = await loginAs(baseUrl, "13800000011", "123456");
    const oldAsset = asset("SA-org-old", "US-org-old", "artwork_image", {
      registrationId: "R20260627002", storedName: "old.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-org-old", "old.png")
    });
    const replacement = asset("SA-org-replacement", "US-org-replacement", "artwork_image", {
      uploadSessionId: "US-org-replacement", storedName: "replacement.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-org-replacement", "replacement.png"),
      uploadedByUserId: "U2002"
    });
    const crossOrganizationSource = asset("SA-other-org", "US-other-org", "artwork_image", {
      uploadSessionId: "US-other-org", storedName: "other.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-other-org", "other.png"),
      uploadedByUserId: "U2001"
    });
    await Promise.all([writeAssetFile(oldAsset), writeAssetFile(replacement), writeAssetFile(crossOrganizationSource)]);
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === "drone-relay").submissionMode = "image_video";
      db.registrationUploadSessions.push(
        session("US-org-replacement", { projectId: "drone-relay", ownerUserId: "U2002", organizationId: "O1002" }),
        session("US-other-org", { projectId: "drone-relay", ownerUserId: "U2001", organizationId: "O1001" })
      );
      db.registrationSubmissionAssets.push(oldAsset, replacement, crossOrganizationSource);
    });
    for (const cookie of [owner.cookie, otherOwner.cookie]) {
      const joined = await fetch(`${baseUrl}/api/organization/events/${EVENT_ID}/join`, withSession(cookie, { method: "POST" }));
      assert.equal(joined.status, 201);
    }

    const ownResponse = await fetch(`${baseUrl}/api/organization/events/${EVENT_ID}/registrations/R20260627002/assets/artwork_image`, withSession(owner.cookie, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadSessionId: "US-org-replacement" })
    }));
    assert.equal(ownResponse.status, 200);
    assert.equal((await ownResponse.json()).registration.status, "pending");

    const crossResponse = await fetch(`${baseUrl}/api/organization/events/${EVENT_ID}/registrations/R20260627002/assets/artwork_image`, withSession(otherOwner.cookie, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadSessionId: "US-other-org" })
    }));
    assert.equal(crossResponse.status, 403);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(db.registrationSubmissionAssets.find((row) => row.registrationId === "R20260627002").id, "SA-org-old");
    assert.equal(db.registrationSubmissionAssets.find((row) => row.id === "SA-other-org").registrationId, null);
    await assert.doesNotReject(fs.access(replacement.filePath));
    const replaceAudit = db.auditLogs.find((row) => row.action === "registration_asset_replace" && row.targetId === "R20260627002");
    assert.equal(JSON.parse(replaceAudit.summary).organizationId, "O1002");
    const resetAudit = db.auditLogs.find((row) => row.action === "registration_review_reset_after_asset_replace" && row.targetId === "R20260627002");
    assert.ok(resetAudit);
    assert.deepEqual(
      {
        organizationId: JSON.parse(resetAudit.summary).organizationId,
        previousStatus: JSON.parse(resetAudit.summary).previousStatus,
        nextStatus: JSON.parse(resetAudit.summary).nextStatus
      },
      { organizationId: "O1002", previousStatus: "approved", nextStatus: "pending" }
    );
  }, { prefix: "submission-auth-" });
});

test("pending personal registration can replace its material, while approved replacement is rejected", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const oldAsset = asset("SA-personal-old", "US-personal-old", "artwork_image", {
      registrationId: "R20260627001", storedName: "old.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-personal-old", "old.png")
    });
    const replacement = asset("SA-personal-replacement", "US-personal-replacement", "artwork_image", {
      storedName: "replacement.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-personal-replacement", "replacement.png")
    });
    const approvedSource = asset("SA-personal-approved-source", "US-approved-source", "artwork_image", {
      storedName: "approved-source.png",
      filePath: path.join(tempDir, "uploads", "submission-assets", "SA-personal-approved-source", "approved-source.png")
    });
    await Promise.all([writeAssetFile(oldAsset), writeAssetFile(replacement), writeAssetFile(approvedSource)]);
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.projects.find((project) => project.id === "paper-plane-gate").submissionMode = "image_video";
      const registration = db.registrations.find((row) => row.id === "R20260627001");
      registration.status = "pending";
      db.registrationUploadSessions.push(
        session("US-personal-replacement", { projectId: "paper-plane-gate" }),
        session("US-approved-source", { projectId: "paper-plane-gate" }),
        session("US-invalid-source", { projectId: "paper-plane-gate" })
      );
      db.registrationSubmissionAssets.push(oldAsset, replacement, approvedSource);
    });

    const replacementResponse = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations/R20260627001/assets/artwork_image`, withSession(ordinary.cookie, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadSessionId: "US-personal-replacement" })
    }));
    assert.equal(replacementResponse.status, 200);

    const afterPendingReplacement = JSON.parse(await fs.readFile(dbPath, "utf8"));
    afterPendingReplacement.registrations.find((row) => row.id === "R20260627001").status = "approved";
    await fs.writeFile(dbPath, JSON.stringify(afterPendingReplacement));
    const approvedResponse = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations/R20260627001/assets/artwork_image`, withSession(ordinary.cookie, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadSessionId: "US-approved-source" })
    }));
    assert.equal(approvedResponse.status, 403);

    const afterApprovedRejection = JSON.parse(await fs.readFile(dbPath, "utf8"));
    afterApprovedRejection.registrations.find((row) => row.id === "R20260627001").status = "rejected";
    await fs.writeFile(dbPath, JSON.stringify(afterApprovedRejection));

    const invalidResponse = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations/R20260627001/assets/artwork_image`, withSession(ordinary.cookie, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadSessionId: "US-invalid-source" })
    }));
    assert.equal(invalidResponse.status, 422);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(db.registrationSubmissionAssets.find((row) => row.registrationId === "R20260627001").id, "SA-personal-old");
    await assert.doesNotReject(fs.access(replacement.filePath));
  }, { prefix: "submission-auth-" });
});

test("a failed replacement database write restores the old row and journals a source file that cannot be removed", async () => {
  const oldAsset = asset("SA-db-old", "US-db-old", "artwork_image", { registrationId: "R-db", filePath: "C:\\private\\old.png" });
  const sourceAsset = asset("SA-db-source", "US-db-source", "artwork_image", { filePath: "C:\\private\\source.png" });
  const db = {
    users: [{ id: "U1001", type: "ordinary", status: "active" }], organizations: [], memberships: [],
    organizationEventParticipations: [], auditLogs: [], fileCleanupJournal: [],
    events: [{ id: EVENT_ID, status: "published", registrationMode: "force_open", archivedAt: null }],
    projects: [{ id: PROJECT_ID, eventId: EVENT_ID, enabled: true, submissionMode: "image_video", allowedGroups: ["小学高段"] }],
    registrations: [{ id: "R-db", eventId: EVENT_ID, projectId: PROJECT_ID, personalUserId: "U1001", organizationId: null, status: "pending", rejectReason: "", updatedAt: "2026-07-31T00:00:00.000Z" }],
    registrationUploadSessions: [session("US-db-source")],
    registrationSubmissionAssets: [oldAsset, sourceAsset]
  };
  let writes = 0;
  const store = {
    readDb: async () => structuredClone(db),
    writeDb: async (next) => {
      writes += 1;
      if (writes === 1) throw new Error("database unavailable");
      Object.assign(db, structuredClone(next));
    }
  };
  const pass = (req, _res, next) => { req.user = { id: "U1001", type: "ordinary", status: "active" }; next(); };
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const router = createRegistrationsRouter({
    store, requireUser: pass, requireAdmin: pass, requirePasswordReady: pass, asyncRoute,
    makeId: (prefix) => `${prefix}-db`, now: () => "2026-07-31T00:00:00.000Z",
    deleteFile: async () => { throw new Error("disk unavailable"); }, logger: { error: () => {} }
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations/R-db/assets/artwork_image`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadSessionId: "US-db-source" })
    });
    assert.equal(response.status, 500);
  });
  assert.equal(db.registrationSubmissionAssets.find((row) => row.registrationId === "R-db").id, "SA-db-old");
  assert.equal(db.registrationSubmissionAssets.find((row) => row.id === "SA-db-source").registrationId, null);
  assert.deepEqual(db.fileCleanupJournal.map((row) => ({ filePath: row.filePath, category: row.category })), [{
    filePath: "C:\\private\\source.png", category: "registration-asset-replacement-rollback"
  }]);
});

test("a failed replacement database write marks a successfully deleted source as cleaned before it can be reused", async () => {
  const oldAsset = asset("SA-clean-old", "US-clean-old", "artwork_image", { registrationId: "R-clean", filePath: "C:\\private\\old.png" });
  const sourceAsset = asset("SA-clean-source", "US-clean-source", "artwork_image", { filePath: "C:\\private\\source.png" });
  const db = {
    users: [{ id: "U1001", type: "ordinary", status: "active" }], organizations: [], memberships: [],
    organizationEventParticipations: [], auditLogs: [], fileCleanupJournal: [],
    events: [{ id: EVENT_ID, status: "published", registrationMode: "force_open", archivedAt: null }],
    projects: [{ id: PROJECT_ID, eventId: EVENT_ID, enabled: true, submissionMode: "image_video", allowedGroups: ["小学高段"] }],
    registrations: [{ id: "R-clean", eventId: EVENT_ID, projectId: PROJECT_ID, personalUserId: "U1001", organizationId: null, status: "pending", rejectReason: "", updatedAt: "2026-07-31T00:00:00.000Z" }],
    registrationUploadSessions: [session("US-clean-source")],
    registrationSubmissionAssets: [oldAsset, sourceAsset]
  };
  let writes = 0;
  const store = {
    readDb: async () => structuredClone(db),
    writeDb: async (next) => {
      writes += 1;
      if (writes === 1) throw new Error("database unavailable");
      Object.assign(db, structuredClone(next));
    }
  };
  const pass = (req, _res, next) => { req.user = { id: "U1001", type: "ordinary", status: "active" }; next(); };
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const router = createRegistrationsRouter({
    store, requireUser: pass, requireAdmin: pass, requirePasswordReady: pass, asyncRoute,
    makeId: (prefix) => `${prefix}-clean`, now: () => "2026-07-31T00:00:00.000Z",
    deleteFile: async () => {}, logger: { error: () => {} }
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/me/events/${EVENT_ID}/registrations/R-clean/assets/artwork_image`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadSessionId: "US-clean-source" })
    });
    assert.equal(response.status, 500);
  });
  const source = db.registrationSubmissionAssets.find((row) => row.id === "SA-clean-source");
  assert.equal(source?.cleanedAt, "2026-07-31T00:00:00.000Z");
  assert.match(source?.cleanupReason || "", /数据库/);
});
