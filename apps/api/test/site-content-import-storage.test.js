import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deleteStagedImportBatch,
  deleteStagedImportImage,
  readStagedImportImage,
  saveStagedImportImage
} from "../src/files/site-content-import-storage.js";

async function withUploadRoot(t) {
  const previous = process.env.UPLOAD_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-site-import-"));
  process.env.UPLOAD_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("stores, reads, and removes a staged article image inside its batch", async (t) => {
  const root = await withUploadRoot(t);
  const saved = await saveStagedImportImage({
    batchId: "SCI-1", imageId: "IMG1", extension: "png", buffer: Buffer.from("image")
  });

  assert.equal(saved.stagePath, path.join(root, "site-content-import-staging", "SCI-1", "IMG1.png"));
  assert.deepEqual(await readStagedImportImage({ batchId: "SCI-1", imageId: "IMG1", stagePath: saved.stagePath }), Buffer.from("image"));

  await deleteStagedImportImage({ batchId: "SCI-1", imageId: "IMG1", stagePath: saved.stagePath });
  await assert.rejects(fs.stat(saved.stagePath), { code: "ENOENT" });
});

test("rejects traversal, symbolic links, unsupported extensions, and duplicate files", async (t) => {
  const root = await withUploadRoot(t);
  const input = { batchId: "SCI-2", imageId: "IMG1", extension: "jpg", buffer: Buffer.from("image") };
  await saveStagedImportImage(input);
  await assert.rejects(saveStagedImportImage(input), { code: "EEXIST" });
  await assert.rejects(saveStagedImportImage({ ...input, batchId: "../escape" }), /Invalid batch/);
  await assert.rejects(saveStagedImportImage({ ...input, imageId: "../escape" }), /Invalid image/);
  await assert.rejects(saveStagedImportImage({ ...input, imageId: "IMG2", extension: "svg" }), /extension/);

  const parent = path.join(root, "site-content-import-staging");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-site-import-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  try {
    await fs.symlink(outside, path.join(parent, "SCI-LINK"), "junction");
    await assert.rejects(
      saveStagedImportImage({ ...input, batchId: "SCI-LINK" }),
      /symbolic link|already exists/i
    );
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
  }
});

test("does not trust a caller-provided stage path and can delete a complete batch", async (t) => {
  await withUploadRoot(t);
  const first = await saveStagedImportImage({ batchId: "SCI-3", imageId: "IMG1", extension: "webp", buffer: Buffer.from("1") });
  await saveStagedImportImage({ batchId: "SCI-3", imageId: "IMG2", extension: "png", buffer: Buffer.from("2") });

  await assert.rejects(
    readStagedImportImage({ batchId: "SCI-3", imageId: "IMG1", stagePath: path.resolve(first.stagePath, "..", "..", "outside") }),
    /does not match|escapes/i
  );
  await deleteStagedImportBatch({ batchId: "SCI-3" });
  await assert.rejects(fs.stat(path.dirname(first.stagePath)), { code: "ENOENT" });
  await deleteStagedImportBatch({ batchId: "SCI-3" });
});

test("returns a cleanup-journal target when deletion fails", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const fileSystem = {
    lstat: fs.lstat,
    realpath: fs.realpath,
    unlink: async () => { throw denied; }
  };
  const stagePath = path.resolve(process.env.UPLOAD_ROOT || "/data/uploads", "site-content-import-staging", "SCI-4", "IMG1.png");
  await assert.rejects(
    deleteStagedImportImage({ batchId: "SCI-4", imageId: "IMG1", stagePath, fileSystem }),
    (error) => error === denied && error.cleanupTarget?.filePath === stagePath
  );
});
