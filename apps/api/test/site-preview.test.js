import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { seedDb } from "../src/data/seed.js";
import { buildSitePreview } from "../src/services/site-preview.js";
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

const SENSITIVE_KEYS = new Set([
  "phone", "phonenumber", "mobile", "mobilephone", "email",
  "password", "credential", "credentials", "session", "sessionid", "sessionversion",
  "token", "authorization",
  "user", "userid", "actor", "actorid", "admin", "adminid",
  "audit", "auditlog", "auditlogs", "review", "reviewstatus", "reviewedby",
  "reviewedat", "reviewnote", "reviewnotes", "note", "notes", "internalnote",
  "internalnotes", "remark", "remarks", "rejectreason", "createdby", "updatedby"
]);

function assertPreviewPayloadHasNoSensitiveData(value) {
  if (Array.isArray(value)) {
    value.forEach(assertPreviewPayloadHasNoSensitiveData);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(SENSITIVE_KEYS.has(key.toLowerCase()), false, `preview payload leaked ${key}`);
    assertPreviewPayloadHasNoSensitiveData(child);
  }
}

function eventDraft(eventId, overrides = {}) {
  return {
    eventId,
    slug: "draft-event",
    slogan: "草稿赛事",
    summary: "赛事摘要",
    isVisible: true,
    displayOrder: 0,
    heroMediaId: null,
    ...overrides
  };
}

test("pure preview payloads omit structural sensitive fields without stripping ordinary content numbers", () => {
  const now = "2026-07-22T00:00:00.000Z";
  const homepageDb = structuredClone(seedDb);
  homepageDb.siteSettings.contact = "SITE-CONTACT-13900000000";
  homepageDb.siteSettings.featuredEventId = "wz-aerospace-2026";
  homepageDb.events[0].contact = "EVENT-CONTACT-13900000000";
  homepageDb.eventPublicProfiles.push({ ...eventDraft("wz-aerospace-2026"), version: 1 });
  const homepage = buildSitePreview(homepageDb, "homepage", homepageDb.siteSettings, { now });

  const eventDb = structuredClone(seedDb);
  eventDb.events[0].contact = "EVENT-CONTACT-13900000000";
  const event = buildSitePreview(eventDb, "event", eventDraft("wz-aerospace-2026"), { now });

  const content = buildSitePreview(structuredClone(seedDb), "content", {
    slug: "draft-content",
    eventId: "wz-aerospace-2026",
    type: "news",
    title: "2026 草稿新闻",
    summary: "保留普通数字 100",
    bodyHtml: "<p>2026 年第 100 条内容</p>",
    status: "draft",
    publishAt: null,
    pinned: false,
    sortOrder: 0,
    coverMediaId: null,
    attachments: []
  }, { now });

  for (const preview of [homepage, event, content]) {
    assertPreviewPayloadHasNoSensitiveData(preview.payload);
    assert.doesNotMatch(JSON.stringify(preview.payload), /PASSWORD|SESSION|ADMIN-SENSITIVE/);
  }
  assert.equal(homepage.payload.site.contact, "SITE-CONTACT-13900000000");
  assert.equal(homepage.payload.featuredEvent.contact, "EVENT-CONTACT-13900000000");
  assert.equal(event.payload.event.contact, "EVENT-CONTACT-13900000000");
  assert.match(content.payload.row.bodyHtml, /2026 年第 100 条内容/);
});

test("event preview renders an unpublished event only in its cloned snapshot", () => {
  const db = structuredClone(seedDb);
  db.events[0].status = "draft";
  const before = structuredClone(db);
  const input = eventDraft("wz-aerospace-2026");
  const inputBefore = structuredClone(input);

  const preview = buildSitePreview(db, "event", input, {
    now: "2026-07-22T00:00:00.000Z"
  });

  assert.equal(preview.payload.event.status, "draft");
  assert.deepEqual(preview.payload.event.registrationWindow, { open: false, reason: "赛事尚未发布" });
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(db, before);
});

test("pure content preview accepts an existing draft with its current version", () => {
  const db = structuredClone(seedDb);
  const current = { id: "POST-1", slug: "existing-news", eventId: null, type: "news", title: "已保存标题", summary: "摘要", bodyHtml: "<p>已保存</p>", status: "draft", publishAt: null, pinned: false, sortOrder: 0, coverMediaId: null, version: 4, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" };
  db.contentPosts.push(current);
  const before = structuredClone(db);

  const preview = buildSitePreview(db, "content", { id: current.id, version: current.version, slug: current.slug, eventId: null, type: "news", title: "未保存标题", summary: "新摘要", bodyHtml: "<p>草稿正文</p>", status: "draft", publishAt: null, pinned: false, sortOrder: 0, coverMediaId: null, attachments: [] }, { now: "2026-07-22T00:00:00.000Z" });

  assert.equal(preview.payload.row.title, "未保存标题");
  assert.equal(preview.payload.row.bodyHtml, "<p>草稿正文</p>");

  assert.deepEqual(db, before);
});

test("content preview reuses create and update lifecycle rules on its clone", () => {
  const now = "2026-07-22T00:00:00.000Z";
  const db = structuredClone(seedDb);
  const current = {
    id: "POST-LOCKED",
    slug: "stable-slug",
    eventId: null,
    type: "news",
    title: "已保存标题",
    summary: "摘要",
    bodyHtml: "<p>已保存</p>",
    status: "offline",
    publishAt: "2026-07-01T00:00:00.000Z",
    pinned: false,
    sortOrder: 0,
    coverMediaId: null,
    version: 4,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
  const publishedCurrent = {
    ...current,
    id: "POST-PUBLISHED",
    slug: "published-slug",
    status: "published",
    version: 8
  };
  db.contentPosts.push(current, publishedCurrent);
  db.auditLogs.push({
    id: "AUDIT-CONTENT-PUBLISH",
    action: "content.publish",
    targetId: current.id
  });
  const before = structuredClone(db);

  assert.throws(
    () => buildSitePreview(db, "content", {
      ...current,
      slug: "renamed-after-publish",
      status: "draft",
      publishAt: "2099-01-01T00:00:00.000Z",
      attachments: []
    }, { now }),
    (error) => error?.status === 409 && error?.code === "CONTENT_SLUG_STABLE"
  );
  assert.throws(
    () => buildSitePreview(db, "content", {
      ...current,
      version: current.version - 1,
      status: "draft",
      attachments: []
    }, { now }),
    (error) => error?.status === 409 && error?.code === "CONTENT_VERSION_CONFLICT"
  );

  const offline = buildSitePreview(db, "content", {
    ...current,
    title: "下线内容未保存标题",
    bodyHtml: "<p>下线内容正文</p><script>bad()</script>",
    status: "offline",
    attachments: []
  }, { now });
  assert.equal(offline.payload.row.title, "下线内容未保存标题");
  assert.equal(offline.payload.row.bodyHtml, "<p>下线内容正文</p>");

  const published = buildSitePreview(db, "content", {
    ...publishedCurrent,
    title: "已发布内容未保存标题",
    bodyHtml: "<p>已发布内容正文</p><script>bad()</script>",
    status: "published",
    attachments: []
  }, { now });
  assert.equal(published.payload.row.title, "已发布内容未保存标题");
  assert.equal(published.payload.row.bodyHtml, "<p>已发布内容正文</p>");

  const draft = buildSitePreview(db, "content", {
    ...current,
    status: "draft",
    publishAt: "2099-01-01T00:00:00.000Z",
    attachments: []
  }, { now });
  assert.equal(draft.payload.row.status, undefined);
  assert.equal(draft.payload.row.publishAt, null);

  const created = buildSitePreview(db, "content", {
    slug: "new-preview-content",
    eventId: null,
    type: "news",
    title: "新建草稿",
    summary: "",
    bodyHtml: "<p>新建内容</p>",
    status: "scheduled",
    publishAt: "2099-01-01T00:00:00.000Z",
    pinned: false,
    sortOrder: 0,
    coverMediaId: null,
    attachments: []
  }, { now });
  assert.equal(created.payload.row.publishAt, null);
  assert.deepEqual(db, before);
});

test("admin preview normalizes all three kinds without writing the store", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.siteSettings.contact = "PUBLIC-SITE-CONTACT";
      db.events[0].status = "draft";
      db.events[0].contact = "PUBLIC-EVENT-CONTACT";
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
      db.contentPosts.push(
        {
          id: "POST-PUBLISHED-PREVIEW",
          slug: "published-preview",
          eventId: null,
          type: "news",
          title: "已发布标题",
          summary: "摘要",
          bodyHtml: "<p>已发布正文</p>",
          status: "published",
          publishAt: "2026-07-01T00:00:00.000Z",
          pinned: false,
          sortOrder: 0,
          coverMediaId: null,
          version: 3,
          createdBy: "USER-ADMIN",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z"
        },
        {
          id: "POST-OFFLINE-PREVIEW",
          slug: "offline-preview",
          eventId: null,
          type: "news",
          title: "下线标题",
          summary: "摘要",
          bodyHtml: "<p>下线正文</p>",
          status: "offline",
          publishAt: "2026-06-01T00:00:00.000Z",
          pinned: false,
          sortOrder: 0,
          coverMediaId: null,
          version: 5,
          createdBy: "USER-ADMIN",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z"
        }
      );
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
    const publishedRow = before.contentPosts.find((row) => row.id === "POST-PUBLISHED-PREVIEW");
    const published = await request(baseUrl, admin.cookie, "content", {
      ...publishedRow,
      title: "已发布未保存标题",
      bodyHtml: "<p>已发布未保存正文</p><script>bad()</script>",
      attachments: []
    });
    const offlineRow = before.contentPosts.find((row) => row.id === "POST-OFFLINE-PREVIEW");
    const offline = await request(baseUrl, admin.cookie, "content", {
      ...offlineRow,
      title: "下线未保存标题",
      bodyHtml: "<p>下线未保存正文</p><script>bad()</script>",
      attachments: []
    });

    assert.equal(homepage.status, 200, homepage.body.error);
    assert.equal(event.status, 200, event.body.error);
    assert.equal(content.status, 200, content.body.error);
    assert.equal(published.status, 200, published.body.error);
    assert.equal(offline.status, 200, offline.body.error);
    assert.equal(homepage.headers.get("cache-control"), "private, no-store");
    assert.equal(published.body.preview.payload.row.title, "已发布未保存标题");
    assert.equal(published.body.preview.payload.row.bodyHtml, "<p>已发布未保存正文</p>");
    assert.equal(offline.body.preview.payload.row.title, "下线未保存标题");
    assert.equal(offline.body.preview.payload.row.bodyHtml, "<p>下线未保存正文</p>");
    assert.equal(homepage.body.preview.payload.site.contact, "PUBLIC-SITE-CONTACT");
    assert.equal(event.body.preview.payload.event.contact, "PUBLIC-EVENT-CONTACT");
    assert.doesNotMatch(JSON.stringify(homepage.body.preview), /13900000000/);
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
