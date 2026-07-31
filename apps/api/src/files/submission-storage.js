import { execFile as execFileCallback } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { fileTypeFromFile } from "file-type";
import sharp from "sharp";

import { SUBMISSION_IMAGE_POLICY, SUBMISSION_VIDEO_POLICY } from "./policy.js";

const execFile = promisify(execFileCallback);
const IMAGE_DIMENSION_WARNING = "作品图片长边低于建议的 780 像素";
const VIDEO_RESOLUTION_WARNING = "制作视频分辨率低于建议的 720P";

function validationError(message) {
  return Object.assign(new Error(message), { status: 422 });
}

function rangeError(size) {
  return Object.assign(new Error("请求的文件范围无效"), {
    status: 416,
    headers: { "Content-Range": `bytes */${size}` }
  });
}

function policyFor(kind) {
  if (kind === "artwork_image") return SUBMISSION_IMAGE_POLICY;
  if (kind === "creation_video") return SUBMISSION_VIDEO_POLICY;
  throw validationError("作品材料类型不合法");
}

function dimensionsForImage(metadata) {
  let { width, height } = metadata;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw validationError("无法读取作品图片尺寸");
  }
  if ([5, 6, 7, 8].includes(metadata.orientation)) [width, height] = [height, width];
  return { width, height };
}

export async function probeVideo(filePath, execute = execFile) {
  let output;
  try {
    ({ stdout: output } = await execute("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json",
      filePath
    ]));
  } catch {
    throw validationError("无法读取作画视频元数据");
  }

  try {
    const details = JSON.parse(output);
    const stream = details.streams?.find((entry) => entry.codec_type === "video");
    const durationSeconds = Number(details.format?.duration);
    if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height)
      || stream.width < 1 || stream.height < 1 || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new Error("invalid metadata");
    }
    return {
      durationMs: Math.round(durationSeconds * 1000),
      width: stream.width,
      height: stream.height
    };
  } catch {
    throw validationError("无法读取作画视频元数据");
  }
}

export async function inspectSubmissionFile({ kind, filePath, originalName, probeVideo: inspectVideo = probeVideo }) {
  if (typeof filePath !== "string" || !filePath) throw validationError("作品文件不存在");
  if (typeof originalName !== "string" || !originalName) throw validationError("作品原始文件名无效");

  const policy = policyFor(kind);
  const { size } = await fs.stat(filePath);
  if (size > policy.maxBytes) {
    throw validationError(kind === "artwork_image" ? "图片文件超过 2MB 限制" : "视频文件超过 200MB 限制");
  }

  let detected;
  try {
    detected = await fileTypeFromFile(filePath);
  } catch {
    throw validationError(kind === "artwork_image" ? "作品图片必须为真实的 PNG 或 JPEG 文件" : "视频必须为真实的 MP4 文件");
  }
  if (!detected || !policy.mimeTypes.has(detected.mime)) {
    throw validationError(kind === "artwork_image" ? "作品图片必须为真实的 PNG 或 JPEG 文件" : "视频必须为真实的 MP4 文件");
  }

  if (kind === "artwork_image") {
    let metadata;
    try {
      metadata = await sharp(filePath).metadata();
    } catch {
      throw validationError("无法读取作品图片尺寸");
    }
    const { width, height } = dimensionsForImage(metadata);
    return {
      mimeType: detected.mime,
      sizeBytes: size,
      width,
      height,
      durationMs: null,
      warnings: Math.max(width, height) < 780 ? [IMAGE_DIMENSION_WARNING] : []
    };
  }

  let metadata;
  try {
    metadata = await inspectVideo(filePath);
  } catch (error) {
    if (error?.status) throw error;
    throw validationError("无法读取作画视频元数据");
  }
  if (!metadata || !Number.isFinite(metadata.durationMs) || metadata.durationMs < 0
    || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)
    || metadata.width < 1 || metadata.height < 1) {
    throw validationError("无法读取作画视频元数据");
  }
  if (metadata.durationMs > policy.maxDurationMs) throw validationError("视频时长超过 120 秒限制");
  return {
    mimeType: detected.mime,
    sizeBytes: size,
    width: metadata.width,
    height: metadata.height,
    durationMs: Math.round(metadata.durationMs),
    warnings: metadata.height < 720 ? [VIDEO_RESOLUTION_WARNING] : []
  };
}

function parseRange(rangeHeader, size) {
  if (size < 1) throw rangeError(size);
  if (typeof rangeHeader !== "string" || rangeHeader.includes(",")) throw rangeError(size);
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) throw rangeError(size);

  const [, startText, endText] = match;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) throw rangeError(size);
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) throw rangeError(size);
  if (!endText) return { start, end: size - 1 };
  const requestedEnd = Number(endText);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) throw rangeError(size);
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function readSubmissionRange(record, rangeHeader) {
  if (!record?.filePath) throw new Error("作品文件记录无效");
  const { size } = await fs.stat(record.filePath);
  const mimeType = record.mimeType || "application/octet-stream";
  if (!rangeHeader) {
    return {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(size),
        ...(mimeType === "video/mp4" ? { "Accept-Ranges": "bytes" } : {})
      },
      stream: fsSync.createReadStream(record.filePath)
    };
  }

  const { start, end } = parseRange(rangeHeader, size);
  const length = end - start + 1;
  return {
    status: 206,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${size}`
    },
    stream: fsSync.createReadStream(record.filePath, { start, end })
  };
}

export async function deleteSubmissionFile(record, fileSystem = fs) {
  if (!record?.filePath) throw new Error("作品文件记录无效");
  await fileSystem.unlink(record.filePath);
}
