import fs from "node:fs/promises";
import path from "node:path";

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IMAGE_EXTENSIONS = new Set(["jpg", "png", "webp"]);

function uploadRoot() {
  return path.resolve(process.env.UPLOAD_ROOT || "/data/uploads");
}

function safeComponent(value, name) {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error(`Invalid ${name} path component`);
  }
  return value;
}

function safeExtension(value) {
  const extension = String(value || "").toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error("Invalid imported image extension");
  return extension;
}

function assertInside(parent, target, message) {
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

function stagingParent() {
  return path.resolve(uploadRoot(), "site-content-import-staging");
}

function stagingDirectory(batchId) {
  return path.resolve(stagingParent(), safeComponent(batchId, "batch"));
}

function stagingPath(batchId, imageId, extension) {
  const directory = stagingDirectory(batchId);
  const target = path.resolve(directory, `${safeComponent(imageId, "image")}.${safeExtension(extension)}`);
  assertInside(directory, target, "Imported image path escapes its batch directory");
  return target;
}

async function assertNoSymlinks(root, target, fileSystem) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Imported image path escapes upload root");
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fileSystem.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Imported image path contains a symbolic link");
  }
}

async function assertRealPaths(root, directory, target, fileSystem) {
  const [realRoot, realDirectory, realTarget] = await Promise.all([
    fileSystem.realpath(root), fileSystem.realpath(directory), fileSystem.realpath(target)
  ]);
  assertInside(realRoot, realDirectory, "Imported image directory escapes upload root");
  assertInside(realDirectory, realTarget, "Imported image path escapes its batch directory");
  return { realDirectory, realTarget };
}

async function prepareDirectory(batchId, fileSystem) {
  const root = uploadRoot();
  const parent = stagingParent();
  const directory = stagingDirectory(batchId);
  await fileSystem.mkdir(root, { recursive: true });
  await fileSystem.mkdir(parent, { recursive: true });
  await fileSystem.mkdir(directory, { recursive: true });
  await assertNoSymlinks(root, directory, fileSystem);
  const [realRoot, realDirectory] = await Promise.all([fileSystem.realpath(root), fileSystem.realpath(directory)]);
  assertInside(realRoot, realDirectory, "Imported image directory escapes upload root");
  return directory;
}

function resolveRegisteredPath({ batchId, imageId, stagePath }) {
  safeComponent(batchId, "batch");
  safeComponent(imageId, "image");
  if (typeof stagePath !== "string" || !stagePath) throw new Error("Imported image stage path is required");
  const directory = stagingDirectory(batchId);
  const resolved = path.resolve(stagePath);
  assertInside(directory, resolved, "Imported image stage path escapes its batch directory");
  const extension = path.extname(resolved).slice(1).toLowerCase();
  const expected = stagingPath(batchId, imageId, extension);
  if (resolved !== expected) throw new Error("Imported image stage path does not match its registered image");
  return expected;
}

export async function saveStagedImportImage({ batchId, imageId, extension, buffer, fileSystem = fs }) {
  if (!Buffer.isBuffer(buffer)) throw new Error("Imported image buffer is required");
  const filePath = stagingPath(batchId, imageId, extension);
  const directory = await prepareDirectory(batchId, fileSystem);
  try {
    await fileSystem.writeFile(filePath, buffer, { flag: "wx" });
    await assertNoSymlinks(uploadRoot(), filePath, fileSystem);
    await assertRealPaths(uploadRoot(), directory, filePath, fileSystem);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      try { await fileSystem.unlink(filePath); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          error.cleanupError = cleanupError;
          error.cleanupTarget = { filePath, category: "site-content-import-staging", cleanupAttempts: 1 };
        }
      }
    }
    throw error;
  }
  return { stagePath: filePath };
}

export async function readStagedImportImage({ batchId, imageId, stagePath, fileSystem = fs }) {
  const filePath = resolveRegisteredPath({ batchId, imageId, stagePath });
  const root = uploadRoot();
  const directory = stagingDirectory(batchId);
  await assertNoSymlinks(root, filePath, fileSystem);
  const first = await assertRealPaths(root, directory, filePath, fileSystem);
  const second = await assertRealPaths(root, directory, filePath, fileSystem);
  if (first.realDirectory !== second.realDirectory || first.realTarget !== second.realTarget) {
    throw new Error("Imported image path changed during validation");
  }
  return fileSystem.readFile(first.realTarget);
}

export async function deleteStagedImportImage({ batchId, imageId, stagePath, fileSystem = fs }) {
  const filePath = resolveRegisteredPath({ batchId, imageId, stagePath });
  try {
    await fileSystem.unlink(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    error.cleanupTarget = { filePath, category: "site-content-import-staging", cleanupAttempts: 1 };
    throw error;
  }
}

export async function deleteStagedImportBatch({ batchId, fileSystem = fs }) {
  const root = uploadRoot();
  const parent = stagingParent();
  const directory = stagingDirectory(batchId);
  try {
    await fileSystem.lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await assertNoSymlinks(root, directory, fileSystem);
  const [realRoot, realParent, realDirectory] = await Promise.all([
    fileSystem.realpath(root), fileSystem.realpath(parent), fileSystem.realpath(directory)
  ]);
  assertInside(realRoot, realParent, "Imported image staging parent escapes upload root");
  assertInside(realParent, realDirectory, "Imported image batch escapes staging parent");
  try {
    await fileSystem.rm(realDirectory, { recursive: true, force: false });
  } catch (error) {
    error.cleanupTarget = { filePath: realDirectory, category: "site-content-import-staging-batch", cleanupAttempts: 1 };
    throw error;
  }
}
