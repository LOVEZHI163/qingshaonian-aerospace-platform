import path from "node:path";

import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_COUNT = 20;
const ALLOWED_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

const REASONS = {
  IMPORT_IMAGE_FETCH_FAILED: "图片下载失败，可稍后重试",
  IMPORT_IMAGE_UNSUPPORTED: "图片不是受支持的 JPG、PNG 或 WebP 文件",
  IMPORT_IMAGE_TOO_LARGE: "单张图片超过 5MB，已跳过",
  IMPORT_IMAGE_COUNT_LIMIT: "正文图片超过 20 张，已跳过",
  IMPORT_IMAGE_BATCH_LIMIT: "本次转载图片总量超过 50MB，已跳过",
  IMPORT_IMAGE_QR_CODE: "识别为二维码或关注引导图，已过滤",
  IMPORT_IMAGE_BRANDING: "识别为头像或站点标识，已过滤",
  IMPORT_IMAGE_ADVERTISEMENT: "识别为广告图片，已过滤",
  IMPORT_IMAGE_TRACKER: "识别为跟踪像素，已过滤",
  IMPORT_IMAGE_TOO_SMALL: "图片尺寸过小，已过滤",
  IMPORT_IMAGE_EXTREME_RATIO: "图片宽高比例异常，已过滤",
  IMPORT_IMAGE_INVALID: "图片无法读取，已跳过"
};

function failure(candidate, reasonCode, details = {}) {
  return {
    id: candidate.id,
    originalUrl: candidate.url,
    resolvedUrl: details.resolvedUrl || candidate.url,
    originalName: details.originalName || fileName(details.resolvedUrl || candidate.url),
    mimeType: details.mimeType || null,
    sizeBytes: details.sizeBytes ?? null,
    width: details.width ?? null,
    height: details.height ?? null,
    stagePath: null,
    status: details.status || "filtered",
    reasonCode,
    reason: REASONS[reasonCode],
    coverCandidate: false,
    alt: candidate.alt || "",
    title: candidate.title || ""
  };
}

function fileName(value) {
  try {
    const name = path.posix.basename(new URL(value).pathname);
    return decodeURIComponent(name || "image").slice(0, 255);
  } catch {
    return "image";
  }
}

function semanticFilter(candidate) {
  const value = `${candidate.url || ""} ${candidate.alt || ""} ${candidate.title || ""}`.toLowerCase();
  if (/(?:qrcode|qr[_-]?code|二维码|扫码|关注公众号)/i.test(value)) return "IMPORT_IMAGE_QR_CODE";
  if (/(?:logo|avatar|head(?:er)?[-_]?image|头像|站点标识)/i.test(value)) return "IMPORT_IMAGE_BRANDING";
  if (/(?:banner[-_]?ad|advert(?:isement)?|广告|推广图片)/i.test(value)) return "IMPORT_IMAGE_ADVERTISEMENT";
  if (/(?:tracking[-_]?pixel|tracker|spacer\.gif)/i.test(value)) return "IMPORT_IMAGE_TRACKER";
  return null;
}

async function inspectBuffer(buffer, { detectFileType, imageProcessor }) {
  const detected = await detectFileType(buffer);
  const extension = ALLOWED_TYPES.get(detected?.mime);
  if (!extension) throw Object.assign(new Error("unsupported"), { reasonCode: "IMPORT_IMAGE_UNSUPPORTED" });
  let output;
  try {
    output = await imageProcessor(buffer).rotate().toBuffer({ resolveWithObject: true });
  } catch {
    throw Object.assign(new Error("invalid"), { reasonCode: "IMPORT_IMAGE_INVALID" });
  }
  return {
    mimeType: detected.mime,
    extension,
    width: Number(output.info.width || 0),
    height: Number(output.info.height || 0),
    normalizedBuffer: output.data
  };
}

function dimensionFilter(width, height) {
  if (width <= 1 || height <= 1) return "IMPORT_IMAGE_TRACKER";
  if (width < 120 || height < 80) return "IMPORT_IMAGE_TOO_SMALL";
  const ratio = Math.max(width / height, height / width);
  if (ratio > 8) return "IMPORT_IMAGE_EXTREME_RATIO";
  return null;
}

async function stageOne({
  batchId,
  candidate,
  fetchResource,
  saveImage,
  inspectImage,
  detectFileType,
  imageProcessor,
  readyCount,
  readyBytes,
  enforceCount = true
}) {
  if (enforceCount && readyCount >= MAX_IMAGE_COUNT) return failure(candidate, "IMPORT_IMAGE_COUNT_LIMIT");
  const semanticReason = semanticFilter(candidate);
  if (semanticReason) return failure(candidate, semanticReason);

  let resource;
  try {
    resource = await fetchResource(candidate.url, { expected: "image", maxBytes: MAX_IMAGE_BYTES + 1 });
  } catch {
    return failure(candidate, "IMPORT_IMAGE_FETCH_FAILED", { status: "failed" });
  }
  const resolvedUrl = resource.finalUrl || candidate.url;
  const originalName = fileName(resolvedUrl);
  if (!Buffer.isBuffer(resource.buffer)) {
    return failure(candidate, "IMPORT_IMAGE_FETCH_FAILED", { status: "failed", resolvedUrl, originalName });
  }
  if (resource.buffer.length > MAX_IMAGE_BYTES) {
    return failure(candidate, "IMPORT_IMAGE_TOO_LARGE", { resolvedUrl, originalName, sizeBytes: resource.buffer.length });
  }

  let inspected;
  try {
    inspected = inspectImage
      ? await inspectImage(resource.buffer, { detectFileType, imageProcessor })
      : await inspectBuffer(resource.buffer, { detectFileType, imageProcessor });
  } catch (error) {
    return failure(candidate, error?.reasonCode || "IMPORT_IMAGE_INVALID", {
      resolvedUrl, originalName, sizeBytes: resource.buffer.length
    });
  }
  const normalizedBuffer = inspected.normalizedBuffer || resource.buffer;
  const sizeBytes = normalizedBuffer.length;
  if (!ALLOWED_TYPES.has(inspected.mimeType) || !ALLOWED_TYPES.get(inspected.mimeType)) {
    return failure(candidate, "IMPORT_IMAGE_UNSUPPORTED", { resolvedUrl, originalName, sizeBytes });
  }
  const dimensionReason = dimensionFilter(inspected.width, inspected.height);
  if (dimensionReason) {
    return failure(candidate, dimensionReason, {
      resolvedUrl, originalName, mimeType: inspected.mimeType, sizeBytes,
      width: inspected.width, height: inspected.height
    });
  }
  if (readyBytes + sizeBytes > MAX_BATCH_BYTES) {
    return failure(candidate, "IMPORT_IMAGE_BATCH_LIMIT", {
      resolvedUrl, originalName, mimeType: inspected.mimeType, sizeBytes,
      width: inspected.width, height: inspected.height
    });
  }

  let saved;
  try {
    saved = await saveImage({
      batchId,
      imageId: candidate.id,
      extension: inspected.extension || ALLOWED_TYPES.get(inspected.mimeType),
      buffer: normalizedBuffer
    });
  } catch {
    return failure(candidate, "IMPORT_IMAGE_INVALID", {
      status: "failed", resolvedUrl, originalName, mimeType: inspected.mimeType, sizeBytes,
      width: inspected.width, height: inspected.height
    });
  }
  return {
    id: candidate.id,
    originalUrl: candidate.url,
    resolvedUrl,
    originalName,
    mimeType: inspected.mimeType,
    sizeBytes,
    width: inspected.width,
    height: inspected.height,
    stagePath: saved.stagePath,
    status: "ready",
    reasonCode: null,
    reason: "",
    coverCandidate: false,
    alt: candidate.alt || "",
    title: candidate.title || ""
  };
}

export async function stageArticleImages({
  batchId,
  candidates,
  fetchResource,
  saveImage,
  inspectImage,
  detectFileType = fileTypeFromBuffer,
  imageProcessor = sharp
}) {
  const results = [];
  let readyCount = 0;
  let readyBytes = 0;
  for (let index = 0; index < (candidates || []).length; index += 1) {
    const candidate = candidates[index];
    if (index >= MAX_IMAGE_COUNT) {
      results.push(failure(candidate, "IMPORT_IMAGE_COUNT_LIMIT"));
      continue;
    }
    const result = await stageOne({
      batchId, candidate, fetchResource, saveImage, inspectImage, detectFileType, imageProcessor,
      readyCount, readyBytes, enforceCount: false
    });
    if (result.status === "ready") {
      readyCount += 1;
      readyBytes += result.sizeBytes;
      if (readyCount === 1) result.coverCandidate = true;
    }
    results.push(result);
  }
  return results;
}

export async function retryArticleImage({
  batch,
  imageId,
  fetchResource,
  saveImage,
  inspectImage,
  detectFileType = fileTypeFromBuffer,
  imageProcessor = sharp
}) {
  const index = batch?.images?.findIndex((entry) => entry.id === imageId) ?? -1;
  if (index < 0) throw Object.assign(new Error("未找到待重试的图片"), { status: 404, code: "IMPORT_IMAGE_NOT_FOUND" });
  const previous = batch.images[index];
  const ready = batch.images.filter((entry, entryIndex) => entryIndex !== index && entry.status === "ready");
  const result = await stageOne({
    batchId: batch.id,
    candidate: { id: previous.id, url: previous.originalUrl, alt: previous.alt, title: previous.title },
    fetchResource,
    saveImage,
    inspectImage,
    detectFileType,
    imageProcessor,
    readyCount: ready.length,
    readyBytes: ready.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0)
  });
  if (result.status === "ready" && ready.length === 0) result.coverCandidate = true;
  batch.images[index] = result;
  return result;
}

export const SITE_CONTENT_IMPORT_IMAGE_LIMITS = Object.freeze({
  maxImageBytes: MAX_IMAGE_BYTES,
  maxBatchBytes: MAX_BATCH_BYTES,
  maxImageCount: MAX_IMAGE_COUNT
});
