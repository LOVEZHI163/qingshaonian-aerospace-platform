import express from "express";
import multer from "multer";
import path from "node:path";

import { SITE_ATTACHMENT_POLICY } from "../files/policy.js";
import { deleteSiteMedia, readSiteMedia, saveSiteMedia, siteMediaPolicyForPurpose } from "../files/storage.js";
import { assertMediaUnreferenced, mediaReferences, replaceMediaReferences } from "../services/site-media.js";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

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

  async function journalOrphan({ filePath, category, attempts = 1, error }) {
    if (!filePath) return;
    try {
      const latest = structuredClone(await store.readDb());
      const timestamp = now();
      latest.fileCleanupJournal ||= [];
      latest.fileCleanupJournal.push({
        id: makeId("CLN"),
        filePath,
        category,
        attempts,
        lastError: String(error?.message || error || "cleanup failed").slice(0, 500),
        createdAt: timestamp,
        lastAttemptAt: timestamp
      });
      await store.writeDb(latest);
    } catch { /* the primary persistence error remains authoritative */ }
  }

  async function rollbackStoredMedia(mediaId, stored, category) {
    if (!stored?.filePath) return;
    try {
      await storage.delete({ id: mediaId, ...stored });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await journalOrphan({
          filePath: path.dirname(stored.filePath),
          category,
          attempts: 1,
          error
        });
      }
    }
  }

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
        try {
          const latest = structuredClone(await store.readDb());
          const latestMarker = (latest.fileCleanupJournal || []).find((row) => row.id === marker.id);
          if (latestMarker) {
            latestMarker.attempts += 1;
            latestMarker.lastError = String(error?.message || error).slice(0, 500);
            latestMarker.lastAttemptAt = now();
            await store.writeDb(latest);
          }
        } catch { /* retain the pending marker written before physical cleanup */ }
        error.cleanupPending = true;
        throw error;
      }
    }

    const latest = structuredClone(await store.readDb());
    latest.mediaAssets = (latest.mediaAssets || []).filter((row) => row.id !== media.id);
    latest.fileCleanupJournal = (latest.fileCleanupJournal || []).filter((row) => row.id !== marker.id);
    await store.writeDb(latest);
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
        try { await storage.delete({ id: mediaId, ...stored }); }
        catch (rollbackError) {
          if (rollbackError?.code !== "ENOENT") {
            cleanupError = rollbackError;
            cleanupAttempts += 1;
          }
        }
      }
      if (orphan?.filePath && cleanupError) {
        await journalOrphan({
          filePath: stored ? path.dirname(orphan.filePath) : orphan.filePath,
          category: "site-media-new",
          attempts: cleanupAttempts,
          error: cleanupError
        });
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
    const managed = String(req.query.managed || "") === "1"
      || req.query.page !== undefined
      || req.query.purpose !== undefined
      || req.query.eventId !== undefined
      || req.query.reference !== undefined
      || req.query.referenceStatus !== undefined;
    const limit = req.query.limit === undefined ? (managed ? 24 : 100) : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw routeError(422, "媒体数量范围为 1 至 100");
    const kind = String(req.query.kind || "").trim();
    if (kind && kind !== "image") throw routeError(422, "媒体类型筛选无效");
    const query = String(req.query.q || "").trim().toLowerCase();
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isInteger(page) || page < 1) throw routeError(422, "媒体页码无效");
    const purpose = String(req.query.purpose || "").trim();
    const eventId = String(req.query.eventId || "").trim();
    const requestedReferenceStatus = String(req.query.reference ?? req.query.referenceStatus ?? "").trim();
    const referenceStatus = requestedReferenceStatus === "all" ? "" : requestedReferenceStatus;
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
          referenced: references.length > 0,
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
    let newMedia;
    let migratedReferences = 0;
    let marker;
    let oldRow;
    try {
      stored = await storage.save({ mediaId, file: req.file, purpose: oldMedia.purpose });
      if (!IMAGE_MIME_TYPES.has(stored.mimeType)) throw routeError(422, "替换文件必须为 PNG、JPEG 或 WebP 图片");
      const db = structuredClone(originalDb);
      const timestamp = now();
      newMedia = {
        id: mediaId,
        eventId: oldMedia.eventId || null,
        purpose: oldMedia.purpose,
        visibility: oldMedia.visibility,
        ...stored,
        createdBy: req.user.id,
        createdAt: timestamp,
        cleanedAt: null
      };
      migratedReferences = replaceMediaReferences(db, oldMedia.id, newMedia.id);
      db.mediaAssets ||= [];
      db.mediaAssets.push(newMedia);
      oldRow = db.mediaAssets.find((row) => row.id === oldMedia.id);
      oldRow.cleanedAt = timestamp;
      marker = {
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
    } catch (error) {
      if (stored?.filePath) {
        await rollbackStoredMedia(mediaId, stored, "site-media-replace-new");
      } else if (error?.cleanupTarget?.filePath && error?.cleanupError) {
        await journalOrphan({
          filePath: error.cleanupTarget.filePath,
          category: "site-media-replace-new",
          attempts: Number(error.cleanupTarget.cleanupAttempts || 0),
          error: error.cleanupError
        });
      }
      throw uploadError(error);
    }

    let cleanupWarning = null;
    let cleanupError = null;
    try {
      await storage.delete(oldRow);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        cleanupWarning = "旧图片等待后台清理";
        cleanupError = error;
      }
    }
    try {
      const latest = structuredClone(await store.readDb());
      const latestMarker = (latest.fileCleanupJournal || []).find((row) => row.id === marker.id);
      if (cleanupError) {
        if (latestMarker) {
          latestMarker.attempts += 1;
          latestMarker.lastError = String(cleanupError?.message || cleanupError).slice(0, 500);
          latestMarker.lastAttemptAt = now();
        }
      } else {
        latest.mediaAssets = (latest.mediaAssets || []).filter((row) => row.id !== oldRow.id);
        latest.fileCleanupJournal = (latest.fileCleanupJournal || []).filter((row) => row.id !== marker.id);
      }
      await store.writeDb(latest);
    } catch {
      cleanupWarning = "旧图片清理状态等待后台确认";
    }
    res.status(201).json({ row: adminMediaDto(newMedia), migratedReferences, cleanupWarning });
  }));

  router.post("/admin/site-media/bulk-delete", ...admin, mutationAsyncRoute(async (req, res) => {
    if (!Array.isArray(req.body?.ids) || req.body.ids.length < 1 || req.body.ids.length > 100) {
      throw routeError(422, "请选择 1 至 100 张图片");
    }
    const ids = [...new Set(req.body.ids.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw routeError(422, "请选择需要删除的图片");
    const deleted = [];
    const cleanupPending = [];
    const skipped = [];
    for (const id of ids) {
      const db = await store.readDb();
      const media = (db.mediaAssets || []).find((row) => row.id === id && !row.cleanedAt);
      if (!media) {
        skipped.push({ id, code: "MEDIA_NOT_FOUND", reason: "媒体不存在" });
        continue;
      }
      try {
        await removeMedia(db, media);
        deleted.push(id);
      } catch (error) {
        if (error?.cleanupPending) {
          cleanupPending.push({ id, code: "CLEANUP_PENDING", reason: "已从媒体库移除，物理文件等待后台清理" });
          continue;
        }
        skipped.push({
          id,
          code: error?.code || "DELETE_FAILED",
          reason: error?.message || "删除失败",
          ...(error?.code === "MEDIA_IN_USE" ? { references: mediaReferences(db, id) } : {})
        });
      }
    }
    res.json({ deleted, cleanupPending, skipped });
  }));

  router.delete("/admin/site-media/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const media = (db.mediaAssets || []).find((row) => row.id === req.params.id);
    if (!media) throw routeError(404, "媒体不存在");
    try {
      await removeMedia(db, media);
      res.status(204).end();
    } catch (error) {
      if (!error?.cleanupPending) throw error;
      res.status(202).json({ cleanupPending: true, message: "图片已从媒体库移除，物理文件等待后台清理" });
    }
  }));

  return router;
}
