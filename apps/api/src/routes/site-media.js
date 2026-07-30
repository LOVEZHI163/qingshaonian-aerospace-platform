import express from "express";
import multer from "multer";
import path from "node:path";

import { SITE_ATTACHMENT_POLICY } from "../files/policy.js";
import { deleteSiteMedia, readSiteMedia, saveSiteMedia } from "../files/storage.js";
import { assertMediaUnreferenced } from "../services/site-media.js";

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

  router.post("/admin/site-media", ...admin, uploadOne, mutationAsyncRoute(async (req, res) => {
    if (!req.file) throw routeError(422, "媒体文件不能为空");
    const purpose = String(req.body.purpose || "").trim();
    if (!purpose) throw routeError(422, "媒体用途不能为空");
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

  router.delete("/admin/site-media/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const media = (db.mediaAssets || []).find((row) => row.id === req.params.id);
    if (!media) throw routeError(404, "媒体不存在");
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
    res.status(204).end();
  }));

  return router;
}
