import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function request(baseUrl, cookie, kind, body) {
  const response = await fetch(`${baseUrl}/api/admin/site-preview/${kind}`, withSession(cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function mutateDb(dbPath, mutate) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutate(db);
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
}

test("admin preview normalizes all three kinds without writing the store", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.mediaAssets.push({
        id: "MEDIA-PRIVATE",
        eventId: "wz-aerospace-2026",
        visibility: "draft",
        originalName: "private.png",
        mimeType: "image/png",
        sizeBytes: 1,
        width: 1,
        height: 1,
        variants: {},
        cleanedAt: null
      });
    });
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const before = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const homepage = await request(baseUrl, admin.cookie, "homepage", {
      ...before.siteSettings,
      platformIntro: "草稿首页"
    });
    const event = await request(baseUrl, admin.cookie, "event", {
      eventId: "wz-aerospace-2026",
      slug: "preview-event",
      slogan: "草稿赛事",
      summary: "赛事摘要",
      isVisible: true,
      displayOrder: 0,
      heroMediaId: "MEDIA-PRIVATE"
    });
    const content = await request(baseUrl, admin.cookie, "content", {
      slug: "preview-content",
      eventId: "wz-aerospace-2026",
      type: "news",
      title: "草稿新闻",
      summary: "新闻摘要",
      bodyHtml: '<p onclick="alert(1)">正文</p><script>alert(1)</script>',
      status: "draft",
      publishAt: null,
      pinned: false,
      sortOrder: 0,
      coverMediaId: "MEDIA-PRIVATE",
      attachments: []
    });

    assert.equal(homepage.status, 200, homepage.body.error);
    assert.equal(event.status, 200, event.body.error);
    assert.equal(content.status, 200, content.body.error);
    assert.equal(homepage.headers.get("cache-control"), "private, no-store");
    assert.equal(event.body.preview.payload.event.hero.url, "/api/admin/site-media/MEDIA-PRIVATE/preview");
    assert.equal(content.body.preview.payload.row.bodyHtml, "<p>正文</p>");
    assert.equal(content.body.preview.payload.row.cover.url, "/api/admin/site-media/MEDIA-PRIVATE/preview");
    assert.deepEqual(JSON.parse(await fs.readFile(dbPath, "utf8")), before);
  }, { prefix: "site-preview-api-" });
});

test("preview rejects ordinary users, invalid kinds and foreign media", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.mediaAssets.push({
        id: "MEDIA-FOREIGN",
        eventId: "foreign-event",
        visibility: "draft",
        originalName: "foreign.png",
        mimeType: "image/png",
        sizeBytes: 1,
        width: 1,
        height: 1,
        variants: {},
        cleanedAt: null
      });
    });
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    assert.equal((await request(baseUrl, ordinary.cookie, "homepage", {})).status, 403);
    assert.equal((await request(baseUrl, admin.cookie, "unknown", {})).status, 404);
    assert.equal((await request(baseUrl, admin.cookie, "event", {
      eventId: "wz-aerospace-2026",
      slug: "foreign-media",
      isVisible: true,
      displayOrder: 0,
      heroMediaId: "MEDIA-FOREIGN"
    })).status, 422);
  }, { prefix: "site-preview-reject-" });
});
