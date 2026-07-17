import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CREDENTIAL_POLICY, validateUpload } from "./policy.js";

const SAFE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function uploadRoot() {
  return path.resolve(process.env.UPLOAD_ROOT || "/data/uploads");
}

function safePathComponent(value, name) {
  if (typeof value !== "string" || !SAFE_PATH_COMPONENT.test(value)) {
    throw new Error(`Invalid ${name} path component`);
  }
  return value;
}

function safeOriginalName(value) {
  const base = path.basename(String(value || "upload"));
  const safe = base
    .replace(/[\\/\x00-\x1f<>:"|?*]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 255);
  return safe || "upload";
}

function resolvePrivatePath(root, category, ownerId, storedName) {
  const filePath = path.resolve(root, category, ownerId, storedName);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Private file path escapes upload root");
  }
  return filePath;
}

export async function savePrivateFile({ category, ownerId, file, fileSystem = fs }) {
  const safeCategory = safePathComponent(category, "category");
  const safeOwnerId = safePathComponent(ownerId, "owner");
  const detected = await validateUpload(file, CREDENTIAL_POLICY);
  const root = uploadRoot();
  const storedName = `${crypto.randomUUID()}.${detected.ext}`;
  const filePath = resolvePrivatePath(root, safeCategory, safeOwnerId, storedName);

  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fileSystem.writeFile(filePath, file.buffer, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    try {
      await fileSystem.unlink(filePath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
  return {
    storedName,
    filePath,
    originalName: safeOriginalName(file.originalname),
    mimeType: detected.mime,
    size: file.buffer.length
  };
}

export async function deletePrivateFile(record) {
  if (!record?.filePath) throw new Error("Private file record is required");
  const root = uploadRoot();
  const filePath = path.resolve(record.filePath);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Private file path escapes upload root");
  }
  await fs.unlink(filePath);
}
