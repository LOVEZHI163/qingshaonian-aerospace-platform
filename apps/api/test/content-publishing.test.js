import assert from "node:assert/strict";
import test from "node:test";

import { isPublicPost, normalizeContentInput } from "../src/services/content-publishing.js";
import { sanitizeContentHtml } from "../src/content/sanitize.js";

const now = new Date("2026-07-19T12:00:00.000Z");

function post(overrides = {}) {
  return {
    id: "P1",
    slug: "launch-news",
    type: "news",
    title: "Launch news",
    status: "draft",
    publishAt: null,
    sortOrder: 0,
    version: 4,
    ...overrides
  };
}

test("content visibility only exposes published content at or after its publication time", () => {
  assert.equal(isPublicPost(post({ status: "draft" }), now), false);
  assert.equal(isPublicPost(post({ status: "scheduled", publishAt: "2026-07-18T12:00:00.000Z" }), now), false);
  assert.equal(isPublicPost(post({ status: "published", publishAt: "2026-07-19T12:00:00.000Z" }), now), true);
  assert.equal(isPublicPost(post({ status: "published", publishAt: "2026-07-20T12:00:00.000Z" }), now), false);
});

test("content publishing normalizes valid input and assigns publication time and next version", () => {
  const result = normalizeContentInput({
    slug: "new-launch",
    type: "announcement",
    title: "New launch",
    status: "published",
    sortOrder: 5,
    version: 4
  }, post(), now);

  assert.equal(result.slug, "new-launch");
  assert.equal(result.publishAt, now.toISOString());
  assert.equal(result.sortOrder, 5);
  assert.equal(result.version, 5);
});

test("content publishing validates type, slug, title, state, schedule, and integer order", () => {
  const cases = [
    { type: "article" },
    { slug: "Not A Slug" },
    { title: " " },
    { status: "private" },
    { status: "scheduled", publishAt: "2026-07-19T11:59:59.000Z" },
    { sortOrder: 1.5 }
  ];

  for (const input of cases) {
    assert.throws(() => normalizeContentInput({ ...input, version: 4 }, post(), now), { status: 422 });
  }
});

test("content publishing rejects stale versions with a content conflict code", () => {
  assert.throws(
    () => normalizeContentInput({ version: 3 }, post(), now),
    (error) => error.status === 409 && error.code === "CONTENT_VERSION_CONFLICT"
  );
});

test("content publishing requires a future publish time for scheduled content", () => {
  const result = normalizeContentInput({
    status: "scheduled",
    publishAt: "2026-07-20T12:00:00.000Z",
    version: 4
  }, post(), now);

  assert.equal(result.publishAt, "2026-07-20T12:00:00.000Z");
  assert.equal(result.status, "scheduled");
});

test("sanitize content keeps only the rich text allowlist and safe media paths", () => {
  const clean = sanitizeContentHtml([
    '<p style="color:red" onclick="alert(1)"><strong>Safe</strong><script>alert(2)</script></p>',
    '<a href="javascript:alert(3)" onmouseover="alert(4)">bad</a>',
    '<a href="https://example.test/path">good</a>',
    '<img src="https://evil.test/x.png" onerror="alert(5)">',
    '<img src="/api/public/media/asset-1" alt="cover">',
    '<iframe src="https://evil.test"></iframe>'
  ].join(""));

  assert.match(clean, /<p><strong>Safe<\/strong><\/p>/);
  assert.match(clean, /<a>bad<\/a>/);
  assert.match(clean, /<a href="https:\/\/example\.test\/path">good<\/a>/);
  assert.match(clean, /<img src="\/api\/public\/media\/asset-1" alt="cover" \/>/);
  assert.equal(clean.includes("script"), false);
  assert.equal(clean.includes("onclick"), false);
  assert.equal(clean.includes("onerror"), false);
  assert.equal(clean.includes("style="), false);
  assert.equal(clean.includes("evil.test"), false);
});

test("sanitize content preserves only canonical Bilibili video markers", () => {
  const clean = sanitizeContentHtml([
    '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV" onclick="bad()"><figcaption>比赛<strong>回顾</strong><script>bad()</script></figcaption></figure>',
    '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7L<script>"><figcaption>恶意</figcaption></figure>',
    '<iframe src="https://player.bilibili.com/player.html?bvid=BV1B7411m7LV"></iframe>'
  ].join(""));

  assert.match(clean, /<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>比赛<strong>回顾<\/strong><\/figcaption><\/figure>/);
  assert.equal(clean.includes("onclick"), false);
  assert.equal(clean.includes("BV1B7411m7L<script>"), false);
  assert.equal(clean.includes("iframe"), false);
});

test("sanitize content does not upgrade incomplete or noncanonical Bilibili figures", () => {
  const noncanonicalFigures = [
    '<figure data-bilibili-video="BV1B7411m7LV"><figcaption>缺少 class</figcaption></figure>',
    '<figure class="content-bilibili-video extra" data-bilibili-video="BV1B7411m7LV"><figcaption>额外 class</figcaption></figure>',
    '<figure class="content-bilibili-video"><figcaption>缺少 BV</figcaption></figure>',
    '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7L!"><figcaption>非法 BV</figcaption></figure>',
    '<figure data-bilibili-video="BV1B7411m7LV" data-bilibili-title="伪造"><figcaption>单个 data 属性</figcaption></figure>'
  ];

  for (const html of noncanonicalFigures) {
    const clean = sanitizeContentHtml(html);
    assert.equal(clean.includes('class="content-bilibili-video"'), false);
    assert.equal(clean.includes("data-bilibili-video"), false);
  }
});

test("sanitize content leaves ordinary image figures attribute-free", () => {
  const clean = sanitizeContentHtml('<figure><img src="/api/public/media/aircraft.jpg" alt="航模"><figcaption>飞行展示</figcaption></figure>');

  assert.equal(clean, '<figure><img src="/api/public/media/aircraft.jpg" alt="航模" /><figcaption>飞行展示</figcaption></figure>');
});
