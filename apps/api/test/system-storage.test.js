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

test("reads only valid warning and critical thresholds from the environment", async () => {
  const custom = await readStorageStatus({
    uploadRoot: "/uploads", fileSystem: fileSystemFor(25),
    environment: { UPLOAD_WARNING_PERCENT: "70", UPLOAD_CRITICAL_PERCENT: "80" }
  });
  assert.equal(custom.level, "warning");
  assert.deepEqual(custom.thresholds, { warningPercent: 70, criticalPercent: 80 });

  const fallback = await readStorageStatus({
    uploadRoot: "/uploads", fileSystem: fileSystemFor(21),
    environment: { UPLOAD_WARNING_PERCENT: "90", UPLOAD_CRITICAL_PERCENT: "80" }
  });
  assert.equal(fallback.level, "normal");
  assert.deepEqual(fallback.thresholds, { warningPercent: 80, criticalPercent: 90 });

  const blank = await readStorageStatus({
    uploadRoot: "/uploads", fileSystem: fileSystemFor(21),
    environment: { UPLOAD_WARNING_PERCENT: "", UPLOAD_CRITICAL_PERCENT: "80" }
  });
  assert.deepEqual(blank.thresholds, { warningPercent: 80, criticalPercent: 90 });

  const decimal = await readStorageStatus({
    uploadRoot: "/uploads", fileSystem: fileSystemFor(25),
    environment: { UPLOAD_WARNING_PERCENT: "70.5", UPLOAD_CRITICAL_PERCENT: "80.5" }
  });
  assert.equal(decimal.level, "warning");
  assert.deepEqual(decimal.thresholds, { warningPercent: 70.5, criticalPercent: 80.5 });
});
