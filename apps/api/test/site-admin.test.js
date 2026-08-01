import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { isPublicPost } from "../src/services/content-publishing.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const EVENT_ID = "wz-aerospace-2026";

async function readDb(dbPath) {
  return JSON.parse(await fs.readFile(dbPath, "utf8"));
}

async function mutateDb(dbPath, mutation) {
  const db = await readDb(dbPath);
  mutation(db);
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
  return db;
}

async function jsonRequest(url, cookie, method, body) {
  return fetch(url, withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
}

function contentInput(overrides = {}) {
  return {
    slug: "flight-news",
    eventId: EVENT_ID,
    type: "news",
    title: "飞行新闻",
    summary: "摘要",
    bodyHtml: "<p>正文</p>",
    pinned: false,
    sortOrder: 0,
    coverMediaId: null,
    attachments: [],
    ...overrides
  };
}

const WRITE_ENDPOINTS = [
  ["PATCH", "/api/admin/site-settings", { version: 1, contact: "0577" }],
  ["PUT", `/api/admin/event-public-profiles/${EVENT_ID}`, { slug: "current-event", isVisible: true, displayOrder: 0 }],
  ["POST", "/api/admin/content", contentInput()],
  ["PATCH", "/api/admin/content/missing", { version: 1, title: "更新" }],
  ["DELETE", "/api/admin/content/missing", { version: 1 }],
  ["POST", "/api/admin/content/missing/publish", { version: 1 }],
  ["POST", "/api/admin/content/missing/offline", { version: 1 }]
];

test("site admin write APIs require login, administrator role, and a changed temporary password", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const temporaryAdmin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      db.users.find((user) => user.id === temporaryAdmin.user.id).mustChangePassword = true;
    });

    for (const [method, path, body] of WRITE_ENDPOINTS) {
      const anonymous = await jsonRequest(`${baseUrl}${path}`, null, method, body);
      assert.equal(anonymous.status, 401, `${method} ${path} anonymous`);

      const forbidden = await jsonRequest(`${baseUrl}${path}`, ordinary.cookie, method, body);
      assert.equal(forbidden.status, 403, `${method} ${path} ordinary user`);

      const passwordRequired = await jsonRequest(`${baseUrl}${path}`, temporaryAdmin.cookie, method, body);
      assert.equal(passwordRequired.status, 428, `${method} ${path} temporary password`);
    }
  }, { prefix: "site-admin-auth-" });
});

test("site admin settings use a strict whitelist, visible featured events, versions, and audit", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      db.eventPublicProfiles.push({
        eventId: EVENT_ID,
        slug: "current-event",
        slogan: "",
        summary: "",
        isVisible: false,
        displayOrder: 0,
        heroMediaId: null,
        version: 1,
        updatedAt: "2026-07-19T00:00:00.000Z"
      });
    });

    const hidden = await jsonRequest(`${baseUrl}/api/admin/site-settings`, admin.cookie, "PATCH", {
      version: 1,
      featuredEventId: EVENT_ID
    });
    assert.equal(hidden.status, 422);

    await mutateDb(dbPath, (db) => {
      db.eventPublicProfiles[0].isVisible = true;
      db.events[0].status = "draft";
    });
    const draftEvent = await jsonRequest(`${baseUrl}/api/admin/site-settings`, admin.cookie, "PATCH", {
      version: 1,
      featuredEventId: EVENT_ID
    });
    assert.equal(draftEvent.status, 422);

    await mutateDb(dbPath, (db) => { db.events[0].status = "published"; });
    const updated = await jsonRequest(`${baseUrl}/api/admin/site-settings`, admin.cookie, "PATCH", {
      version: 1,
      featuredEventId: EVENT_ID,
      platformIntro: "青少年航空平台",
      organizers: ["主办单位"],
      contact: "0577-12345678",
      icp: "浙ICP备00000000号",
      seoTitle: "航空比赛",
      seoDescription: "赛事资讯",
      defaultHeroMediaId: null,
      shareMediaId: null,
      platformName: "伪造名称",
      id: "forged",
      updatedAt: "2000-01-01T00:00:00.000Z"
    });
    const payload = await updated.json();
    assert.equal(updated.status, 200, payload.error);
    assert.equal(payload.row.platformName, "温州市青少年航空航天创新比赛");
    assert.equal(payload.row.id, "default");
    assert.equal(payload.row.version, 2);

    const stale = await jsonRequest(`${baseUrl}/api/admin/site-settings`, admin.cookie, "PATCH", {
      version: 1,
      contact: "stale"
    });
    assert.equal(stale.status, 409);

    const persisted = await readDb(dbPath);
    assert.equal(persisted.siteSettings.contact, "0577-12345678");
    assert.ok(persisted.auditLogs.some((row) => row.action === "site.settings.update" && row.targetId === "default"));
  }, { prefix: "site-admin-settings-" });
});

test("site admin event public profiles validate events, unique and stable slugs, and versions", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const missing = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/not-an-event`, admin.cookie, "PUT", {
      slug: "missing-event",
      isVisible: true,
      displayOrder: 0
    });
    assert.equal(missing.status, 422);

    const created = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      slug: "current-event",
      slogan: "逐梦蓝天",
      summary: "赛事简介",
      isVisible: true,
      displayOrder: 0,
      heroMediaId: null
    });
    const profile = (await created.json()).row;
    assert.equal(created.status, 201);
    assert.equal(profile.version, 1);

    await mutateDb(dbPath, (db) => {
      db.events.push({ ...db.events[0], id: "E2", name: "第二场赛事", isCurrent: false });
    });
    const duplicate = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/E2`, admin.cookie, "PUT", {
      slug: "current-event",
      isVisible: false,
      displayOrder: 1
    });
    assert.equal(duplicate.status, 409);

    const stale = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: 0,
      slug: "current-event",
      isVisible: true,
      displayOrder: 0
    });
    assert.equal(stale.status, 409);

    await mutateDb(dbPath, (db) => {
      db.contentPosts.push({
        id: "PUBLIC-POST",
        slug: "published-story",
        eventId: EVENT_ID,
        type: "news",
        title: "已发布内容",
        summary: "",
        bodyHtml: "<p>正文</p>",
        status: "published",
        publishAt: "2026-07-19T00:00:00.000Z",
        pinned: false,
        sortOrder: 0,
        coverMediaId: null,
        version: 1,
        createdBy: admin.user.id,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z"
      });
    });
    const unstable = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: 1,
      slug: "changed-event",
      isVisible: true,
      displayOrder: 0
    });
    assert.equal(unstable.status, 409);

    const list = await fetch(`${baseUrl}/api/admin/event-public-profiles`, withSession(admin.cookie));
    assert.equal(list.status, 200);
    assert.ok((await list.json()).rows.some((row) => row.eventId === EVENT_ID && row.event?.id === EVENT_ID));
  }, { prefix: "site-admin-profiles-" });
});

test("a current draft may be shown as an event while its content still cannot be published", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      db.events.find((event) => event.id === EVENT_ID).status = "draft";
    });

    const profile = await jsonRequest(
      `${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`,
      admin.cookie,
      "PUT",
      {
        slug: "draft-event",
        isVisible: true,
        displayOrder: 0,
        allowUnpublishedVisibility: true
      }
    );
    assert.equal(profile.status, 201);
    assert.equal((await profile.json()).row.isVisible, true);

    const created = await jsonRequest(
      `${baseUrl}/api/admin/content`,
      admin.cookie,
      "POST",
      contentInput({ slug: "draft-event-news" })
    );
    const row = (await created.json()).row;

    const scheduled = await jsonRequest(
      `${baseUrl}/api/admin/content/${row.id}`,
      admin.cookie,
      "PATCH",
      { version: row.version, status: "scheduled", publishAt: "2100-01-01T00:00:00.000Z" }
    );
    assert.equal(scheduled.status, 422);
    assert.equal((await scheduled.json()).code, "CONTENT_EVENT_NOT_PUBLISHED");

    const published = await jsonRequest(
      `${baseUrl}/api/admin/content/${row.id}/publish`,
      admin.cookie,
      "POST",
      { version: row.version }
    );
    assert.equal(published.status, 422);
    assert.equal((await published.json()).code, "CONTENT_EVENT_NOT_PUBLISHED");
  }, { prefix: "draft-event-publication-" });
});

test("empty content body rejects scheduling and publishing", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const created = await jsonRequest(
      `${baseUrl}/api/admin/content`,
      admin.cookie,
      "POST",
      contentInput({ slug: "empty-body-news", bodyHtml: "" })
    );
    const row = (await created.json()).row;

    const scheduled = await jsonRequest(
      `${baseUrl}/api/admin/content/${row.id}`,
      admin.cookie,
      "PATCH",
      { version: row.version, status: "scheduled", publishAt: "2100-01-01T00:00:00.000Z" }
    );
    assert.equal(scheduled.status, 422);
    assert.equal((await scheduled.json()).code, "CONTENT_BODY_REQUIRED");

    const published = await jsonRequest(
      `${baseUrl}/api/admin/content/${row.id}/publish`,
      admin.cookie,
      "POST",
      { version: row.version }
    );
    assert.equal(published.status, 422);
    assert.equal((await published.json()).code, "CONTENT_BODY_REQUIRED");
  }, { prefix: "empty-content-publication-" });
});

test("site admin content CRUD defaults to drafts, rejects conflicts, and preserves creator fields", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const invalidEvent = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", contentInput({
      slug: "invalid-event",
      eventId: "missing"
    }));
    assert.equal(invalidEvent.status, 422);

    const created = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", contentInput({
      status: "published",
      createdBy: "forged",
      createdAt: "2000-01-01T00:00:00.000Z"
    }));
    const row = (await created.json()).row;
    assert.equal(created.status, 201);
    assert.equal(row.status, "draft");
    assert.equal(row.createdBy, admin.user.id);
    assert.notEqual(row.createdAt, "2000-01-01T00:00:00.000Z");

    const duplicate = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", contentInput({ title: "重复" }));
    assert.equal(duplicate.status, 409);

    const stale = await jsonRequest(`${baseUrl}/api/admin/content/${row.id}`, admin.cookie, "PATCH", {
      version: 0,
      title: "陈旧修改"
    });
    assert.equal(stale.status, 409);

    const patched = await jsonRequest(`${baseUrl}/api/admin/content/${row.id}`, admin.cookie, "PATCH", {
      version: row.version,
      title: "更新标题",
      createdBy: "forged",
      createdAt: "2000-01-01T00:00:00.000Z"
    });
    const next = (await patched.json()).row;
    assert.equal(patched.status, 200);
    assert.equal(next.title, "更新标题");
    assert.equal(next.createdBy, admin.user.id);
    assert.equal(next.createdAt, row.createdAt);
    assert.equal(next.version, row.version + 1);

    const detail = await fetch(`${baseUrl}/api/admin/content/${row.id}`, withSession(admin.cookie));
    const detailPayload = await detail.json();
    assert.equal(detail.status, 200);
    assert.deepEqual(detailPayload.row.attachments, []);
    assert.equal(detailPayload.row.previewHtml, "<p>正文</p>");

    const list = await fetch(`${baseUrl}/api/admin/content`, withSession(admin.cookie));
    assert.ok((await list.json()).rows.some((item) => item.id === row.id));

    const removed = await jsonRequest(`${baseUrl}/api/admin/content/${row.id}`, admin.cookie, "DELETE", { version: next.version });
    assert.equal(removed.status, 204);
    assert.equal((await readDb(dbPath)).contentPosts.some((item) => item.id === row.id), false);
  }, { prefix: "site-admin-content-crud-" });
});

test("saving content rejects a missing body image without changing media visibility", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      db.mediaAssets.push({
        id: "PRIVATE",
        eventId: null,
        purpose: "cover",
        visibility: "draft",
        originalName: "private.png",
        storedName: "private.png",
        filePath: "C:/uploads/PRIVATE.png",
        mimeType: "image/png",
        sizeBytes: 1,
        width: 1,
        height: 1,
        variants: {},
        createdBy: admin.user.id,
        createdAt: "2026-07-19T00:00:00.000Z",
        cleanedAt: null
      });
    });
    const before = (await readDb(dbPath)).mediaAssets;

    const rejectedCreate = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", contentInput({
      slug: "missing-body-create",
      bodyHtml: '<img src="/api/public/media/MISSING">'
    }));
    const rejectedCreateBody = await rejectedCreate.json();
    assert.equal(rejectedCreate.status, 422);
    assert.equal(rejectedCreateBody.code, "CONTENT_BODY_MEDIA_INVALID");
    assert.deepEqual((await readDb(dbPath)).mediaAssets, before);

    const createdResponse = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", contentInput({
      slug: "missing-body-update"
    }));
    const created = (await createdResponse.json()).row;
    assert.equal(createdResponse.status, 201);
    const rejectedUpdate = await jsonRequest(`${baseUrl}/api/admin/content/${created.id}`, admin.cookie, "PATCH", {
      version: created.version,
      bodyHtml: '<img src="/api/public/media/MISSING">'
    });
    const rejectedUpdateBody = await rejectedUpdate.json();
    assert.equal(rejectedUpdate.status, 422);
    assert.equal(rejectedUpdateBody.code, "CONTENT_BODY_MEDIA_INVALID");
    assert.deepEqual((await readDb(dbPath)).mediaAssets, before);
  }, { prefix: "content-body-media-save-" });
});

test("content publish is atomic, sanitizes previews, promotes media, records audit, and offline hides without deletion", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      for (const id of ["COVER", "ATTACHMENT", "BODY"]) {
        db.mediaAssets.push({
          id,
          eventId: EVENT_ID,
          purpose: id === "COVER" ? "cover" : "attachment",
          visibility: "draft",
          originalName: `${id}.png`,
          storedName: `${id}.png`,
          filePath: `C:/uploads/${id}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
          width: 1,
          height: 1,
          variants: {},
          createdBy: admin.user.id,
          createdAt: "2026-07-19T00:00:00.000Z",
          cleanedAt: null
        });
      }
    });
    const created = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", contentInput({
      slug: "content-publish-atomic",
      bodyHtml: '<p onclick="bad()">安全<script>alert(1)</script></p><img src="/api/public/media/BODY">',
      coverMediaId: "COVER",
      attachments: [{ mediaId: "ATTACHMENT", label: "资料", displayOrder: 0 }]
    }));
    const draft = (await created.json()).row;
    assert.equal(created.status, 201);

    await mutateDb(dbPath, (db) => {
      db.contentAttachments.push({ contentId: draft.id, mediaId: "MISSING", label: "失效", displayOrder: 1 });
    });
    const failed = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}/publish`, admin.cookie, "POST", { version: draft.version });
    assert.equal(failed.status, 422);
    let persisted = await readDb(dbPath);
    assert.equal(persisted.contentPosts.find((row) => row.id === draft.id).status, "draft");
    assert.equal(persisted.mediaAssets.every((row) => row.visibility === "draft"), true);
    assert.equal(persisted.auditLogs.some((row) => row.targetId === draft.id), false);

    await mutateDb(dbPath, (db) => {
      db.contentAttachments = db.contentAttachments.filter((row) => row.mediaId !== "MISSING");
    });
    const publishedResponse = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}/publish`, admin.cookie, "POST", { version: draft.version });
    const published = (await publishedResponse.json()).row;
    assert.equal(publishedResponse.status, 200);
    assert.equal(published.status, "published");
    assert.equal(published.version, draft.version + 1);
    assert.equal(published.bodyHtml.includes("script"), false);
    assert.equal(published.bodyHtml.includes("onclick"), false);
    assert.equal(isPublicPost(published, new Date("2100-01-01T00:00:00.000Z")), true);

    persisted = await readDb(dbPath);
    assert.equal(persisted.mediaAssets.every((row) => row.visibility === "public"), true);
    assert.equal(persisted.mediaAssets.find((row) => row.id === "BODY").visibility, "public");
    assert.ok(persisted.auditLogs.some((row) => row.action === "content.publish" && row.targetId === draft.id));

    const detail = await fetch(`${baseUrl}/api/admin/content/${draft.id}`, withSession(admin.cookie));
    const detailRow = (await detail.json()).row;
    assert.equal(detailRow.previewHtml, published.bodyHtml);
    assert.deepEqual(detailRow.attachments.map((item) => item.mediaId), ["ATTACHMENT"]);
    assert.equal(JSON.stringify(detailRow).includes("filePath"), false);
    assert.equal(JSON.stringify(detailRow).includes("storedName"), false);

    const offlineResponse = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}/offline`, admin.cookie, "POST", { version: published.version });
    const offline = (await offlineResponse.json()).row;
    assert.equal(offlineResponse.status, 200);
    assert.equal(offline.status, "offline");
    assert.equal(isPublicPost(offline, new Date("2100-01-01T00:00:00.000Z")), false);

    persisted = await readDb(dbPath);
    assert.equal(persisted.mediaAssets.length, 3);
    assert.equal(persisted.mediaAssets.every((row) => row.visibility === "public"), true);
    assert.ok(persisted.auditLogs.some((row) => row.action === "content.offline" && row.targetId === draft.id));
  }, { prefix: "content-publish-atomic-" });
});

test("site admin content PATCH controls scheduling and blocks editing or deleting protected states", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const create = async (slug) => {
      const response = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", contentInput({ slug }));
      const payload = await response.json();
      assert.equal(response.status, 201, payload.error);
      return payload.row;
    };

    const scheduledDraft = await create("scheduled-lifecycle");
    const scheduledResponse = await jsonRequest(`${baseUrl}/api/admin/content/${scheduledDraft.id}`, admin.cookie, "PATCH", {
      version: scheduledDraft.version,
      status: "scheduled",
      publishAt: "2100-01-01T00:00:00.000Z"
    });
    const scheduled = (await scheduledResponse.json()).row;
    assert.equal(scheduledResponse.status, 200);
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.publishAt, "2100-01-01T00:00:00.000Z");

    const scheduledDelete = await jsonRequest(`${baseUrl}/api/admin/content/${scheduled.id}`, admin.cookie, "DELETE", {
      version: scheduled.version
    });
    assert.equal(scheduledDelete.status, 409);

    for (const status of ["published", "offline"]) {
      const forged = await jsonRequest(`${baseUrl}/api/admin/content/${scheduled.id}`, admin.cookie, "PATCH", {
        version: scheduled.version,
        status
      });
      assert.equal(forged.status, 422, `PATCH must reject forged ${status}`);
    }

    for (const publishAt of [null, "2000-01-01T00:00:00.000Z"]) {
      const invalidSchedule = await jsonRequest(`${baseUrl}/api/admin/content/${scheduled.id}`, admin.cookie, "PATCH", {
        version: scheduled.version,
        status: "scheduled",
        publishAt
      });
      assert.equal(invalidSchedule.status, 422, `invalid schedule ${publishAt}`);
    }

    const draftResponse = await jsonRequest(`${baseUrl}/api/admin/content/${scheduled.id}`, admin.cookie, "PATCH", {
      version: scheduled.version,
      status: "draft"
    });
    const draft = (await draftResponse.json()).row;
    assert.equal(draftResponse.status, 200);
    assert.equal(draft.status, "draft");
    assert.equal(draft.publishAt, null);

    const deletedDraft = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}`, admin.cookie, "DELETE", {
      version: draft.version
    });
    assert.equal(deletedDraft.status, 204);
    let persisted = await readDb(dbPath);
    assert.ok(persisted.auditLogs.some((row) => row.action === "content.delete" && row.targetId === draft.id));

    const publishable = await create("published-protected");
    const publishResponse = await jsonRequest(`${baseUrl}/api/admin/content/${publishable.id}/publish`, admin.cookie, "POST", {
      version: publishable.version
    });
    const published = (await publishResponse.json()).row;
    assert.equal(publishResponse.status, 200);

    const publishedPatch = await jsonRequest(`${baseUrl}/api/admin/content/${published.id}`, admin.cookie, "PATCH", {
      version: published.version,
      title: "不允许直接修改"
    });
    assert.equal(publishedPatch.status, 409);

    const publishedDelete = await jsonRequest(`${baseUrl}/api/admin/content/${published.id}`, admin.cookie, "DELETE", {
      version: published.version
    });
    assert.equal(publishedDelete.status, 409);
    persisted = await readDb(dbPath);
    assert.equal(persisted.contentPosts.find((row) => row.id === published.id).title, published.title);
  }, { prefix: "site-admin-content-lifecycle-" });
});

test("content publish permanently locks the event slug after offline and deletion", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const profileResponse = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      slug: "durable-event-slug",
      isVisible: true,
      displayOrder: 0
    });
    const profile = (await profileResponse.json()).row;
    assert.equal(profileResponse.status, 201);

    const createResponse = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", contentInput({
      slug: "durable-event-story"
    }));
    const draft = (await createResponse.json()).row;
    const publishResponse = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}/publish`, admin.cookie, "POST", {
      version: draft.version
    });
    const published = (await publishResponse.json()).row;
    assert.equal(publishResponse.status, 200);

    let persisted = await readDb(dbPath);
    const markers = persisted.auditLogs.filter((row) => row.action === "event.content-published" && row.targetId === EVENT_ID);
    assert.equal(markers.length, 1);

    const offlineResponse = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}/offline`, admin.cookie, "POST", {
      version: published.version
    });
    const offline = (await offlineResponse.json()).row;
    assert.equal(offlineResponse.status, 200);

    const afterOffline = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: profile.version,
      slug: "changed-after-offline",
      isVisible: true,
      displayOrder: 0
    });
    assert.equal(afterOffline.status, 409);

    const deleteResponse = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}`, admin.cookie, "DELETE", {
      version: offline.version
    });
    assert.equal(deleteResponse.status, 204);

    const afterDelete = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: profile.version,
      slug: "changed-after-delete",
      isVisible: true,
      displayOrder: 0
    });
    assert.equal(afterDelete.status, 409);

    persisted = await readDb(dbPath);
    assert.equal(persisted.contentPosts.some((row) => row.id === draft.id), false);
    assert.equal(persisted.auditLogs.filter((row) => row.action === "event.content-published" && row.targetId === EVENT_ID).length, 1);
    assert.ok(persisted.auditLogs.some((row) => row.action === "content.delete" && row.targetId === draft.id));
  }, { prefix: "content-publish-durable-slug-" });
});
