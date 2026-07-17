import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CREDENTIAL_POLICY, validateUpload } from "./policy.js";

const SAFE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CERTIFICATE_IMAGE_EXTENSIONS = new Set(["png", "jpg"]);

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

function assertInside(root, filePath, message) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(message);
  }
  return relative;
}

async function assertNoLinkedComponents(root, target, fileSystem) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed upload path escapes upload root");
  }
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await fileSystem.lstat(current);
    if (stats.isSymbolicLink()) throw new Error("Managed upload path contains a symbolic link");
  }
}

async function assertRealPathInsideRoot(root, target, fileSystem) {
  const [realRoot, realTarget] = await Promise.all([
    fileSystem.realpath(root),
    fileSystem.realpath(target)
  ]);
  assertInside(realRoot, realTarget, "Managed upload path escapes upload root");
  return { realRoot, realTarget };
}

async function prepareManagedDirectory(root, directory, fileSystem) {
  await fileSystem.mkdir(root, { recursive: true });
  await fileSystem.mkdir(directory, { recursive: true });
  await assertNoLinkedComponents(root, directory, fileSystem);
  await assertRealPathInsideRoot(root, directory, fileSystem);
}

function certificateExtension(value) {
  const extension = String(value || "").toLowerCase();
  if (!CERTIFICATE_IMAGE_EXTENSIONS.has(extension)) throw new Error("Invalid certificate image extension");
  return extension;
}

function importStagingDirectory(batchId) {
  return path.resolve(uploadRoot(), "import-staging", safePathComponent(batchId, "batch"));
}

export async function createImportStagingBatch(batchId, fileSystem = fs) {
  const root = uploadRoot();
  const parent = path.resolve(root, "import-staging");
  const directory = importStagingDirectory(batchId);
  await prepareManagedDirectory(root, parent, fileSystem);
  await fileSystem.mkdir(directory, { recursive: false });
  await assertNoLinkedComponents(root, directory, fileSystem);
  await assertRealPathInsideRoot(root, directory, fileSystem);
  return { directory };
}

export function resolveImportStagingPath(batchId, relativePath) {
  const directory = importStagingDirectory(batchId);
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Import staging path is invalid");
  }
  const filePath = path.resolve(directory, relativePath);
  assertInside(directory, filePath, "Import staging path escapes its batch directory");
  return filePath;
}

export async function saveImportStagingFile({ batchId, rowNumber, slot, extension, buffer, fileSystem = fs }) {
  const safeExtension = certificateExtension(extension);
  if (!Number.isInteger(rowNumber) || rowNumber < 1) throw new Error("Invalid certificate import row number");
  if (![1, 2].includes(slot)) throw new Error("Invalid certificate slot");
  const relativePath = `${rowNumber}-${slot}.${safeExtension}`;
  const filePath = resolveImportStagingPath(batchId, relativePath);
  await prepareManagedDirectory(uploadRoot(), path.dirname(filePath), fileSystem);
  try {
    await fileSystem.writeFile(filePath, buffer, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    try { await fileSystem.unlink(filePath); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        error.cleanupError = cleanupError;
        error.cleanupTarget = { filePath, relativePath, category: "certificate-import-staging", cleanupAttempts: 1 };
      }
    }
    throw error;
  }
  return { relativePath, filePath };
}

export async function readImportStagingFile({ batchId, relativePath, fileSystem = fs }) {
  const root = uploadRoot();
  const directory = importStagingDirectory(batchId);
  const filePath = resolveImportStagingPath(batchId, relativePath);
  await assertNoLinkedComponents(root, filePath, fileSystem);
  const [{ realTarget: realDirectory }, { realTarget: realFilePath }] = await Promise.all([
    assertRealPathInsideRoot(root, directory, fileSystem),
    assertRealPathInsideRoot(root, filePath, fileSystem)
  ]);
  const [confirmedDirectory, confirmedFilePath] = await Promise.all([
    fileSystem.realpath(directory),
    fileSystem.realpath(filePath)
  ]);
  assertInside(realDirectory, realFilePath, "Import staging path escapes its batch directory");
  if (confirmedDirectory !== realDirectory || confirmedFilePath !== realFilePath) {
    throw new Error("Import staging path changed during validation");
  }
  return fileSystem.readFile(realFilePath);
}

export async function removeImportStagingBatch(batchId, fileSystem = fs) {
  const root = uploadRoot();
  const parent = path.resolve(root, "import-staging");
  const directory = importStagingDirectory(batchId);
  try {
    await fileSystem.lstat(parent);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await assertNoLinkedComponents(root, parent, fileSystem);
  await assertRealPathInsideRoot(root, parent, fileSystem);
  try {
    await fileSystem.lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await assertNoLinkedComponents(root, directory, fileSystem);
  await assertRealPathInsideRoot(root, directory, fileSystem);
  await fileSystem.rm(directory, { recursive: true, force: true });
}

export async function saveCertificateImportFile({ registrationId, slot, extension, buffer, fileSystem = fs }) {
  const safeExtension = certificateExtension(extension);
  const safeRegistrationId = safePathComponent(registrationId, "registration");
  if (![1, 2].includes(slot)) throw new Error("Invalid certificate slot");
  const root = uploadRoot();
  const storedName = `${crypto.randomUUID()}.${safeExtension}`;
  const filePath = path.resolve(root, "certificates", storedName);
  assertInside(root, filePath, "Certificate file path escapes upload root");
  await prepareManagedDirectory(root, path.dirname(filePath), fileSystem);
  try {
    await fileSystem.writeFile(filePath, buffer, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    try { await fileSystem.unlink(filePath); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        const fileName = `${safeRegistrationId}-certificate-${slot}.${safeExtension}`;
        error.cleanupError = cleanupError;
        error.cleanupTarget = { storedName, filePath, fileName, category: "certificate-import-new", cleanupAttempts: 1 };
      }
    }
    throw error;
  }
  return {
    storedName,
    filePath,
    fileName: `${safeRegistrationId}-certificate-${slot}.${safeExtension}`
  };
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
  await assertNoLinkedComponents(root, path.dirname(filePath), fs);
  await assertRealPathInsideRoot(root, path.dirname(filePath), fs);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (record.category !== "certificate-import-staging" || error?.code !== "ENOENT") throw error;
  }
  if (record.category === "certificate-import-staging") {
    try {
      await fs.rmdir(path.dirname(filePath));
    } catch (error) {
      if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
    }
  }
}

export async function readPrivateFile(record, fileSystem = fs) {
  if (!record?.filePath) throw new Error("Private file record is required");
  const root = uploadRoot();
  const filePath = path.resolve(record.filePath);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Private file path escapes upload root");
  }
  const [realRoot, realFilePath] = await Promise.all([
    fileSystem.realpath(root),
    fileSystem.realpath(filePath)
  ]);
  const realRelative = path.relative(realRoot, realFilePath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("Private file path escapes upload root");
  }
  return fileSystem.readFile(realFilePath);
}
