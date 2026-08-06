import fs from "node:fs/promises";

export const UPLOAD_WARNING_PERCENT = 80;
export const UPLOAD_CRITICAL_PERCENT = 90;

function parsePercent(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function storageThresholds(environment = process.env) {
  const warningPercent = parsePercent(environment?.UPLOAD_WARNING_PERCENT);
  const criticalPercent = parsePercent(environment?.UPLOAD_CRITICAL_PERCENT);
  if (warningPercent !== null && criticalPercent !== null && warningPercent < criticalPercent) {
    return { warningPercent, criticalPercent };
  }
  return { warningPercent: UPLOAD_WARNING_PERCENT, criticalPercent: UPLOAD_CRITICAL_PERCENT };
}

function statusLevel(usedPercent, thresholds) {
  if (usedPercent >= thresholds.criticalPercent) return "critical";
  if (usedPercent >= thresholds.warningPercent) return "warning";
  return "normal";
}

export async function readStorageStatus({ uploadRoot, fileSystem = fs, environment = process.env }) {
  if (typeof uploadRoot !== "string" || !uploadRoot) throw new Error("上传目录无效");
  await fileSystem.access(uploadRoot);
  const stats = await fileSystem.statfs(uploadRoot);
  const blockSize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const availableBlocks = Number(stats.bavail);
  if (![blockSize, blocks, availableBlocks].every(Number.isFinite) || blockSize < 1 || blocks < 1 || availableBlocks < 0) {
    throw new Error("无法读取上传磁盘容量");
  }
  const totalBytes = blockSize * blocks;
  const availableBytes = Math.min(totalBytes, blockSize * availableBlocks);
  const usedBytes = totalBytes - availableBytes;
  const usedPercent = (usedBytes / totalBytes) * 100;
  const thresholds = storageThresholds(environment);
  return {
    disk: { totalBytes, usedBytes, availableBytes, usedPercent },
    level: statusLevel(usedPercent, thresholds),
    thresholds
  };
}

export function assertVideoUploadCapacity(status, incomingBytes) {
  const disk = status?.disk;
  if (!disk || !Number.isFinite(disk.totalBytes) || !Number.isFinite(disk.usedBytes) || disk.totalBytes <= 0) {
    throw new Error("上传磁盘状态无效");
  }
  if (!Number.isFinite(incomingBytes) || incomingBytes < 0) throw new Error("视频文件大小无效");
  const projectedPercent = ((disk.usedBytes + incomingBytes) / disk.totalBytes) * 100;
  const thresholds = status?.thresholds || { warningPercent: UPLOAD_WARNING_PERCENT, criticalPercent: UPLOAD_CRITICAL_PERCENT };
  if (status.level === "critical" || projectedPercent >= thresholds.criticalPercent) {
    throw Object.assign(new Error("磁盘空间严重不足，暂时无法上传视频"), { status: 507 });
  }
}
