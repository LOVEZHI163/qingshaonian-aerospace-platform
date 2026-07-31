import assert from "node:assert/strict";
import test from "node:test";

import {
  assertVideoUploadCapacity,
  readStorageStatus,
  UPLOAD_CRITICAL_PERCENT,
  UPLOAD_WARNING_PERCENT
} from "../src/services/system-storage.js";

function fileSystemFor(availableBlocks) {
  return {
    access: async () => {},
    statfs: async () => ({ bsize: 1, blocks: 100, bfree: availableBlocks, bavail: availableBlocks })
  };
}

test("reports actual upload-volume usage and warning thresholds", async () => {
  const normal = await readStorageStatus({ uploadRoot: "/uploads", fileSystem: fileSystemFor(20.01) });
  const warning = await readStorageStatus({ uploadRoot: "/uploads", fileSystem: fileSystemFor(20) });
  const critical = await readStorageStatus({ uploadRoot: "/uploads", fileSystem: fileSystemFor(10) });

  assert.equal(UPLOAD_WARNING_PERCENT, 80);
  assert.equal(UPLOAD_CRITICAL_PERCENT, 90);
  assert.equal(normal.disk.usedPercent, 79.99);
  assert.equal(normal.level, "normal");
  assert.equal(warning.disk.usedPercent, 80);
  assert.equal(warning.level, "warning");
  assert.equal(critical.disk.usedPercent, 90);
  assert.equal(critical.level, "critical");
});

test("blocks only a video that is already critical or would reach 90 percent", async () => {
  const warning = await readStorageStatus({ uploadRoot: "/uploads", fileSystem: fileSystemFor(15) });
  const critical = await readStorageStatus({ uploadRoot: "/uploads", fileSystem: fileSystemFor(10) });

  assert.doesNotThrow(() => assertVideoUploadCapacity(warning, 4));
  assert.throws(() => assertVideoUploadCapacity(warning, 5), /磁盘空间严重不足/);
  assert.throws(() => assertVideoUploadCapacity(critical, 1), /磁盘空间严重不足/);
});
