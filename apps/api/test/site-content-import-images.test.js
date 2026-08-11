import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { retryArticleImage, stageArticleImages } from "../src/services/site-content-import/image-import.js";

async function image(format, width = 1200, height = 800) {
  return sharp({ create: { width, height, channels: 3, background: "#1684d8" } })[format]().toBuffer();
}

function resource(buffer, contentType, finalUrl = "https://cdn.example.test/photo") {
  return { buffer, finalUrl, headers: { "content-type": contentType } };
}

test("keeps real JPG, PNG and WebP article images and marks the first as cover candidate", async () => {
  const buffers = {
    IMG1: await image("jpeg"), IMG2: await image("png"), IMG3: await image("webp")
  };
  const saved = [];
  const images = await stageArticleImages({
    batchId: "SCI-1",
    candidates: Object.keys(buffers).map((id) => ({ id, url: `https://cdn.example.test/${id}` })),
    fetchResource: async (url) => resource(buffers[url.split("/").at(-1)], "image/jpeg", url),
    saveImage: async (value) => { saved.push(value); return { stagePath: `/staging/${value.imageId}.${value.extension}` }; }
  });

  assert.deepEqual(images.map((entry) => entry.status), ["ready", "ready", "ready"]);
  assert.deepEqual(images.map((entry) => entry.mimeType), ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(images[0].coverCandidate, true);
  assert.equal(images[1].coverCandidate, false);
  assert.deepEqual(saved.map((entry) => entry.extension), ["jpg", "png", "webp"]);
});

test("filters branding, QR, advertisement, tracker, tiny, extreme-ratio and fake images with stable reasons", async () => {
  const normal = await image("png");
  const tiny = await image("png", 80, 80);
  const tracker = await image("png", 1, 1);
  const extreme = await image("png", 1200, 60);
  const candidates = [
    { id: "QR", url: "https://cdn.example.test/qrcode.png", alt: "扫码关注" },
    { id: "LOGO", url: "https://cdn.example.test/site-logo.png" },
    { id: "AD", url: "https://cdn.example.test/banner-ad.png", title: "广告" },
    { id: "TINY", url: "https://cdn.example.test/tiny.png" },
    { id: "TRACKER", url: "https://cdn.example.test/pixel.png" },
    { id: "EXTREME", url: "https://cdn.example.test/extreme.png" },
    { id: "FAKE", url: "https://cdn.example.test/fake.jpg" },
    { id: "OK", url: "https://cdn.example.test/article.png", alt: "活动现场" }
  ];
  const byId = { QR: normal, LOGO: normal, AD: normal, TINY: tiny, TRACKER: tracker, EXTREME: extreme, FAKE: Buffer.from("%PDF-1.7"), OK: normal };
  const images = await stageArticleImages({
    batchId: "SCI-2",
    candidates,
    fetchResource: async (url) => {
      const id = candidates.find((candidate) => candidate.url === url).id;
      return resource(byId[id], "image/png", url);
    },
    saveImage: async ({ imageId, extension }) => ({ stagePath: `/staging/${imageId}.${extension}` })
  });

  const byResultId = Object.fromEntries(images.map((entry) => [entry.id, entry]));
  for (const id of ["QR", "LOGO", "AD", "TINY", "TRACKER", "EXTREME", "FAKE"]) {
    assert.notEqual(byResultId[id].status, "ready", id);
    assert.match(byResultId[id].reasonCode, /^IMPORT_IMAGE_/);
    assert.ok(byResultId[id].reason, id);
  }
  assert.equal(byResultId.OK.status, "ready");
});

test("enforces per-image, count, and batch-byte limits without aborting the batch", async () => {
  const validJpegPrefix = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  const candidates = Array.from({ length: 22 }, (_, index) => ({ id: `IMG${index + 1}`, url: `https://cdn.example.test/${index + 1}.jpg` }));
  const images = await stageArticleImages({
    batchId: "SCI-3",
    candidates,
    fetchResource: async (url) => {
      const index = Number(new URL(url).pathname.slice(1, -4));
      const length = index === 1 ? 5 * 1024 * 1024 + 1 : 3 * 1024 * 1024;
      return resource(Buffer.concat([validJpegPrefix, Buffer.alloc(length - validJpegPrefix.length)]), "image/jpeg", url);
    },
    saveImage: async ({ imageId }) => ({ stagePath: `/staging/${imageId}.jpg` }),
    inspectImage: async () => ({ mimeType: "image/jpeg", extension: "jpg", width: 1200, height: 800, normalizedBuffer: Buffer.alloc(3 * 1024 * 1024) })
  });

  assert.equal(images[0].reasonCode, "IMPORT_IMAGE_TOO_LARGE");
  assert.equal(images.filter((entry) => entry.status === "ready").length, 16);
  assert.equal(images.some((entry) => entry.reasonCode === "IMPORT_IMAGE_BATCH_LIMIT"), true);
  assert.equal(images.filter((entry) => entry.reasonCode === "IMPORT_IMAGE_COUNT_LIMIT").length, 2);
});

test("records fetch failures and can retry one failed image in place", async () => {
  const png = await image("png");
  const [failed] = await stageArticleImages({
    batchId: "SCI-4",
    candidates: [{ id: "IMG1", url: "https://cdn.example.test/retry.png" }],
    fetchResource: async () => { throw Object.assign(new Error("timeout"), { code: "IMPORT_FETCH_TIMEOUT" }); },
    saveImage: async () => { throw new Error("must not save"); }
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reasonCode, "IMPORT_IMAGE_FETCH_FAILED");

  const batch = { id: "SCI-4", images: [failed] };
  const retried = await retryArticleImage({
    batch,
    imageId: "IMG1",
    fetchResource: async (url) => resource(png, "image/png", url),
    saveImage: async ({ imageId, extension }) => ({ stagePath: `/staging/${imageId}.${extension}` })
  });
  assert.equal(retried.status, "ready");
  assert.equal(batch.images[0].status, "ready");
});
