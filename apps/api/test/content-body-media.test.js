import assert from "node:assert/strict";
import test from "node:test";

import { contentBodyMedia, contentBodyMediaIds } from "../src/services/content-body-media.js";

test("extracts unique media ids from sanitized body html in document order", () => {
  assert.deepEqual(contentBodyMediaIds([
    '<p>开头</p><img src="/api/public/media/M2" alt="二">',
    '<figure><img src="/api/public/media/M1"><figcaption>一</figcaption></figure>',
    '<img src="/api/public/media/M2">'
  ].join("")), ["M2", "M1"]);
});

test("extracts ids only from sanitized img src attributes", () => {
  const html = [
    '<a href="https://example.test/api/public/media/LINK">link</a>',
    '<img src="/api/public/media/IMAGE" alt="/api/public/media/ALT">'
  ].join("");

  assert.deepEqual(contentBodyMediaIds(html), ["IMAGE"]);
  assert.doesNotThrow(() => contentBodyMedia({ mediaAssets: [
    { id: "IMAGE", mimeType: "image/png", cleanedAt: null }
  ] }, html));
});

test("rejects missing and non-image body media", () => {
  const db = { mediaAssets: [
    { id: "PDF", mimeType: "application/pdf", cleanedAt: null }
  ] };
  assert.throws(
    () => contentBodyMedia(db, '<img src="/api/public/media/MISSING">'),
    (error) => error.status === 422 && error.code === "CONTENT_BODY_MEDIA_INVALID"
  );
  assert.throws(
    () => contentBodyMedia(db, '<img src="/api/public/media/PDF">'),
    (error) => error.status === 422 && error.code === "CONTENT_BODY_MEDIA_INVALID"
  );
});
