import express from "express";
import multer from "multer";
import path from "node:path";

import { SITE_ATTACHMENT_POLICY } from "../files/policy.js";
import { deleteSiteMedia, readSiteMedia, saveSiteMedia, siteMediaPolicyForPurpose } from "../files/storage.js";
import { assertMediaUnreferenced, mediaReferences, replaceMediaReferences } from "../services/site-media.js";

function routeError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function adminMediaDto(row) {
  return {
    id: row.id,
    eventId: row.eventId ?? null,
    purpose: row.purpose,
    visibility: row.visibility,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width ?? null,
    height: row.height ?? null,
    variants: Object.fromEntries(Object.entries(row.variants || {}).map(([name, variant]) => [name, {
      mimeType: variant.mimeType,
      sizeBytes: variant.sizeBytes,
      width: variant.width ?? null,
      height: variant.height ?? null
    }]))
  };
}

function uploadError(error) {
  if (error?.status) return error;
  if (/^(A non-empty|File exceeds|Unsupported file signature|Invalid PDF signature)/.test(String(error?.message || ""))) {
    error.status = 422;
  }
  return error;
}

export function createSiteMediaRouter({
  store,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute = asyncRoute,
  makeId,
  now,
  storage = { save: saveSiteMedia, read: readSiteMedia, delete: deleteSiteMedia }
}) {
  const router = express.Router();
  const admin = [requireAdmin, requirePasswordReady];
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SITE_ATTACHMENT_POLICY.maxBytes + 1 } });
  const uploadOne = (req, res, next) => upload.single("file")(req, res, (error) => {
    if (!error) return next();
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 422).json({ error: "媒体文件上传无效" });
  });

  async function removeMedia(db, media) {
    assertMediaUnreferenced(db, media.id);
    const timestamp = now();
    const marker = {
      id: makeId("CLN"),
      filePath: path.dirname(media.filePath),
      category: "site-media",
      attempts: 0,
      lastError: "pending cleanup",
      createdAt: timestamp,
      lastAttemptAt: timestamp
    };
    db.fileCleanupJournal ||= [];
    media.cleanedAt = timestamp;
    db.fileCleanupJournal.push(marker);
    await store.writeDb(db);

    try {
      await storage.delete(media);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        marker.attempts += 1;
        marker.lastError = String(error?.message || error).slice(0, 500);
        marker.lastAttemptAt = now();
        await store.writeDb(db);
        throw error;
      }
    }

    db.mediaAssets = db.mediaAssets.filter((row) => row.id !== media.id);
    db.fileCleanupJournal = db.fileCleanupJournal.filter((row) => row.id !== marker.id);
    await store.writeDb(db);
  }

  router.post("/admin/site-media", ...admin, uploadOne, mutationAsyncRoute(async (req, res) => {
    if (!req.file) throw routeError(422, "媒体文件不能为空");
    const purpose = String(req.body.purpose || "").trim();
    if (!purpose) throw routeError(422, "媒体用途不能为空");
    siteMediaPolicyForPurpose(purpose);
    const mediaId = makeId("M");
    const originalDb = await store.readDb();
    let stored;
    try {
      stored = await storage.save({ mediaId, file: req.file, purpose });
      const db = structuredClone(originalDb);
      const row = {
        id: mediaId,
        eventId: req.body.eventId || null,
        purpose,
        visibility: "draft",
        ...stored,
        createdBy: req.user.id,
        createdAt: now(),
        cleanedAt: null
      };
      db.mediaAssets ||= [];
      db.mediaAssets.push(row);
      await store.writeDb(db);
      res.status(201).json({ row: adminMediaDto(row) });
    } catch (error) {
      const orphan = stored || error.cleanupTarget;
      let cleanupError = error.cleanupError;
      let cleanupAttempts = Number(orphan?.cleanupAttempts || 0);
      if (stored?.filePath) {
        try {
          await storage.delete({ id: mediaId, ...stored });
        } catch (rollbackError) {
          if (rollbackError?.code !== "ENOENT") {
            cleanupError = rollbackError;
            cleanupAttempts += 1;
          }
        }
      }
      if (orphan?.filePath && cleanupError) {
        const rollback = structuredClone(originalDb);
        const timestamp = now();
        rollback.fileCleanupJournal ||= [];
        rollback.fileCleanupJournal.push({
          id: makeId("CLN"),
          filePath: stored ? path.dirname(orphan.filePath) : orphan.filePath,
          category: "site-media-new",
          attempts: cleanupAttempts,
          lastError: String(cleanupError?.message || cleanupError).slice(0, 500),
          createdAt: timestamp,
          lastAttemptAt: timestamp
        });
        try { await store.writeDb(rollback); } catch { /* primary persistence error remains authoritative */ }
      }
      throw uploadError(error);
    }
  }));

  router.get("/public/media/:id", asyncRoute(async (req, res) => {
    const variant = String(req.query.variant || "original");
    if (!["original", "mobile", "desktop"].includes(variant)) throw routeError(422, "媒体变体无效");
    const db = await store.readDb();
    const media = (db.mediaAssets || []).find((row) => row.id === req.params.id);
    if (!media || media.visibility !== "public" || media.cleanedAt) throw routeError(404, "媒体不存在");
    let file;
    try {
      file = await storage.read(media, variant);
    } catch (error) {
      if (error?.code === "ENOENT" || /escapes upload root|escapes its media directory|symbolic link|changed during validation/i.test(String(error?.message || ""))) {
        throw routeError(404, "媒体文件不存在");
      }
      throw error;
    }
    res
      .type(file.mimeType)
      .set("X-Content-Type-Options", "nosniff")
      .set("Cache-Control", "public, max-age=604800")
      .send(file.buffer);
  }));

  router.get("/admin/site-media", ...admin, asyncRoute(async (req, res) => {
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw routeError(422, "媒体数量范围为 1 至 100");
    const kind = String(req.query.kind || "").trim();
    if (kind && kind !== "image") throw routeError(422, "媒体类型筛选无效");
    const query = String(req.query.q || "").trim().toLowerCase();
    const managed = String(req.query.managed || "") === "1";
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isInteger(page) || page < 1) throw routeError(422, "媒体页码无效");
    const purpose = String(req.query.purpose || "").trim();
    const eventId = String(req.query.eventId || "").trim();
    const referenceStatus = String(req.query.referenceStatus || "").trim();
    if (referenceStatus && !["referenced", "unreferenced"].includes(referenceStatus)) throw routeError(422, "引用状态筛选无效");
    const db = await store.readDb();
    const allImages = (db.mediaAssets || [])
      .filter((row) => !row.cleanedAt)
      .filter((row) => ["image/png", "image/jpeg", "image/webp"].includes(row.mimeType))
      .map((row) => ({ ...row, references: mediaReferences(db, row.id) }));
    const summary = {
      total: allImages.length,
      sizeBytes: allImages.reduce((total, row) => total + Number(row.sizeBytes || 0), 0),
      referenced: allImages.filter((row) => row.references.length > 0).length,
      unreferenced: allImages.filter((row) => row.references.length === 0).length
    };
    const filtered = allImages
      .filter((row) => !query || [row.id, row.originalName].some((value) => String(value || "").toLowerCase().includes(query)))
      .filter((row) => !purpose || row.purpose === purpose)
      .filter((row) => !eventId || (eventId === "none" ? !row.eventId : row.eventId === eventId))
      .filter((row) => !referenceStatus || (referenceStatus === "referenced" ? row.references.length > 0 : row.references.length === 0))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id)));
    const offset = managed ? (page - 1) * limit : 0;
    const rows = filtered
      .slice(offset, offset + limit)
      .map(({ id, eventId: rowEventId, purpose: rowPurpose, visibility, originalName, mimeType, sizeBytes, width, height, createdAt, references }) => ({
        id,
        eventId: rowEventId,
        purpose: rowPurpose,
        visibility,
        originalName,
        mimeType,
        sizeBytes,
        width,
        height,
        createdAt,
        previewUrl: `/api/admin/site-media/${encodeURIComponent(id)}/preview`,
        ...(managed ? {
          downloadUrl: `/api/admin/site-media/${encodeURIComponent(id)}/download`,
          references,
          referenceCount: references.length,
          canDelete: references.length === 0
        } : {})
      }));
    res.json(managed ? {
      rows,
      pagination: { page, limit, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / limit)) },
      summary
    } : { rows });
  }));

  router.get("/admin/site-media/:id/preview", ...admin, asyncRoute(async (req, res) => {
    const variant = String(req.query.variant || "original");
    if (!["original", "mobile", "desktop"].includes(variant)) throw routeError(422, "媒体变体无效");
    const db = await store.readDb();
    const media = (db.mediaAssets || []).find((row) => row.id === req.params.id);
    if (!media || media.cleanedAt) throw routeError(404, "媒体不存在");
    let file;
    try {
      file = await storage.read(media, variant);
    } catch (error) {
      if (error?.code === "ENOENT" || /escapes upload root|escapes its media directory|symbolic link|changed during validation/i.test(String(error?.message || ""))) {
        throw routeError(404, "媒体文件不存在");
      }
      throw error;
    }
    res
      .type(file.mimeType)
      .set("X-Content-Type-Options", "nosniff")
      .set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" })
      .send(file.buffer);
  }));

  router.get("/admin/site-media/:id/download", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const media = (db.mediaAssets || []).find((row) => row.id === req.params.id);
    if (!media || media.cleanedAt) throw routeError(404, "媒体不存在");
    let file;
    try {
      file = await storage.read(media, "original");
    } catch (error) {
      if (error?.code === "ENOENT" || /escapes upload root|escapes its media directory|symbolic link|changed during validation/i.test(String(error?.message || ""))) {
        throw routeError(404, "媒体文件不存在");
      }
      throw error;
    }
    const fallback = `${media.id}.${media.mimeType?.split("/")[1] || "bin"}`;
    const filename = String(media.originalName || fallback).replace(/[\r\n]/g, "");
    res
      .type(file.mimeType)
      .set("X-Content-Type-Options", "nosniff")
      .set("Cache-Control", "private, no-store")
      .set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(file.buffer);
  }));

  router.post("/admin/site-media/:id/replace", ...admin, uploadOne, mutationAsyncRoute(async (req, res) => {
    if (!req.file) throw routeError(422, "请选择替换图片");
    const originalDb = await store.readDb();
    const oldMedia = (originalDb.mediaAssets || []).find((row) => row.id === req.params.id && !row.cleanedAt);
    if (!oldMedia) throw routeError(404, "媒体不存在");
    if (!["image/png", "image/jpeg", "image/webp"].includes(oldMedia.mimeType)) throw routeError(422, "仅支持替换图片");
    const mediaId = makeId("M");
    let stored;
    let committed = false;
    try {
      stored = await storage.save({ mediaId, file: req.file, purpose: oldMedia.purpose });
      const db = structuredClone(originalDb);
      const timestamp = now();
      const newMedia = {
        id: mediaId,
        eventId: oldMedia.eventId || null,
        purpose: oldMedia.purpose,
        visibility: oldMedia.visibility,
        ...stored,
        createdBy: req.user.id,
        createdAt: timestamp,
        cleanedAt: null
      };
      const migratedReferences = replaceMediaReferences(db, oldMedia.id, newMedia.id);
      db.mediaAssets ||= [];
      db.mediaAssets.push(newMedia);
      const oldRow = db.mediaAssets.find((row) => row.id === oldMedia.id);
      oldRow.cleanedAt = timestamp;
      const marker = {
        id: makeId("CLN"),
        filePath: path.dirname(oldRow.filePath),
        category: "site-media-replaced",
        attempts: 0,
        lastError: "pending cleanup",
        createdAt: timestamp,
        lastAttemptAt: timestamp
      };
      db.fileCleanupJournal ||= [];
      db.fileCleanupJournal.push(marker);
      await store.writeDb(db);
      committed = true;

      let cleanupWarning = null;
      try {
        await storage.delete(oldRow);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          marker.attempts += 1;
          marker.lastError = String(error?.message || error).slice(0, 500);
          marker.lastAttemptAt = now();
          cleanupWarning = "旧图片等待后台清理";
          await store.writeDb(db);
        }
      }
      if (!cleanupWarning) {
        db.mediaAssets = db.mediaAssets.filter((row) => row.id !== oldRow.id);
        db.fileCleanupJournal = db.fileCleanupJournal.filter((row) => row.id !== marker.id);
        await store.writeDb(db);
      }
      res.status(201).json({ row: adminMediaDto(newMedia), migratedReferences, cleanupWarning });
    } catch (error) {
      if (!committed && stored?.filePath) {
        try { await storage.delete({ id: mediaId, ...stored }); } catch { /* cleanup journal will catch future orphan scans */ }
      }
      throw uploadError(error);
    }
  }));

  router.post("/admin/site-media/bulk-delete", ...admin, mutationAsyncRoute(async (req, res) => {
    if (!Array.isArray(req.body?.ids) || req.body.ids.length < 1 || req.body.ids.length > 100) {
      throw routeError(422, "请选择 1 至 100 张图片");
    }
    const ids = [...new Set(req.body.ids.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw routeError(422, "请选择需要删除的图片");
    const db = await store.readDb();
    const deleted = [];
    const skipped = [];
    for (const id of ids) {
      const media = (db.mediaAssets || []).find((row) => row.id === id && !row.cleanedAt);
      if (!media) {
        skipped.push({ id, code: "MEDIA_NOT_FOUND", reason: "媒体不存在" });
        continue;
      }
      try {
        await removeMedia(db, media);
        deleted.push(id);
      } catch (error) {
        if (error?.code === "MEDIA_IN_USE") {
          skipped.push({ id, code: error.code, reason: error.message, references: mediaReferences(db, id) });
          continue;
        }
        throw error;
      }
    }
    res.json({ deleted, skipped });
  }));

  router.delete("/admin/site-media/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const media = (db.mediaAssets || []).find((row) => row.id === req.params.id);
    if (!media) throw routeError(404, "媒体不存在");
    await removeMedia(db, media);
    res.status(204).end();
  }));

  return router;
}
