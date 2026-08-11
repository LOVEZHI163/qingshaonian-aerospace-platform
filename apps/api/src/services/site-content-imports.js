import path from "node:path";

import { sanitizeContentHtml } from "../content/sanitize.js";
import {
  deleteStagedImportBatch,
  deleteStagedImportImage,
  readStagedImportImage,
  saveStagedImportImage
} from "../files/site-content-import-storage.js";
import { deleteSiteMedia, saveSiteMedia } from "../files/storage.js";
import { recordAudit } from "./audit.js";
import { extractImportedArticle } from "./site-content-import/article-extractor.js";
import { retryArticleImage, stageArticleImages } from "./site-content-import/image-import.js";
import { fetchPublicResource } from "./site-content-import/public-fetch.js";
import { normalizeImportUrl, sourceUrlFingerprint } from "./site-content-import/url-policy.js";
import { createContent } from "./site-admin.js";
import { assertContentImportCapacity, readStorageStatus } from "./system-storage.js";

const BATCH_TTL_MS = 30 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const rateWindows = new WeakMap();

function importError(status, message, code, details) {
  return Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
}

function timestamp(deps) {
  const value = new Date(deps.now());
  if (!Number.isFinite(value.getTime())) throw new TypeError("now must return a valid date");
  return value;
}

function defaults(deps) {
  return {
    ...deps,
    fetchResource: deps.fetchResource || fetchPublicResource,
    extractArticle: deps.extractArticle || extractImportedArticle,
    stageImages: deps.stageImages || stageArticleImages,
    retryImage: deps.retryImage || retryArticleImage,
    readStorageStatus: deps.readStorageStatus || (() => readStorageStatus({
      uploadRoot: process.env.UPLOAD_ROOT || "/data/uploads"
    })),
    stagedStorage: deps.stagedStorage || {
      save: saveStagedImportImage,
      read: readStagedImportImage,
      deleteImage: deleteStagedImportImage,
      deleteBatch: deleteStagedImportBatch
    },
    siteMediaStorage: deps.siteMediaStorage || { save: saveSiteMedia, delete: deleteSiteMedia }
  };
}

function assertRateLimit(deps, adminId, nowMs) {
  let byAdmin = rateWindows.get(deps.store);
  if (!byAdmin) {
    byAdmin = new Map();
    rateWindows.set(deps.store, byAdmin);
  }
  const active = (byAdmin.get(adminId) || []).filter((value) => nowMs - value < RATE_WINDOW_MS);
  if (active.length >= RATE_LIMIT) {
    throw importError(429, "转载检查过于频繁，请稍后再试", "IMPORT_RATE_LIMITED");
  }
  active.push(nowMs);
  byAdmin.set(adminId, active);
}

function duplicateSource(db, fingerprint) {
  return (db.contentPosts || []).find((post) => post.sourceUrlFingerprint === fingerprint) || null;
}

function auditActor(db, adminId) {
  return (db.users || []).find((user) => user.id === adminId) || { id: adminId, name: "管理员" };
}

function assertNotDuplicate(db, normalizedUrl) {
  const fingerprint = sourceUrlFingerprint(normalizedUrl);
  const existing = duplicateSource(db, fingerprint);
  if (existing) {
    throw importError(409, "该来源链接已经转载过", "IMPORT_DUPLICATE_SOURCE", { contentId: existing.id });
  }
  return fingerprint;
}

function warningRows(images, storageWarning) {
  const warnings = images
    .filter((image) => image.status !== "ready")
    .map((image) => ({ code: image.reasonCode, message: image.reason, imageId: image.id }));
  if (storageWarning) warnings.unshift({ code: "IMPORT_STORAGE_WARNING", message: storageWarning });
  return warnings;
}

function batchByOwner(db, batchId, adminId, nowValue) {
  const batch = (db.siteContentImportBatches || []).find((row) => row.id === batchId && row.createdBy === adminId);
  if (!batch) throw importError(404, "转载批次不存在", "IMPORT_BATCH_NOT_FOUND");
  if (batch.status === "expired" || Date.parse(batch.expiresAt) <= nowValue.getTime()) {
    throw importError(410, "转载批次已过期，请重新检查链接", "IMPORT_BATCH_EXPIRED");
  }
  if (batch.status !== "ready") throw importError(409, "转载批次已经处理", "IMPORT_BATCH_STATE_CONFLICT");
  return batch;
}

function imageById(batch, imageId) {
  const image = (batch.images || []).find((row) => row.id === imageId);
  if (!image) throw importError(404, "转载图片不存在", "IMPORT_IMAGE_NOT_FOUND");
  return image;
}

function cleanupMarker(deps, target, nowValue) {
  return {
    id: deps.makeId("CLN"),
    filePath: target.filePath,
    category: target.category,
    attempts: Number(target.cleanupAttempts || 0),
    lastError: String(target.lastError || "pending cleanup").slice(0, 500),
    createdAt: nowValue.toISOString(),
    lastAttemptAt: nowValue.toISOString()
  };
}

async function persistCleanupTargets(deps, baseDb, targets, nowValue) {
  if (!targets.length) return;
  const rollback = structuredClone(baseDb);
  rollback.fileCleanupJournal ||= [];
  for (const target of targets) rollback.fileCleanupJournal.push(cleanupMarker(deps, target, nowValue));
  try { await deps.store.writeDb(rollback); } catch { /* primary failure remains authoritative */ }
}

async function cleanupSavedMedia(deps, savedMedia, originalDb, nowValue) {
  const targets = [];
  for (const media of savedMedia) {
    try {
      await deps.siteMediaStorage.delete(media);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        targets.push({
          filePath: path.dirname(media.filePath),
          category: "site-media-new",
          cleanupAttempts: 1,
          lastError: String(error?.message || error)
        });
      }
    }
  }
  await persistCleanupTargets(deps, originalDb, targets, nowValue);
}

export async function inspectContentImport(rawDeps, { adminId, sourceUrl }) {
  const deps = defaults(rawDeps);
  const nowValue = timestamp(deps);
  const normalizedInput = normalizeImportUrl(sourceUrl);
  assertRateLimit(deps, adminId, nowValue.getTime());
  const originalDb = await deps.store.readDb();
  assertNotDuplicate(originalDb, normalizedInput);

  const storage = assertContentImportCapacity(await deps.readStorageStatus());
  const fetched = await deps.fetchResource(normalizedInput, { expected: "html", maxBytes: 5 * 1024 * 1024 });
  const article = deps.extractArticle({ html: fetched.buffer.toString("utf8"), finalUrl: fetched.finalUrl });
  const normalizedFinal = normalizeImportUrl(fetched.finalUrl);
  assertNotDuplicate(originalDb, normalizedFinal);
  const normalizedCanonical = normalizeImportUrl(article.canonicalUrl || normalizedFinal);
  const fingerprint = assertNotDuplicate(originalDb, normalizedCanonical);
  const batchId = deps.makeId("SCI");
  const images = await deps.stageImages({
    batchId,
    candidates: article.images,
    fetchResource: deps.fetchResource,
    saveImage: deps.stagedStorage.save
  });
  const batch = {
    id: batchId,
    createdBy: adminId,
    sourceUrl: normalizedCanonical,
    normalizedSourceUrl: normalizedCanonical,
    sourceUrlFingerprint: fingerprint,
    sourceType: article.sourceType,
    sourceName: article.sourceName || "",
    sourceAuthor: article.sourceAuthor || "",
    sourcePublishedAt: article.sourcePublishedAt || null,
    title: article.title,
    summary: article.summary || "",
    bodyTemplateHtml: article.bodyTemplateHtml,
    warnings: warningRows(images, storage.warning),
    images,
    status: "ready",
    createdAt: nowValue.toISOString(),
    expiresAt: new Date(nowValue.getTime() + BATCH_TTL_MS).toISOString()
  };
  const db = structuredClone(originalDb);
  db.siteContentImportBatches ||= [];
  db.siteContentImportBatches.push(batch);
  recordAudit(db, {
    actor: auditActor(db, adminId), action: "content.import.inspect", targetType: "content-import",
    targetId: batch.id, summary: `检查转载来源：${batch.sourceName || batch.sourceUrl}`, createdAt: nowValue.toISOString()
  });
  try {
    await deps.store.writeDb(db);
  } catch (error) {
    try { await deps.stagedStorage.deleteBatch({ batchId }); } catch { /* no persisted batch points at staging */ }
    throw error;
  }
  return structuredClone(batch);
}

export async function retryContentImportImage(rawDeps, { adminId, batchId, imageId }) {
  const deps = defaults(rawDeps);
  const nowValue = timestamp(deps);
  assertContentImportCapacity(await deps.readStorageStatus());
  const db = await deps.store.readDb();
  const batch = batchByOwner(db, batchId, adminId, nowValue);
  imageById(batch, imageId);
  const result = await deps.retryImage({
    batch,
    imageId,
    fetchResource: deps.fetchResource,
    saveImage: deps.stagedStorage.save
  });
  batch.warnings = warningRows(batch.images, null);
  recordAudit(db, {
    actor: auditActor(db, adminId), action: "content.import.image-retry", targetType: "content-import",
    targetId: batch.id, summary: `重试转载图片：${imageId}`, createdAt: nowValue.toISOString()
  });
  await deps.store.writeDb(db);
  return structuredClone(result);
}

export async function deleteContentImportImage(rawDeps, { adminId, batchId, imageId }) {
  const deps = defaults(rawDeps);
  const nowValue = timestamp(deps);
  const db = await deps.store.readDb();
  const batch = batchByOwner(db, batchId, adminId, nowValue);
  const image = imageById(batch, imageId);
  if (image.stagePath && image.status === "ready") {
    await deps.stagedStorage.deleteImage({ batchId, imageId, stagePath: image.stagePath });
  }
  Object.assign(image, { status: "deleted", stagePath: null, reasonCode: "IMPORT_IMAGE_DELETED", reason: "管理员已删除" });
  batch.warnings = warningRows(batch.images, null);
  recordAudit(db, {
    actor: auditActor(db, adminId), action: "content.import.image-delete", targetType: "content-import",
    targetId: batch.id, summary: `删除转载图片：${imageId}`, createdAt: nowValue.toISOString()
  });
  await deps.store.writeDb(db);
  return structuredClone(image);
}

function selectedReadyImages(batch, selectedImageIds) {
  if (!Array.isArray(selectedImageIds)) throw importError(422, "请选择需要保留的正文图片", "IMPORT_IMAGE_SELECTION_INVALID");
  const selected = new Set(selectedImageIds);
  if (selected.size !== selectedImageIds.length) throw importError(422, "正文图片不能重复选择", "IMPORT_IMAGE_SELECTION_INVALID");
  const images = selectedImageIds.map((id) => imageById(batch, id));
  if (images.some((image) => image.status !== "ready" || !image.stagePath)) {
    throw importError(422, "只能提交检查成功且未删除的图片", "IMPORT_IMAGE_SELECTION_INVALID");
  }
  return images;
}

function rewriteImageTokens(template, selected, mediaByImage) {
  const selectedIds = new Set(selected.map((image) => image.id));
  const html = String(template || "").replace(
    /<img\b[^>]*\bsrc=(['"])@@SITE_IMPORT_IMAGE:([A-Za-z0-9_-]+)@@\1[^>]*>/gi,
    (tag, _quote, imageId) => {
      if (!selectedIds.has(imageId)) return "";
      return tag.replace(`@@SITE_IMPORT_IMAGE:${imageId}@@`, `/api/public/media/${mediaByImage.get(imageId)}`);
    }
  );
  return sanitizeContentHtml(html);
}

async function saveImportedMedia(deps, { image, purpose, mediaId, adminId, nowValue }) {
  const buffer = await deps.stagedStorage.read({
    batchId: image.batchId,
    imageId: image.id,
    stagePath: image.stagePath
  });
  const stored = await deps.siteMediaStorage.save({
    mediaId,
    purpose,
    file: { buffer, originalname: image.originalName, mimetype: image.mimeType }
  });
  return {
    id: mediaId,
    eventId: image.eventId || null,
    purpose,
    visibility: "draft",
    ...stored,
    createdBy: adminId,
    createdAt: nowValue.toISOString(),
    cleanedAt: null
  };
}

export async function commitContentImport(rawDeps, input) {
  const deps = defaults(rawDeps);
  const nowValue = timestamp(deps);
  const originalDb = await deps.store.readDb();
  const batch = batchByOwner(originalDb, input.batchId, input.adminId, nowValue);
  const selected = selectedReadyImages(batch, input.selectedImageIds || []);
  if (input.coverImageId && !selected.some((image) => image.id === input.coverImageId)) {
    throw importError(422, "封面必须从已选择的正文图片中指定", "IMPORT_COVER_INVALID");
  }
  const savedMedia = [];
  const mediaByImage = new Map();
  try {
    for (const sourceImage of selected) {
      const image = { ...sourceImage, batchId: batch.id, eventId: input.eventId || null };
      const mediaId = deps.makeId("M");
      const media = await saveImportedMedia(deps, { image, purpose: "content-body", mediaId, adminId: input.adminId, nowValue });
      savedMedia.push(media);
      mediaByImage.set(image.id, media.id);
    }
    let coverMediaId = null;
    if (input.coverImageId) {
      const sourceImage = selected.find((image) => image.id === input.coverImageId);
      coverMediaId = deps.makeId("M");
      savedMedia.push(await saveImportedMedia(deps, {
        image: { ...sourceImage, batchId: batch.id, eventId: input.eventId || null },
        purpose: "content-cover", mediaId: coverMediaId, adminId: input.adminId, nowValue
      }));
    }

    const db = structuredClone(originalDb);
    const targetBatch = batchByOwner(db, input.batchId, input.adminId, nowValue);
    db.mediaAssets ||= [];
    db.mediaAssets.push(...savedMedia);
    const bodyHtml = rewriteImageTokens(targetBatch.bodyTemplateHtml, selected, mediaByImage);
    const contentId = deps.makeId("POST");
    const actor = (db.users || []).find((user) => user.id === input.adminId) || { id: input.adminId, name: "管理员" };
    const row = createContent(db, {
      eventId: input.eventId || null,
      type: input.type,
      title: input.title,
      summary: input.summary || "",
      slug: input.slug,
      bodyHtml,
      coverMediaId,
      attachments: selected.map((image, index) => ({
        mediaId: mediaByImage.get(image.id), label: "转载正文图片", displayOrder: index
      }))
    }, {
      id: contentId,
      actor,
      now: nowValue.toISOString(),
      source: {
        sourceUrl: targetBatch.sourceUrl,
        sourceUrlFingerprint: targetBatch.sourceUrlFingerprint,
        sourceName: targetBatch.sourceName,
        sourceAuthor: targetBatch.sourceAuthor,
        sourcePublishedAt: targetBatch.sourcePublishedAt,
        importedAt: nowValue.toISOString()
      }
    });
    targetBatch.status = "committed";
    recordAudit(db, {
      actor,
      action: "content.import",
      targetType: "content",
      targetId: row.id,
      summary: `转载内容：${row.title}；来源：${targetBatch.sourceName || targetBatch.sourceUrl}`,
      createdAt: nowValue.toISOString()
    });
    await deps.store.writeDb(db);
    try {
      await deps.stagedStorage.deleteBatch({ batchId: batch.id });
    } catch (error) {
      await persistCleanupTargets(deps, db, [{
        filePath: error?.cleanupTarget?.filePath || path.resolve(process.env.UPLOAD_ROOT || "/data/uploads", "site-content-import-staging", batch.id),
        category: "site-content-import-staging",
        cleanupAttempts: 1,
        lastError: String(error?.message || error)
      }], nowValue);
    }
    return structuredClone(row);
  } catch (error) {
    await cleanupSavedMedia(deps, savedMedia, originalDb, nowValue);
    throw error;
  }
}

export async function cancelContentImport(rawDeps, { adminId, batchId }) {
  const deps = defaults(rawDeps);
  const nowValue = timestamp(deps);
  const db = await deps.store.readDb();
  const batch = batchByOwner(db, batchId, adminId, nowValue);
  batch.status = "cancelled";
  recordAudit(db, {
    actor: auditActor(db, adminId), action: "content.import.cancel", targetType: "content-import",
    targetId: batch.id, summary: `取消转载任务：${batch.title || batch.sourceUrl}`, createdAt: nowValue.toISOString()
  });
  await deps.store.writeDb(db);
  try {
    await deps.stagedStorage.deleteBatch({ batchId });
  } catch (error) {
    await persistCleanupTargets(deps, db, [{
      filePath: error?.cleanupTarget?.filePath || path.resolve(process.env.UPLOAD_ROOT || "/data/uploads", "site-content-import-staging", batchId),
      category: "site-content-import-staging",
      cleanupAttempts: 1,
      lastError: String(error?.message || error)
    }], nowValue);
  }
  return structuredClone(batch);
}

export async function expireContentImportBatches(rawDeps) {
  const deps = defaults(rawDeps);
  const nowValue = timestamp(deps);
  const db = await deps.store.readDb();
  const expired = (db.siteContentImportBatches || []).filter((batch) => (
    batch.status === "ready" && Date.parse(batch.expiresAt) <= nowValue.getTime()
  ));
  if (!expired.length) return [];
  const expiredIds = new Set(expired.map((batch) => batch.id));
  db.siteContentImportBatches = (db.siteContentImportBatches || []).filter((batch) => !expiredIds.has(batch.id));
  for (const batch of expired) {
    recordAudit(db, {
      actor: { id: "system", name: "系统" }, action: "content.import.expire", targetType: "content-import",
      targetId: batch.id, summary: `清理过期转载任务：${batch.title || batch.sourceUrl || batch.id}`, createdAt: nowValue.toISOString()
    });
  }
  await deps.store.writeDb(db);
  for (const batch of expired) {
    try {
      await deps.stagedStorage.deleteBatch({ batchId: batch.id });
    } catch (error) {
      await persistCleanupTargets(deps, db, [{
        filePath: error?.cleanupTarget?.filePath || path.resolve(process.env.UPLOAD_ROOT || "/data/uploads", "site-content-import-staging", batch.id),
        category: "site-content-import-staging",
        cleanupAttempts: 1,
        lastError: String(error?.message || error)
      }], nowValue);
    }
  }
  return expired.map((batch) => batch.id);
}

export function contentImportBatchForAdmin(db, { adminId, batchId, now = new Date() }) {
  return structuredClone(batchByOwner(db, batchId, adminId, new Date(now)));
}
