import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import archiver from "archiver";

import { SUBMISSION_IMAGE_POLICY, SUBMISSION_VIDEO_POLICY } from "../files/policy.js";
import { deleteSubmissionFile, inspectSubmissionFile, readSubmissionRange } from "../files/submission-storage.js";
import { assertVideoUploadCapacity, readStorageStatus } from "../services/system-storage.js";
import {
  authorizeRegistrationAssetRead,
  createUploadSession,
  removeSessionAsset,
  recordSubmissionAssetAudit,
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

function safeDownloadPart(value, fallback) {
  const result = String(value || "").trim()
    .replace(/[\\/\x00-\x1f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 48);
  return result || fallback;
}

function extensionForAsset(asset) {
  const extension = path.extname(String(asset.originalName || "")).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  if (asset.kind === "creation_video") return ".mp4";
  return asset.mimeType === "image/jpeg" ? ".jpg" : ".png";
}

export function submissionDownloadName(db, registration, asset) {
  const project = (db.projects || []).find((row) => row.id === registration.projectId);
  const label = asset.kind === "creation_video" ? "作画视频" : "作品图片";
  return [
    safeDownloadPart(registration.id, "报名"),
    safeDownloadPart(registration.athlete?.name, "选手"),
    safeDownloadPart(registration.athlete?.school, "学校"),
    safeDownloadPart(project?.name || registration.projectName, "赛项"),
    safeDownloadPart(registration.group, "组别"),
    label
  ].join("_") + extensionForAsset(asset);
}

function attachmentDisposition(fileName) {
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="download${path.extname(fileName)}"; filename*=UTF-8''${encoded}`;
}

function adminEventAssets(db, eventId, { kind = "", includeCleaned = false } = {}) {
  const registrations = new Map((db.registrations || [])
    .filter((row) => row.eventId === eventId)
    .map((row) => [row.id, row]));
  return (db.registrationSubmissionAssets || []).filter((asset) => {
    if (!registrations.has(asset.registrationId)) return false;
    if (kind && asset.kind !== kind) return false;
    return includeCleaned || !asset.cleanedAt;
  }).map((asset) => ({ asset, registration: registrations.get(asset.registrationId) }));
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

function unlockedAsyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
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
  try { await fs.rmdir(path.dirname(asset.filePath)); } catch { /* directory cleanup is best effort */ }
}

function logCleanupJournalPersistenceFailure(logger, asset, category) {
  try {
    logger?.error?.("Submission asset cleanup journal persistence failed", {
      assetId: asset.id,
      category
    });
  } catch { /* logging must not affect a committed response */ }
}

async function finishCommittedAssetCleanup({ store, db, asset, category, deleteFile, uploadRoot, makeId, now, logger }) {
  if (!isControlledSubmissionAsset(asset, uploadRoot)) return;
  try {
    await deleteFile(asset, { uploadRoot });
  } catch (error) {
    db.fileCleanupJournal ||= [];
    const createdAt = now();
    db.fileCleanupJournal.push({
      id: makeId("CLN"), filePath: asset.filePath, category, attempts: 1,
      lastError: String(error?.message || error).slice(0, 500), createdAt, lastAttemptAt: createdAt
    });
    try {
      await store.writeDb(db);
    } catch {
      logCleanupJournalPersistenceFailure(logger, asset, category);
    }
    return;
  }
  await removeEmptyAssetDirectory(asset, uploadRoot);
}

export function createSubmissionAssetsRouter({
  store, requireUser, requireAdmin, requirePasswordReady, asyncRoute, makeId, now,
  uploadRoot = process.env.UPLOAD_ROOT || "/data/uploads",
  storageStatus = readStorageStatus,
  assertCapacity = assertVideoUploadCapacity,
  deleteFile = deleteSubmissionFile,
  logger = console
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
      recordSubmissionAssetAudit(db, {
        actor: req.user,
        action: "registration_asset_upload_session_create",
        eventId: session.eventId,
        organizationId: session.organizationId || null,
        sessionId: session.id,
        channel,
        createdAt: session.createdAt
      });
      await store.writeDb(db);
      res.status(201).json({ row: uploadSessionSummary(db, session) });
    });
  }

  router.post("/me/events/:eventId/projects/:projectId/upload-sessions", ...user, createSession("personal"));
  router.post("/organization/events/:eventId/projects/:projectId/upload-sessions", ...user, createSession("organization"));
  router.post("/admin/events/:eventId/projects/:projectId/upload-sessions", ...admin, createSession("admin"));

  function sessionChannel(session, actor) {
    if (session?.organizationId) return "organization";
    return actor?.type === "admin" && session?.ownerUserId === actor?.id ? "admin" : "personal";
  }

  function uploadAsset(kind) {
    return [
      unlockedAsyncRoute(async (req, _res, next) => {
        const db = await store.readDb();
        const storedSession = db.registrationUploadSessions.find((row) => row.id === req.params.sessionId);
        const channel = sessionChannel(storedSession, req.user);
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
        let committed = false;
        try {
          if (kind === "creation_video") {
            const status = await storageStatus({ uploadRoot });
            assertCapacity(status, req.file.size);
          }
          const metadata = await inspectSubmissionFile({ kind, filePath: req.file.path, originalName: req.file.originalname });
          const db = await store.readDb();
          const storedSession = db.registrationUploadSessions.find((row) => row.id === req.params.sessionId);
          const channel = sessionChannel(storedSession, req.user);
          const session = requireUploadSessionAccess({ db, sessionId: req.params.sessionId, actor: req.user, channel, now, kind });
          const replacement = replaceSessionAsset({
            db, session, kind, actor: req.user, now, makeId,
            stored: {
              ...metadata, id: req.submissionUpload.assetId, originalName: req.file.originalname,
              storedName: path.basename(req.file.path), filePath: req.file.path
            }
          });
          recordSubmissionAssetAudit(db, {
            actor: req.user,
            action: "registration_asset_upload",
            eventId: session.eventId,
            organizationId: session.organizationId || null,
            sessionId: session.id,
            asset: replacement.asset,
            assetKind: kind,
            channel,
            createdAt: replacement.asset.uploadedAt
          });
          if (replacement.previous) {
            recordSubmissionAssetAudit(db, {
              actor: req.user,
              action: "registration_asset_cleanup",
              eventId: session.eventId,
              organizationId: session.organizationId || null,
              sessionId: session.id,
              asset: replacement.previous,
              assetKind: kind,
              channel,
              cleanupCategory: "submission-session-asset-replaced",
              createdAt: replacement.asset.uploadedAt
            });
          }
          await store.writeDb(db);
          committed = true;
          const result = { db, session, ...replacement };
          if (result.previous) {
            await finishCommittedAssetCleanup({
              store, db: result.db, asset: result.previous, category: "submission-session-asset-replaced",
              deleteFile, uploadRoot, makeId, now, logger
            });
          }
          res.status(201).json({ row: submissionAssetSummary(result.asset), session: uploadSessionSummary(result.db, result.session) });
        } catch (error) {
          if (!committed) {
            try { await removeUploadedFile(req.file); } catch { /* preserve original error */ }
          }
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
    const channel = sessionChannel(storedSession, req.user);
    const session = requireUploadSessionAccess({ db, sessionId: req.params.sessionId, actor: req.user, channel, now, kind: req.params.kind });
    const result = removeSessionAsset({ db, session, kind: req.params.kind });
    recordSubmissionAssetAudit(db, {
      actor: req.user,
      action: "registration_asset_cleanup",
      eventId: session.eventId,
      organizationId: session.organizationId || null,
      sessionId: session.id,
      asset: result,
      assetKind: result.kind,
      channel,
      cleanupCategory: "submission-session-asset-deleted",
      createdAt: now()
    });
    await store.writeDb(db);
    await finishCommittedAssetCleanup({
      store, db, asset: result, category: "submission-session-asset-deleted", deleteFile, uploadRoot, makeId, now, logger
    });
    res.json({ ok: true });
  }));

  function streamAsset(channel) {
    return asyncRoute(async (req, res, next) => {
      const disposition = req.query.download === "1" ? "attachment" : "inline";
      const range = req.get("range");
      const isVideo = req.params.kind === "creation_video";
      const recordAccess = !isVideo || !range || /^bytes=0-(?:\d+)?$/i.test(range.trim());
      const authorizeAndAudit = async () => {
        const db = await store.readDb();
        const { registration, asset } = authorizeRegistrationAssetRead({
          db, eventId: req.params.eventId, registrationId: req.params.registrationId,
          kind: req.params.kind, actor: req.user, channel
        });
        if (recordAccess) {
          const rangeStart = isVideo && range ? 0 : null;
          recordSubmissionAssetAudit(db, {
            actor: req.user,
            action: disposition === "attachment" ? "registration_asset_download" : "registration_asset_preview",
            eventId: req.params.eventId,
            organizationId: registration.organizationId || null,
            registrationId: registration.id,
            sessionId: asset.uploadSessionId,
            asset,
            assetKind: asset.kind,
            channel,
            access: disposition,
            rangeStart,
            createdAt: now()
          });
          await store.writeDb(db);
        }
        return { db, registration, asset };
      };
      const { db, registration, asset } = store.withMutationLock
        ? await store.withMutationLock(authorizeAndAudit)
        : await authorizeAndAudit();
      let response;
      try {
        response = await readSubmissionRange(asset, asset.mimeType === "video/mp4" ? range : null);
      } catch (error) {
        if (error?.code === "ENOENT") return res.status(404).json({ error: "作品文件缺失" });
        return next(error);
      }
      res.status(response.status).set({
        ...response.headers,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Disposition": disposition === "attachment"
          ? attachmentDisposition(submissionDownloadName(db, registration, asset))
          : `inline; filename="${safeFileName(asset.originalName)}"`
      });
      response.stream.on("error", next).pipe(res);
    });
  }

  router.get("/me/events/:eventId/registrations/:registrationId/assets/:kind", ...user, streamAsset("personal"));
  router.get("/organization/events/:eventId/registrations/:registrationId/assets/:kind", ...user, streamAsset("organization"));
  router.get("/admin/events/:eventId/registrations/:registrationId/assets/:kind", ...admin, streamAsset("admin"));

  router.get("/admin/events/:eventId/submission-assets", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    if (!(db.events || []).some((event) => event.id === req.params.eventId)) {
      return res.status(404).json({ error: "赛事不存在" });
    }
    const kind = String(req.query.kind || "");
    if (kind && !new Set(["artwork_image", "creation_video"]).has(kind)) {
      return res.status(422).json({ error: "作品材料类型不合法" });
    }
    const rows = adminEventAssets(db, req.params.eventId, { kind }).map(({ asset, registration }) => ({
      ...submissionAssetSummary(asset),
      registrationId: registration.id,
      athleteName: registration.athlete?.name || "",
      school: registration.athlete?.school || "",
      group: registration.group || "",
      projectName: (db.projects || []).find((project) => project.id === registration.projectId)?.name || "",
      downloadName: submissionDownloadName(db, registration, asset),
      downloadUrl: `/api/admin/events/${encodeURIComponent(req.params.eventId)}/registrations/${encodeURIComponent(registration.id)}/assets/${asset.kind}?download=1`
    }));
    res.json({ rows, total: rows.length });
  }));

  router.post("/admin/events/:eventId/submission-assets/download", ...admin, asyncRoute(async (req, res) => {
    const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [])];
    if (!ids.length || ids.length > 500) return res.status(422).json({ error: "请选择 1 至 500 个作品文件" });
    const db = await store.readDb();
    const selected = adminEventAssets(db, req.params.eventId).filter(({ asset }) => ids.includes(asset.id));
    if (selected.length !== ids.length) return res.status(422).json({ error: "部分作品文件不存在、已清理或不属于当前赛事" });
    if (selected.some(({ asset }) => !isControlledSubmissionAsset(asset, uploadRoot))) {
      return res.status(422).json({ error: "部分作品文件的存储记录无效，请联系平台维护人员" });
    }
    try {
      await Promise.all(selected.map(({ asset }) => fs.access(asset.filePath)));
    } catch {
      return res.status(404).json({ error: "部分作品文件已缺失，请刷新列表后处理" });
    }
    for (const { asset, registration } of selected) {
      recordSubmissionAssetAudit(db, {
        actor: req.user, action: "registration_asset_download", eventId: req.params.eventId,
        organizationId: registration.organizationId || null, registrationId: registration.id,
        sessionId: asset.uploadSessionId, asset, assetKind: asset.kind, channel: "admin", access: "bulk-download", createdAt: now()
      });
    }
    await store.writeDb(db);
    const event = (db.events || []).find((row) => row.id === req.params.eventId);
    const zipName = `${safeDownloadPart(event?.name, "赛事")}_作品材料.zip`;
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentDisposition(zipName),
      "Cache-Control": "private, no-store"
    });
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("warning", (error) => { if (error.code !== "ENOENT") res.destroy(error); });
    archive.on("error", (error) => res.destroy(error));
    archive.pipe(res);
    for (const { asset, registration } of selected) {
      archive.file(asset.filePath, { name: submissionDownloadName(db, registration, asset) });
    }
    await archive.finalize();
  }));

  router.post("/admin/events/:eventId/submission-assets/bulk-delete", ...admin, asyncRoute(async (req, res) => {
    const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [])];
    if (!ids.length || ids.length > 500) return res.status(422).json({ error: "请选择 1 至 500 个作品文件" });
    const db = await store.readDb();
    const selected = adminEventAssets(db, req.params.eventId).filter(({ asset }) => ids.includes(asset.id));
    if (selected.length !== ids.length) return res.status(422).json({ error: "部分作品文件不存在、已清理或不属于当前赛事" });
    const cleanedAt = now();
    for (const { asset, registration } of selected) {
      asset.cleanedAt = cleanedAt;
      asset.cleanupReason = "admin-classified-cleanup";
      recordSubmissionAssetAudit(db, {
        actor: req.user, action: "registration_asset_cleanup", eventId: req.params.eventId,
        organizationId: registration.organizationId || null, registrationId: registration.id,
        sessionId: asset.uploadSessionId, asset, assetKind: asset.kind, channel: "admin",
        cleanupCategory: "admin-classified-cleanup", createdAt: cleanedAt
      });
    }
    await store.writeDb(db);
    for (const { asset } of selected) {
      await finishCommittedAssetCleanup({
        store, db, asset, category: "admin-classified-cleanup", deleteFile, uploadRoot, makeId, now, logger
      });
    }
    res.json({ ok: true, cleanedCount: selected.length });
  }));

  return router;
}
