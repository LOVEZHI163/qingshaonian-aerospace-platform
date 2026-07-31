import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  deleteSubmissionFile,
  inspectSubmissionFile,
  probeVideo,
  readSubmissionRange
} from "../src/files/submission-storage.js";

const IMAGE_WARNING = "作品图片长边低于建议的 780 像素";
const VIDEO_WARNING = "制作视频分辨率低于建议的 720P";

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function makeFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-submission-storage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeMp4(directory, name = "creation.mp4") {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32
  ]));
  return filePath;
}

test("inspects a PNG image signature and returns its dimensions", async (t) => {
  const directory = await makeFixture(t);
  const pngPath = path.join(directory, "work.png");
  await sharp({ create: { width: 800, height: 600, channels: 3, background: "#0a6" } }).png().toFile(pngPath);

  const valid = await inspectSubmissionFile({ kind: "artwork_image", filePath: pngPath, originalName: "作品.png" });

  assert.deepEqual(valid.warnings, []);
  assert.equal(valid.mimeType, "image/png");
  assert.equal(valid.width, 800);
  assert.equal(valid.height, 600);
  assert.equal(valid.durationMs, null);
});

test("keeps valid low-resolution images and reports the recommendation", async (t) => {
  const directory = await makeFixture(t);
  const jpgPath = path.join(directory, "small.jpg");
  await sharp({ create: { width: 640, height: 360, channels: 3, background: "#08a" } }).jpeg().toFile(jpgPath);

  const lowResolution = await inspectSubmissionFile({ kind: "artwork_image", filePath: jpgPath, originalName: "小图.jpg" });

  assert.deepEqual(lowResolution.warnings, [IMAGE_WARNING]);
  assert.equal(lowResolution.mimeType, "image/jpeg");
});

test("rejects image files with an unsupported signature", async (t) => {
  const directory = await makeFixture(t);
  const gifPath = path.join(directory, "work.gif");
  const pdfPath = path.join(directory, "renamed.png");
  await fs.writeFile(gifPath, Buffer.from("GIF89a"));
  await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7\n"));

  await assert.rejects(
    inspectSubmissionFile({ kind: "artwork_image", filePath: gifPath, originalName: "work.gif" }),
    /图片.*PNG.*JPEG/
  );
  await assert.rejects(
    inspectSubmissionFile({ kind: "artwork_image", filePath: pdfPath, originalName: "renamed.png" }),
    /图片.*PNG.*JPEG/
  );
});

test("rejects an image over 2MB using file stat before decoding it", async (t) => {
  const directory = await makeFixture(t);
  const imagePath = path.join(directory, "large.png");
  const handle = await fs.open(imagePath, "w");
  await handle.truncate(2 * 1024 * 1024 + 1);
  await handle.close();

  await assert.rejects(
    inspectSubmissionFile({ kind: "artwork_image", filePath: imagePath, originalName: "large.png" }),
    /图片文件超过 2MB 限制/
  );
});

test("inspects a real MP4 signature with injected video metadata", async (t) => {
  const directory = await makeFixture(t);
  const mp4Path = await writeMp4(directory);
  const valid = await inspectSubmissionFile({
    kind: "creation_video",
    filePath: mp4Path,
    originalName: "作画.mp4",
    probeVideo: async () => ({ durationMs: 119_900, width: 1280, height: 720 })
  });

  assert.equal(valid.mimeType, "video/mp4");
  assert.equal(valid.durationMs, 119_900);
  assert.equal(valid.width, 1280);
  assert.deepEqual(valid.warnings, []);
});

test("rejects overlong videos and warns without rejecting sub-720P videos", async (t) => {
  const directory = await makeFixture(t);
  const mp4Path = await writeMp4(directory);

  await assert.rejects(
    inspectSubmissionFile({
      kind: "creation_video", filePath: mp4Path, originalName: "long.mp4",
      probeVideo: async () => ({ durationMs: 120_001, width: 1280, height: 720 })
    }),
    /视频时长超过 120 秒限制/
  );
  await assert.rejects(
    inspectSubmissionFile({
      kind: "creation_video", filePath: mp4Path, originalName: "rounded-long.mp4",
      probeVideo: async () => ({ durationMs: 120_000.4, width: 1280, height: 720 })
    }),
    /视频时长超过 120 秒限制/
  );

  const lowResolution = await inspectSubmissionFile({
    kind: "creation_video", filePath: mp4Path, originalName: "small.mp4",
    probeVideo: async () => ({ durationMs: 5_000, width: 640, height: 360 })
  });
  assert.deepEqual(lowResolution.warnings, [VIDEO_WARNING]);
});

test("probes video metadata through ffprobe with an argument array", async () => {
  const calls = [];
  const metadata = await probeVideo("C:/uploads/creation.mp4", async (...args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify({
        format: { duration: "12.345" },
        streams: [{ codec_type: "audio", width: 0, height: 0 }, { codec_type: "video", width: 1280, height: 720 }]
      })
    };
  });

  assert.deepEqual(calls, [["ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    "C:/uploads/creation.mp4"
  ]]]);
  assert.deepEqual(metadata, { durationMs: 12_345, width: 1280, height: 720 });
});

test("rejects a raw ffprobe duration that exceeds 120 seconds before display rounding", async (t) => {
  const directory = await makeFixture(t);
  const mp4Path = await writeMp4(directory);
  const probeWithFractionalOverrun = (filePath) => probeVideo(filePath, async () => ({
    stdout: JSON.stringify({
      format: { duration: "120.0004" },
      streams: [{ codec_type: "video", width: 1280, height: 720 }]
    })
  }));

  await assert.rejects(
    inspectSubmissionFile({
      kind: "creation_video", filePath: mp4Path, originalName: "fractional-long.mp4",
      probeVideo: probeWithFractionalOverrun
    }),
    /视频时长超过 120 秒限制/
  );
});

test("rejects non-MP4 signatures and oversized videos before probing", async (t) => {
  const directory = await makeFixture(t);
  const pdfPath = path.join(directory, "fake.mp4");
  await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7\n"));
  await assert.rejects(
    inspectSubmissionFile({
      kind: "creation_video", filePath: pdfPath, originalName: "fake.mp4",
      probeVideo: async () => ({ durationMs: 1, width: 1280, height: 720 })
    }),
    /视频必须为真实的 MP4 文件/
  );

  const largePath = path.join(directory, "large.mp4");
  const handle = await fs.open(largePath, "w");
  await handle.truncate(200 * 1024 * 1024 + 1);
  await handle.close();
  let probed = false;
  await assert.rejects(
    inspectSubmissionFile({
      kind: "creation_video", filePath: largePath, originalName: "large.mp4",
      probeVideo: async () => { probed = true; return { durationMs: 1, width: 1280, height: 720 }; }
    }),
    /视频文件超过 200MB 限制/
  );
  assert.equal(probed, false);
});

test("serves exact single video byte ranges and rejects malformed or multi-range requests", async (t) => {
  const directory = await makeFixture(t);
  const filePath = path.join(directory, "creation.mp4");
  await fs.writeFile(filePath, Buffer.from("0123456789"));
  const record = { filePath, mimeType: "video/mp4" };

  const full = await readSubmissionRange(record);
  assert.equal(full.status, 200);
  assert.deepEqual(full.headers, {
    "Content-Type": "video/mp4",
    "Content-Length": "10",
    "Accept-Ranges": "bytes"
  });
  assert.equal((await readStream(full.stream)).toString(), "0123456789");

  const explicit = await readSubmissionRange(record, "bytes=2-5");
  assert.equal(explicit.status, 206);
  assert.deepEqual(explicit.headers, {
    "Content-Type": "video/mp4",
    "Content-Length": "4",
    "Accept-Ranges": "bytes",
    "Content-Range": "bytes 2-5/10"
  });
  assert.equal((await readStream(explicit.stream)).toString(), "2345");

  const suffix = await readSubmissionRange(record, "bytes=-3");
  assert.equal(suffix.headers["Content-Range"], "bytes 7-9/10");
  assert.equal((await readStream(suffix.stream)).toString(), "789");

  const openEnded = await readSubmissionRange(record, "bytes=6-");
  assert.equal(openEnded.headers["Content-Range"], "bytes 6-9/10");
  assert.equal((await readStream(openEnded.stream)).toString(), "6789");

  const oversizedSuffix = await readSubmissionRange(record, "bytes=-99");
  assert.equal(oversizedSuffix.headers["Content-Range"], "bytes 0-9/10");
  assert.equal((await readStream(oversizedSuffix.stream)).toString(), "0123456789");

  await assert.rejects(readSubmissionRange(record, "bytes=0-1,4-5"), (error) => {
    assert.equal(error.status, 416);
    assert.equal(error.headers["Content-Range"], "bytes */10");
    return true;
  });
  await assert.rejects(readSubmissionRange(record, "bytes=10-"), (error) => error.status === 416);

  const emptyPath = path.join(directory, "empty.mp4");
  await fs.writeFile(emptyPath, "");
  await assert.rejects(readSubmissionRange({ filePath: emptyPath, mimeType: "video/mp4" }, "bytes=-1"), (error) => error.status === 416);
});

function submissionRecord(uploadRoot, id = "SA1", storedName = "original.mp4") {
  return {
    id,
    storedName,
    filePath: path.join(uploadRoot, "submission-assets", id, storedName)
  };
}

test("deletes a file only from its controlled submission-assets directory", async (t) => {
  const directory = await makeFixture(t);
  const record = submissionRecord(directory);
  await fs.mkdir(path.dirname(record.filePath), { recursive: true });
  await fs.writeFile(record.filePath, "video");

  await deleteSubmissionFile(record, { uploadRoot: directory });

  await assert.rejects(fs.access(record.filePath), { code: "ENOENT" });
});

test("deletes a replacement file from its controlled source directory when the registration asset id remains stable", async (t) => {
  const directory = await makeFixture(t);
  const record = submissionRecord(directory, "SA-bound", "replacement.mp4");
  record.filePath = path.join(directory, "submission-assets", "SA-source", "replacement.mp4");
  await fs.mkdir(path.dirname(record.filePath), { recursive: true });
  await fs.writeFile(record.filePath, "video");

  await deleteSubmissionFile(record, { uploadRoot: directory });

  await assert.rejects(fs.access(record.filePath), { code: "ENOENT" });
});

test("refuses to delete a submission record outside the controlled upload root", async (t) => {
  const uploadRoot = await makeFixture(t);
  const outsidePath = path.join(os.tmpdir(), `aerogp-submission-outside-${crypto.randomUUID()}.mp4`);
  await fs.writeFile(outsidePath, "outside");
  t.after(() => fs.rm(outsidePath, { force: true }));
  const record = { id: "SA1", storedName: "original.mp4", filePath: outsidePath };

  await assert.rejects(
    deleteSubmissionFile(record, { uploadRoot }),
    /escapes controlled submission directory/i
  );
  assert.equal((await fs.readFile(outsidePath)).toString(), "outside");
});

test("refuses to follow a symbolic link from the controlled submission directory", async (t) => {
  const uploadRoot = await makeFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-submission-linked-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const parent = path.join(uploadRoot, "submission-assets");
  const linkedDirectory = path.join(parent, "SA1");
  const victim = path.join(outside, "original.mp4");
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(victim, "outside");
  await fs.symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  const record = submissionRecord(uploadRoot);

  await assert.rejects(
    deleteSubmissionFile(record, { uploadRoot }),
    /symbolic link|escapes controlled submission directory/i
  );
  assert.equal((await fs.readFile(victim)).toString(), "outside");
});
