import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import {
  CERTIFICATE_POLICY,
  CREDENTIAL_POLICY,
  SITE_ATTACHMENT_POLICY,
  SITE_IMAGE_POLICY,
  validateUpload
} from "./policy.js";

const SAFE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CERTIFICATE_IMAGE_EXTENSIONS = new Set(["png", "jpg"]);
const SITE_MEDIA_PURPOSE_POLICIES = new Map([
  ["cover", SITE_IMAGE_POLICY],
  ["hero", SITE_IMAGE_POLICY],
  ["event-hero", SITE_IMAGE_POLICY],
  ["default-hero", SITE_IMAGE_POLICY],
  ["share-image", SITE_IMAGE_POLICY],
  ["content-cover", SITE_IMAGE_POLICY],
  ["content-body", SITE_IMAGE_POLICY],
  ["attachment", SITE_ATTACHMENT_POLICY],
  ["content-attachment", SITE_ATTACHMENT_POLICY]
]);

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

function siteMediaDirectory(mediaId) {
  return path.resolve(uploadRoot(), "site-media", safePathComponent(mediaId, "media"));
}

async function removeSiteMediaDirectory(filePath, fileSystem = fs) {
  const root = uploadRoot();
  const parent = path.resolve(root, "site-media");
  const directory = path.resolve(filePath);
  assertInside(parent, directory, "Site media path escapes its managed directory");
  safePathComponent(path.basename(directory), "media");
  await fileSystem.lstat(directory);
  await assertNoLinkedComponents(root, directory, fileSystem);
  await assertRealPathInsideRoot(root, directory, fileSystem);
  await fileSystem.rm(directory, { recursive: true, force: false });
}

function siteMediaVariant(storedName, filePath, output) {
  return {
    storedName,
    filePath,
    mimeType: "image/webp",
    sizeBytes: output.data.length,
    width: output.info.width,
    height: output.info.height
  };
}

export function siteMediaPolicyForPurpose(purpose) {
  const policy = SITE_MEDIA_PURPOSE_POLICIES.get(purpose);
  if (!policy) throw Object.assign(new Error("媒体用途不合法"), { status: 422 });
  return policy;
}

export async function saveSiteMedia({ mediaId, file, purpose, fileSystem = fs, imageProcessor = sharp }) {
  const directory = siteMediaDirectory(mediaId);
  const policy = siteMediaPolicyForPurpose(purpose);
  const isAttachment = policy === SITE_ATTACHMENT_POLICY;
  const detected = await validateUpload(file, policy);
  const storedName = `original.${detected.ext}`;
  const filePath = path.resolve(directory, storedName);
  const originalName = safeOriginalName(file.originalname);
  let original = file.buffer;
  let width = null;
  let height = null;
  let variants = {};
  const pending = [];

  if (!isAttachment) {
    try {
      const normalized = await imageProcessor(file.buffer).rotate().toBuffer({ resolveWithObject: true });
      original = normalized.data;
      width = normalized.info.width;
      height = normalized.info.height;
      for (const [name, targetWidth] of [["mobile", 768], ["desktop", 1600]]) {
        const output = await imageProcessor(original)
          .resize({ width: targetWidth, withoutEnlargement: true })
          .webp()
          .toBuffer({ resolveWithObject: true });
        const variantStoredName = `${name}.webp`;
        const variantPath = path.resolve(directory, variantStoredName);
        variants[name] = siteMediaVariant(variantStoredName, variantPath, output);
        pending.push({ filePath: variantPath, buffer: output.data });
      }
    } catch (error) {
      error.status = 422;
      throw error;
    }
  }

  const root = uploadRoot();
  const parent = path.resolve(root, "site-media");
  await prepareManagedDirectory(root, parent, fileSystem);
  await fileSystem.mkdir(directory, { recursive: false });
  await assertNoLinkedComponents(root, directory, fileSystem);
  await assertRealPathInsideRoot(root, directory, fileSystem);
  try {
    await fileSystem.writeFile(filePath, original, { flag: "wx" });
    for (const entry of pending) await fileSystem.writeFile(entry.filePath, entry.buffer, { flag: "wx" });
  } catch (error) {
    try {
      await fileSystem.rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
      error.cleanupTarget = { filePath: directory, category: "site-media-new", cleanupAttempts: 1 };
    }
    throw error;
  }

  return {
    originalName,
    storedName,
    filePath,
    mimeType: detected.mime,
    sizeBytes: original.length,
    width,
    height,
    variants
  };
}

async function readSiteMediaFile(record, selected, fileSystem) {
  if (!record?.id || !selected?.filePath) throw new Error("Site media record is required");
  const root = uploadRoot();
  const directory = siteMediaDirectory(record.id);
  const filePath = path.resolve(selected.filePath);
  assertInside(directory, filePath, "Site media file path escapes its media directory");

  const rootStats = await fileSystem.lstat(root);
  if (rootStats.isSymbolicLink()) throw new Error("Site media path contains a symbolic link");
  await assertNoLinkedComponents(root, filePath, fileSystem);
  const [realRoot, realDirectory, realFilePath] = await Promise.all([
    fileSystem.realpath(root),
    fileSystem.realpath(directory),
    fileSystem.realpath(filePath)
  ]);
  assertInside(realRoot, realDirectory, "Site media directory escapes upload root");
  assertInside(realDirectory, realFilePath, "Site media file path escapes its media directory");

  const [confirmedRoot, confirmedDirectory, confirmedFilePath] = await Promise.all([
    fileSystem.realpath(root),
    fileSystem.realpath(directory),
    fileSystem.realpath(filePath)
  ]);
  if (confirmedRoot !== realRoot || confirmedDirectory !== realDirectory || confirmedFilePath !== realFilePath) {
    throw new Error("Site media path changed during validation");
  }
  return fileSystem.readFile(realFilePath);
}

export async function readSiteMedia(record, variant = "original", fileSystem = fs) {
  const registeredVariant = variant !== "original" ? record?.variants?.[variant] : null;
  const selected = registeredVariant || record;
  let served = selected;
  let buffer;
  try {
    buffer = await readSiteMediaFile(record, selected, fileSystem);
  } catch (error) {
    if (!registeredVariant || error?.code !== "ENOENT") throw error;
    served = record;
    buffer = await readSiteMediaFile(record, record, fileSystem);
  }
  return {
    buffer,
    mimeType: served.mimeType || record.mimeType
  };
}

export async function deleteSiteMedia(record, fileSystem = fs) {
  if (!record?.id || !record?.filePath) throw new Error("Site media record is required");
  const directory = siteMediaDirectory(record.id);
  assertInside(directory, path.resolve(record.filePath), "Site media file path escapes its media directory");
  await removeSiteMediaDirectory(directory, fileSystem);
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

export async function saveCertificateFile({ registrationId, slot, file, fileSystem = fs }) {
  const safeRegistrationId = safePathComponent(registrationId, "registration");
  if (![1, 2].includes(slot)) throw new Error("Invalid certificate slot");
  const detected = await validateUpload(file, CERTIFICATE_POLICY);
  const root = uploadRoot();
  const storedName = `${crypto.randomUUID()}.${detected.ext}`;
  const filePath = path.resolve(root, "certificates", storedName);
  assertInside(root, filePath, "Certificate file path escapes upload root");
  await prepareManagedDirectory(root, path.dirname(filePath), fileSystem);
  try {
    await fileSystem.writeFile(filePath, file.buffer, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    try { await fileSystem.unlink(filePath); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        error.cleanupError = cleanupError;
        error.cleanupTarget = {
          storedName,
          filePath,
          fileName: `${safeRegistrationId}-certificate-${slot}.${detected.ext}`,
          category: "certificate-manual-new",
          cleanupAttempts: 1
        };
      }
    }
    throw error;
  }
  return {
    storedName,
    filePath,
    fileName: `${safeRegistrationId}-certificate-${slot}.${detected.ext}`,
    originalName: safeOriginalName(file.originalname),
    mimeType: detected.mime,
    size: file.buffer.length,
    extension: detected.ext
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
  if (String(record.category || "").startsWith("site-media")) {
    await removeSiteMediaDirectory(record.filePath, fs);
    return;
  }
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
