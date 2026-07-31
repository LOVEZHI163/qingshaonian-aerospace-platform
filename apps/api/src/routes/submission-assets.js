import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";

import { SUBMISSION_IMAGE_POLICY, SUBMISSION_VIDEO_POLICY } from "../files/policy.js";
import { deleteSubmissionFile, inspectSubmissionFile, readSubmissionRange } from "../files/submission-storage.js";
import { assertVideoUploadCapacity, readStorageStatus } from "../services/system-storage.js";
import {
  authorizeRegistrationAssetRead,
  createUploadSession,
  removeSessionAsset,
  replaceSessionAsset,
  requireUploadSessionAccess,
  submissionAssetSummary,
  uploadSessionSummary
} from "../services/submission-assets.js";

function policyFor(kind) {
  return kind === "artwork_image" ? SUBMISSION_IMAGE_POLICY : SUBMISSION_VIDEO_POLICY;
}

function safeFileName(value) {
  return path.basename(String(value || "submission"))
    .replace(/[\\/\x00-\x1f<>:"|?*]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180) || "submission";
}

async function removeUploadedFile(file) {
  if (!file?.path) return;
  try { await fs.unlink(file.path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { await fs.rmdir(path.dirname(file.path)); } catch (error) { if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error; }
}

async function removeUploadDirectory(uploadRoot, assetId) {
  if (!assetId) return;
  try { await fs.rm(path.resolve(uploadRoot, "submission-assets", assetId), { recursive: true, force: true }); } catch { /* preserve request errors */ }
}

function multipartUpload(kind, uploadRoot) {
  const policy = policyFor(kind);
  const storage = multer.diskStorage({
    destination(req, _file, callback) {
      const directory = path.resolve(uploadRoot, "submission-assets", req.submissionUpload.assetId);
      fs.mkdir(directory, { recursive: true }).then(() => callback(null, directory), callback);
    },
    filename(_req, _file, callback) {
      callback(null, crypto.randomUUID());
    }
  });
  const upload = multer({ storage, limits: { files: 1, fileSize: policy.maxBytes + 1 } });
  return (req, res, next) => upload.single("file")(req, res, async (error) => {
    if (!error) return next();
    try { await removeUploadedFile(req.file); } catch { /* preserve the upload error */ }
    await removeUploadDirectory(uploadRoot, req.submissionUpload?.assetId);
    if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: kind === "artwork_image" ? "图片文件不能超过 2MB" : "视频文件不能超过 200MB" });
    return res.status(422).json({ error: "作品文件上传无效" });
  });
}

function incomingContentLength(req) {
  const value = Number(req.get("content-length"));
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

const SAFE_ASSET_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_STORED_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function isControlledSubmissionAsset(asset, uploadRoot) {
  if (!asset || !SAFE_ASSET_COMPONENT.test(String(asset.id || "")) || !SAFE_STORED_FILE.test(String(asset.storedName || ""))) return false;
  const expected = path.resolve(uploadRoot, "submission-assets", asset.id, asset.storedName);
  return path.resolve(String(asset.filePath || "")) === expected;
}

async function removeEmptyAssetDirectory(asset, uploadRoot) {
  if (!isControlledSubmissionAsset(asset, uploadRoot)) return;
  try { await fs.rmdir(path.dirname(asset.filePath)); } catch (error) {
    if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
  }
}

async function finishCommittedAssetCleanup({ store, db, asset, category, deleteFile, uploadRoot, makeId, now }) {
  if (!isControlledSubmissionAsset(asset, uploadRoot)) return;
  try {
    await deleteFile(asset, { uploadRoot });
    await removeEmptyAssetDirectory(asset, uploadRoot);
  } catch (error) {
    db.fileCleanupJournal ||= [];
    const createdAt = now();
    db.fileCleanupJournal.push({
      id: makeId("CLN"), filePath: asset.filePath, category, attempts: 1,
      lastError: String(error?.message || error).slice(0, 500), createdAt, lastAttemptAt: createdAt
    });
    await store.writeDb(db);
  }
}

export function createSubmissionAssetsRouter({
  store, requireUser, requireAdmin, requirePasswordReady, asyncRoute, makeId, now,
  uploadRoot = process.env.UPLOAD_ROOT || "/data/uploads",
  storageStatus = readStorageStatus,
  assertCapacity = assertVideoUploadCapacity,
  deleteFile = deleteSubmissionFile
}) {
  const router = express.Router();
  const user = [requireUser, requirePasswordReady];
  const admin = [requireAdmin, requirePasswordReady];

  function createSession(channel) {
    return asyncRoute(async (req, res) => {
      const db = await store.readDb();
      const session = createUploadSession({
        db, eventId: req.params.eventId, projectId: req.params.projectId,
        actor: req.user, channel, now, makeId
      });
      await store.writeDb(db);
      res.status(201).json({ row: uploadSessionSummary(db, session) });
    });
  }

  router.post("/me/events/:eventId/projects/:projectId/upload-sessions", ...user, createSession("personal"));
  router.post("/organization/events/:eventId/projects/:projectId/upload-sessions", ...user, createSession("organization"));

  function uploadAsset(kind) {
    return [
      asyncRoute(async (req, _res, next) => {
        const db = await store.readDb();
        const storedSession = db.registrationUploadSessions.find((row) => row.id === req.params.sessionId);
        const channel = storedSession?.organizationId ? "organization" : "personal";
        const session = requireUploadSessionAccess({ db, sessionId: req.params.sessionId, actor: req.user, channel, now, kind });
        if (kind === "creation_video") {
          const status = await storageStatus({ uploadRoot });
          assertCapacity(status, incomingContentLength(req));
        }
        req.submissionUpload = { sessionId: session.id, assetId: makeId("SA") };
        next();
      }),
      multipartUpload(kind, uploadRoot),
      asyncRoute(async (req, res, next) => {
        if (!req.file) return res.status(422).json({ error: "请上传 file 字段" });
        try {
          if (kind === "creation_video") {
            const status = await storageStatus({ uploadRoot });
            assertCapacity(status, req.file.size);
          }
          const metadata = await inspectSubmissionFile({ kind, filePath: req.file.path, originalName: req.file.originalname });
          const db = await store.readDb();
          const storedSession = db.registrationUploadSessions.find((row) => row.id === req.params.sessionId);
          const channel = storedSession?.organizationId ? "organization" : "personal";
          const session = requireUploadSessionAccess({ db, sessionId: req.params.sessionId, actor: req.user, channel, now, kind });
          const replacement = replaceSessionAsset({
            db, session, kind, actor: req.user, now, makeId,
            stored: {
              ...metadata, id: req.submissionUpload.assetId, originalName: req.file.originalname,
              storedName: path.basename(req.file.path), filePath: req.file.path
            }
          });
          await store.writeDb(db);
          const result = { db, session, ...replacement };
          if (result.previous) {
            await finishCommittedAssetCleanup({
              store, db: result.db, asset: result.previous, category: "submission-session-asset-replaced",
              deleteFile, uploadRoot, makeId, now
            });
          }
          res.status(201).json({ row: submissionAssetSummary(result.asset), session: uploadSessionSummary(result.db, result.session) });
        } catch (error) {
          try { await removeUploadedFile(req.file); } catch { /* preserve original error */ }
          next(error);
        }
      })
    ];
  }

  router.put("/upload-sessions/:sessionId/artwork-image", ...user, ...uploadAsset("artwork_image"));
  router.put("/upload-sessions/:sessionId/creation-video", ...user, ...uploadAsset("creation_video"));

  router.delete("/upload-sessions/:sessionId/assets/:kind", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const storedSession = db.registrationUploadSessions.find((row) => row.id === req.params.sessionId);
    const channel = storedSession?.organizationId ? "organization" : "personal";
    const session = requireUploadSessionAccess({ db, sessionId: req.params.sessionId, actor: req.user, channel, now, kind: req.params.kind });
    const result = removeSessionAsset({ db, session, kind: req.params.kind });
    await store.writeDb(db);
    await finishCommittedAssetCleanup({
      store, db, asset: result, category: "submission-session-asset-deleted", deleteFile, uploadRoot, makeId, now
    });
    res.json({ ok: true });
  }));

  function streamAsset(channel) {
    return asyncRoute(async (req, res, next) => {
      const db = await store.readDb();
      const { asset } = authorizeRegistrationAssetRead({
        db, eventId: req.params.eventId, registrationId: req.params.registrationId,
        kind: req.params.kind, actor: req.user, channel
      });
      let response;
      try {
        response = await readSubmissionRange(asset, asset.mimeType === "video/mp4" ? req.get("range") : null);
      } catch (error) {
        if (error?.code === "ENOENT") return res.status(404).json({ error: "作品文件缺失" });
        return next(error);
      }
      const disposition = req.query.download === "1" ? "attachment" : "inline";
      res.status(response.status).set({
        ...response.headers,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${disposition}; filename="${safeFileName(asset.originalName)}"`
      });
      response.stream.on("error", next).pipe(res);
    });
  }

  router.get("/me/events/:eventId/registrations/:registrationId/assets/:kind", ...user, streamAsset("personal"));
  router.get("/organization/events/:eventId/registrations/:registrationId/assets/:kind", ...user, streamAsset("organization"));
  router.get("/admin/events/:eventId/registrations/:registrationId/assets/:kind", ...admin, streamAsset("admin"));

  return router;
}
