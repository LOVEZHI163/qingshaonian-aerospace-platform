import express from "express";

import { readStagedImportImage } from "../files/site-content-import-storage.js";
import {
  cancelContentImport,
  commitContentImport,
  contentImportBatchForAdmin,
  deleteContentImportImage,
  inspectContentImport,
  retryContentImportImage
} from "../services/site-content-imports.js";

function routeError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function imageDto(image) {
  return {
    id: image.id,
    originalUrl: image.originalUrl,
    resolvedUrl: image.resolvedUrl,
    originalName: image.originalName,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
    status: image.status,
    reasonCode: image.reasonCode,
    reason: image.reason,
    coverCandidate: Boolean(image.coverCandidate),
    alt: image.alt || "",
    title: image.title || ""
  };
}

function previewHtml(batch) {
  const byId = new Map((batch.images || []).map((image) => [image.id, image]));
  return String(batch.bodyTemplateHtml || "").replace(
    /<img\b[^>]*\bsrc=(['"])@@SITE_IMPORT_IMAGE:([A-Za-z0-9_-]+)@@\1[^>]*>/gi,
    (tag, _quote, imageId) => {
      const image = byId.get(imageId);
      if (!image || image.status !== "ready") return "";
      return tag.replace(
        `@@SITE_IMPORT_IMAGE:${imageId}@@`,
        `/api/admin/content-imports/${encodeURIComponent(batch.id)}/images/${encodeURIComponent(imageId)}`
      );
    }
  );
}

function batchDto(batch) {
  return {
    id: batch.id,
    sourceUrl: batch.sourceUrl,
    sourceType: batch.sourceType,
    sourceName: batch.sourceName,
    sourceAuthor: batch.sourceAuthor,
    sourcePublishedAt: batch.sourcePublishedAt,
    title: batch.title,
    summary: batch.summary,
    previewHtml: previewHtml(batch),
    warnings: batch.warnings || [],
    images: (batch.images || []).map(imageDto),
    status: batch.status,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt
  };
}

export function createSiteContentImportRouter({
  store,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute = asyncRoute,
  makeId,
  now,
  fetchResource,
  readStorageStatus,
  services = {},
  stagedStorage = { read: readStagedImportImage }
}) {
  const router = express.Router();
  const admin = [requireAdmin, requirePasswordReady];
  const operations = {
    inspect: services.inspect || inspectContentImport,
    batchForAdmin: services.batchForAdmin || contentImportBatchForAdmin,
    retry: services.retry || retryContentImportImage,
    deleteImage: services.deleteImage || deleteContentImportImage,
    commit: services.commit || commitContentImport,
    cancel: services.cancel || cancelContentImport
  };
  const deps = { store, makeId, now, fetchResource, readStorageStatus };

  router.post("/admin/content-imports/inspect", ...admin, mutationAsyncRoute(async (req, res) => {
    const row = await operations.inspect(deps, { adminId: req.user.id, sourceUrl: req.body?.sourceUrl });
    res.status(201).json({ row: batchDto(row) });
  }));

  router.get("/admin/content-imports/:batchId", ...admin, asyncRoute(async (req, res) => {
    const row = operations.batchForAdmin(await store.readDb(), {
      adminId: req.user.id,
      batchId: req.params.batchId,
      now: now()
    });
    res.json({ row: batchDto(row) });
  }));

  router.get("/admin/content-imports/:batchId/images/:imageId", ...admin, asyncRoute(async (req, res) => {
    const batch = operations.batchForAdmin(await store.readDb(), {
      adminId: req.user.id,
      batchId: req.params.batchId,
      now: now()
    });
    const image = (batch.images || []).find((row) => row.id === req.params.imageId);
    if (!image || image.status !== "ready" || !image.stagePath) {
      throw routeError(404, "转载图片不存在", "IMPORT_IMAGE_NOT_FOUND");
    }
    let buffer;
    try {
      buffer = await stagedStorage.read({ batchId: batch.id, imageId: image.id, stagePath: image.stagePath });
    } catch (error) {
      if (error?.code === "ENOENT") throw routeError(404, "转载图片不存在", "IMPORT_IMAGE_NOT_FOUND");
      throw error;
    }
    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(image.originalName || "image")}`);
    res.send(buffer);
  }));

  router.post("/admin/content-imports/:batchId/images/:imageId/retry", ...admin, mutationAsyncRoute(async (req, res) => {
    const row = await operations.retry(deps, {
      adminId: req.user.id,
      batchId: req.params.batchId,
      imageId: req.params.imageId
    });
    res.json({ row: imageDto(row) });
  }));

  router.delete("/admin/content-imports/:batchId/images/:imageId", ...admin, mutationAsyncRoute(async (req, res) => {
    const row = await operations.deleteImage(deps, {
      adminId: req.user.id,
      batchId: req.params.batchId,
      imageId: req.params.imageId
    });
    res.json({ row: imageDto(row) });
  }));

  router.post("/admin/content-imports/:batchId/commit", ...admin, mutationAsyncRoute(async (req, res) => {
    const row = await operations.commit(deps, {
      ...(req.body || {}),
      adminId: req.user.id,
      batchId: req.params.batchId
    });
    res.status(201).json({ row });
  }));

  router.delete("/admin/content-imports/:batchId", ...admin, mutationAsyncRoute(async (req, res) => {
    const row = await operations.cancel(deps, { adminId: req.user.id, batchId: req.params.batchId });
    res.json({ row: batchDto(row) });
  }));

  return router;
}
