import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { APPROVED_GROUP_NAMES } from "../src/data/seed.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function mutateDb(dbPath, mutation) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutation(db);
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function event(id, overrides = {}) {
  return {
    id,
    name: `${id} 航空航天比赛`,
    theme: `${id} 主题`,
    dateLabel: "2026年8月1日",
    venue: "温州科技馆",
    contact: "组委会",
    registrationStartAt: "2026-01-01T00:00:00.000Z",
    registrationEndAt: "2026-12-31T00:00:00.000Z",
    registrationMode: "force_open",
    status: "published",
    isCurrent: false,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function profile(eventId, overrides = {}) {
  return {
    eventId,
    slug: eventId.toLowerCase(),
    slogan: `${eventId} 宣传语`,
    summary: `${eventId} 摘要`,
    isVisible: true,
    displayOrder: Number(eventId.replace(/\D/g, "")) || 0,
    heroMediaId: null,
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function post(id, overrides = {}) {
  return {
    id,
    slug: id.toLowerCase(),
    eventId: null,
    type: "announcement",
    title: `${id} 标题`,
    summary: `${id} 摘要`,
    bodyHtml: `<p>${id} 正文</p>`,
    status: "published",
    publishAt: "2026-01-01T00:00:00.000Z",
    pinned: false,
    sortOrder: 0,
    coverMediaId: null,
    version: 3,
    createdBy: "U9001",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

async function payload(response) {
  return response.json();
}

test("public home adapts to zero through three visible events and selects a stable feature", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    for (const count of [0, 1, 2, 3]) {
      await mutateDb(dbPath, (db) => {
        db.events = Array.from({ length: count }, (_, index) => event(`E${index + 1}`, {
          registrationEndAt: `2026-${String(index + 8).padStart(2, "0")}-01T00:00:00.000Z`
        }));
        db.eventPublicProfiles = db.events.map((row) => profile(row.id));
        db.siteSettings.featuredEventId = count === 3 ? "E3" : null;
        db.contentPosts = [];
      });

      const response = await fetch(`${baseUrl}/api/public/home`);
      assert.equal(response.status, 200, `count=${count}`);
      const home = await payload(response);
      assert.deepEqual(Object.keys(home), [
        "site", "mode", "featuredEvent", "concurrentEvents", "services",
        "announcements", "news", "works", "history"
      ]);
      if (count === 0) {
        assert.equal(home.mode, "history");
        assert.equal(home.featuredEvent, null);
        assert.deepEqual(home.concurrentEvents, []);
        continue;
      }
      assert.equal(home.mode, "active");
      assert.equal(home.featuredEvent.id, count === 3 ? "E3" : "E1");
      assert.equal(home.concurrentEvents.length, count - 1);
      assert.equal(home.concurrentEvents.some((row) => row.id === home.featuredEvent.id), false);
      assert.equal(home.services.length, 4);
      assert.equal(home.services.every((service) => service.eventId === home.featuredEvent.id), true);
      assert.equal(typeof home.featuredEvent.registrationWindow.open, "boolean");
    }

    await mutateDb(dbPath, (db) => {
      db.events = [
        event("E1", { registrationEndAt: "2026-11-01T00:00:00.000Z" }),
        event("E2", { registrationEndAt: "2026-08-01T00:00:00.000Z" }),
        event("E3", { registrationEndAt: "2026-09-01T00:00:00.000Z" })
      ];
      db.eventPublicProfiles = db.events.map((row) => profile(row.id));
      db.siteSettings.featuredEventId = null;
    });
    const automatic = await payload(await fetch(`${baseUrl}/api/public/home`));
    assert.equal(automatic.featuredEvent.id, "E2");
    assert.deepEqual(automatic.concurrentEvents.map((row) => row.id), ["E3", "E1"]);

    await mutateDb(dbPath, (db) => {
      db.events = [event("HIDDEN-ARCHIVED", {
        status: "archived",
        registrationMode: "force_open",
        registrationEndAt: "2026-06-01T00:00:00.000Z",
        archivedAt: "2026-06-02T00:00:00.000Z"
      })];
      db.eventPublicProfiles = [profile("HIDDEN-ARCHIVED", { slug: "hidden-archive", isVisible: false })];
      db.siteSettings.featuredEventId = null;
    });
    const emptyHistory = await payload(await fetch(`${baseUrl}/api/public/home`));
    assert.equal(emptyHistory.mode, "history");
    assert.equal(emptyHistory.featuredEvent, null);
    assert.deepEqual(emptyHistory.concurrentEvents, []);
    assert.equal(emptyHistory.services.every((service) => service.eventId === null), true);
    assert.equal(JSON.stringify(emptyHistory).includes("hidden-archive"), false);
    assert.equal(emptyHistory.services.some((service) => service.href.includes("/events/")), false);

    await mutateDb(dbPath, (db) => {
      db.eventPublicProfiles[0].isVisible = true;
    });
    const visibleHistory = await payload(await fetch(`${baseUrl}/api/public/home`));
    assert.equal(visibleHistory.mode, "history");
    assert.equal(visibleHistory.featuredEvent.id, "HIDDEN-ARCHIVED");
    assert.deepEqual(visibleHistory.featuredEvent.registrationWindow, {
      open: false,
      reason: "赛事已归档"
    });
    assert.deepEqual(
      visibleHistory.services.find((service) => service.key === "registration"),
      {
        key: "registration",
        label: "报名中心",
        eventId: "HIDDEN-ARCHIVED",
        available: false,
        href: "/history"
      }
    );
  }, { prefix: "aerogp-public-home-" });
});

test("public home exposes only published due content in bounded sorted sections", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.events = [event("E1")];
      db.eventPublicProfiles = [profile("E1")];
      db.contentPosts = [
        ...Array.from({ length: 7 }, (_, index) => post(`A${index}`, {
          type: "announcement",
          pinned: index === 6,
          sortOrder: index,
          publishAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
        })),
        ...Array.from({ length: 7 }, (_, index) => post(`N${index}`, { type: "news", sortOrder: index })),
        ...Array.from({ length: 7 }, (_, index) => post(`W${index}`, { type: "work", sortOrder: index })),
        ...Array.from({ length: 7 }, (_, index) => post(`R${index}`, { type: "recap", sortOrder: index })),
        post("DRAFT", { status: "draft" }),
        post("SCHEDULED", { status: "scheduled", publishAt: "2999-01-01T00:00:00.000Z" }),
        post("OFFLINE", { status: "offline" }),
        post("FUTURE-PUBLISHED", { publishAt: "2999-01-01T00:00:00.000Z" })
      ];
    });

    const home = await payload(await fetch(`${baseUrl}/api/public/home`));
    assert.equal(home.announcements.length, 5);
    assert.equal(home.news.length, 6);
    assert.equal(home.works.length, 6);
    assert.equal(home.history.length, 6);
    assert.equal(home.announcements[0].id, "A6");
    const serialized = JSON.stringify(home);
    for (const hidden of ["DRAFT", "SCHEDULED", "OFFLINE", "FUTURE-PUBLISHED"]) {
      assert.equal(serialized.includes(hidden), false, hidden);
    }
  }, { prefix: "aerogp-public-home-content-" });
});

test("public content list and detail never allow admin-cookie or preview draft bypass", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.events = [event("E1")];
      db.eventPublicProfiles = [profile("E1")];
      db.mediaAssets = [
        {
          id: "COVER", eventId: "E1", purpose: "content-cover", visibility: "public",
          originalName: "cover.png", storedName: "private-cover.bin", filePath: "C:/secret/cover.png",
          mimeType: "image/png", sizeBytes: 1234, width: 1200, height: 800,
          variants: { mobile: { filePath: "C:/secret/mobile.webp", mimeType: "image/webp", width: 768, height: 512 } },
          createdBy: "U9001", createdAt: "2026-01-01T00:00:00.000Z", cleanedAt: null
        },
        {
          id: "PDF", eventId: "E1", purpose: "attachment", visibility: "public",
          originalName: "赛事规程.pdf", storedName: "private-pdf.bin", filePath: "C:/secret/rules.pdf",
          mimeType: "application/pdf", sizeBytes: 5678, width: null, height: null, variants: {},
          createdBy: "U9001", createdAt: "2026-01-01T00:00:00.000Z", cleanedAt: null
        }
      ];
      db.contentPosts = [
        post("PUBLIC", { slug: "public-story", eventId: "E1", coverMediaId: "COVER" }),
        post("DRAFT", { slug: "draft-story", eventId: "E1", status: "draft" }),
        post("SCHEDULED", { slug: "scheduled-story", eventId: "E1", status: "scheduled", publishAt: "2999-01-01T00:00:00.000Z" }),
        post("OFFLINE", { slug: "offline-story", eventId: "E1", status: "offline" })
      ];
      db.contentAttachments = [{ contentId: "PUBLIC", mediaId: "PDF", label: "下载规程", displayOrder: 0 }];
    });
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const listResponse = await fetch(
      `${baseUrl}/api/public/content?type=announcement&event=e1&page=1&pageSize=10&preview=1`,
      withSession(admin.cookie)
    );
    assert.equal(listResponse.status, 200);
    const list = await payload(listResponse);
    assert.deepEqual(list.rows.map((row) => row.slug), ["public-story"]);
    assert.deepEqual(list.pagination, { page: 1, pageSize: 10, total: 1, totalPages: 1 });

    for (const slug of ["draft-story", "scheduled-story", "offline-story", "missing-story"]) {
      const hidden = await fetch(`${baseUrl}/api/public/content/${slug}?preview=1`, withSession(admin.cookie));
      assert.equal(hidden.status, 404, slug);
      assert.deepEqual(await payload(hidden), { error: "内容不存在" });
    }

    const detailResponse = await fetch(`${baseUrl}/api/public/content/public-story`);
    assert.equal(detailResponse.status, 200);
    const detail = await payload(detailResponse);
    assert.equal(detail.row.slug, "public-story");
    assert.equal(detail.row.cover.mobileUrl, "/api/public/media/COVER?variant=mobile");
    assert.deepEqual(detail.row.attachments, [{
      id: "PDF",
      label: "下载规程",
      displayOrder: 0,
      url: "/api/public/media/PDF?variant=original",
      name: "赛事规程.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5678,
      width: null,
      height: null
    }]);
    const serialized = JSON.stringify(detail);
    for (const privateValue of ["filePath", "storedName", "private-cover.bin", "C:/secret", "createdBy", '"version"']) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
  }, { prefix: "aerogp-public-content-" });
});

test("public content hides relationships to a non-public event without hiding the published post", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.events = [event("SECRET-EVENT", {
        status: "archived",
        registrationMode: "force_closed",
        registrationEndAt: "2026-06-01T00:00:00.000Z",
        archivedAt: "2026-06-02T00:00:00.000Z"
      })];
      db.eventPublicProfiles = [profile("SECRET-EVENT", {
        slug: "secret-event-slug",
        isVisible: false
      })];
      db.contentPosts = [post("PUBLIC-CONTENT", {
        slug: "public-content",
        eventId: "SECRET-EVENT",
        type: "news",
        title: "公开文章"
      })];
      db.mediaAssets = [{
        id: "PUBLIC-ATTACHMENT", eventId: "SECRET-EVENT", purpose: "attachment", visibility: "public",
        originalName: "公开附件.pdf", storedName: "private.bin", filePath: "C:/secret/attachment.pdf",
        mimeType: "application/pdf", sizeBytes: 100, width: null, height: null,
        variants: {}, createdBy: "U9001", createdAt: "2026-01-01T00:00:00.000Z", cleanedAt: null
      }];
      db.contentAttachments = [{
        contentId: "PUBLIC-CONTENT",
        mediaId: "PUBLIC-ATTACHMENT",
        label: "公开附件",
        displayOrder: 0
      }];
    });

    const home = await payload(await fetch(`${baseUrl}/api/public/home`));
    assert.equal(home.news.length, 1);
    assert.equal(home.news[0].eventId, null);
    assert.equal(home.news[0].eventSlug, null);

    const list = await payload(await fetch(`${baseUrl}/api/public/content?type=news`));
    assert.equal(list.rows.length, 1);
    assert.equal(list.rows[0].eventId, null);
    assert.equal(list.rows[0].eventSlug, null);

    const detail = await payload(await fetch(`${baseUrl}/api/public/content/public-content`));
    assert.equal(detail.row.title, "公开文章");
    assert.equal(detail.row.eventId, null);
    assert.equal(detail.row.eventSlug, null);
    assert.equal(detail.row.attachments.length, 1);
    assert.equal(Object.hasOwn(detail.row.attachments[0], "eventId"), false);
    assert.equal(Object.hasOwn(detail.row.attachments[0], "eventSlug"), false);

    const serialized = JSON.stringify({ home: home.news, list: list.rows, detail });
    assert.equal(serialized.includes("SECRET-EVENT"), false);
    assert.equal(serialized.includes("secret-event-slug"), false);
  }, { prefix: "aerogp-public-hidden-event-content-" });
});

test("public content validates filters and bounds pagination", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.events = [event("E1")];
      db.eventPublicProfiles = [profile("E1")];
      db.contentPosts = [post("PUBLIC", { eventId: "E1" })];
    });
    for (const query of [
      "type=unknown",
      "page=0",
      "page=1.5",
      "pageSize=0",
      "pageSize=51",
      "event=missing-event"
    ]) {
      const response = await fetch(`${baseUrl}/api/public/content?${query}`);
      assert.equal(response.status, 422, query);
    }
  }, { prefix: "aerogp-public-validation-" });
});

test("public event detail combines facts, enabled projects, fixed groups, resources and published content", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.events = [event("E1")];
      db.eventPublicProfiles = [profile("E1")];
      db.projects = [
        { id: "P1", eventId: "E1", name: "公开赛项", type: "individual", category: "航模", enabled: true, instructorRequired: false, displayOrder: 1, allowedGroups: [...APPROVED_GROUP_NAMES], internalCost: 5000, privateNotes: "内部字段" },
        { id: "P2", eventId: "E1", name: "停用赛项", type: "team", category: "无人机", enabled: false, instructorRequired: false, displayOrder: 0, allowedGroups: [...APPROVED_GROUP_NAMES] }
      ];
      db.contentPosts = [
        post("GUIDE", { eventId: "E1", type: "guide" }),
        post("NEWS", { eventId: "E1", type: "news" }),
        post("DRAFT", { eventId: "E1", type: "announcement", status: "draft" })
      ];
      db.mediaAssets = [{
        id: "RULES", eventId: "E1", purpose: "attachment", visibility: "public",
        originalName: "规程.pdf", storedName: "secret.bin", filePath: "C:/secret/rules.pdf",
        mimeType: "application/pdf", sizeBytes: 100, width: null, height: null,
        variants: {}, createdBy: "U9001", createdAt: "2026-01-01T00:00:00.000Z", cleanedAt: null
      }];
      db.contentAttachments = [{ contentId: "GUIDE", mediaId: "RULES", label: "赛事规程", displayOrder: 0 }];
    });

    const response = await fetch(`${baseUrl}/api/public/events/e1`);
    assert.equal(response.status, 200);
    const detail = await payload(response);
    assert.equal(detail.event.id, "E1");
    assert.equal(detail.event.slug, "e1");
    assert.equal(detail.event.registrationWindow.open, true);
    assert.deepEqual(detail.projects.map((row) => row.id), ["P1"]);
    assert.deepEqual(Object.keys(detail.projects[0]), [
      "id", "eventId", "name", "type", "category", "enabled",
      "instructorRequired", "displayOrder", "submissionMode", "allowedGroups"
    ]);
    assert.equal(detail.projects[0].submissionMode, "none");
    assert.equal(JSON.stringify(detail.projects).includes("内部字段"), false);
    assert.deepEqual(detail.groups, APPROVED_GROUP_NAMES);
    assert.deepEqual(detail.resources.map((row) => row.name), ["规程.pdf"]);
    assert.deepEqual(detail.content.map((row) => row.slug).sort(), ["guide", "news"]);
    assert.equal(JSON.stringify(detail).includes("C:/secret"), false);

    assert.equal((await fetch(`${baseUrl}/api/public/events/missing`)).status, 404);

    await mutateDb(dbPath, (db) => {
      db.events[0].status = "archived";
      db.events[0].archivedAt = "2026-06-02T00:00:00.000Z";
      db.events[0].registrationMode = "force_open";
    });
    const archived = await payload(await fetch(`${baseUrl}/api/public/events/e1`));
    assert.deepEqual(archived.event.registrationWindow, { open: false, reason: "赛事已归档" });
  }, { prefix: "aerogp-public-event-detail-" });
});

test("sitemap uses PUBLIC_SITE_URL and contains only public canonical routes", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.events = [event("E1")];
      db.eventPublicProfiles = [profile("E1", { slug: "visible-event" })];
      db.contentPosts = [
        post("PUBLIC", { slug: "public-story" }),
        post("DRAFT", { slug: "draft-story", status: "draft" })
      ];
    });

    const response = await fetch(`${baseUrl}/api/public/sitemap.xml`, {
      headers: { Host: "attacker.example", "X-Forwarded-Host": "attacker.example" }
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /xml/);
    const xml = await response.text();
    for (const route of ["/", "/announcements", "/news", "/history", "/events/visible-event", "/content/public-story"]) {
      assert.match(xml, new RegExp(`<loc>https://public\\.example/base${route.replaceAll("/", "\\/")}</loc>`));
    }
    assert.equal(xml.includes("draft-story"), false);
    assert.equal(xml.includes("attacker.example"), false);
  }, {
    prefix: "aerogp-public-sitemap-",
    env: { PUBLIC_SITE_URL: "https://public.example/base/" }
  });
});

test("sitemap fails closed when PUBLIC_SITE_URL is missing or invalid", async () => {
  for (const publicSiteUrl of ["", "not-a-url", "javascript:alert(1)"]) {
    await withTestServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/public/sitemap.xml`);
      assert.equal(response.status, 500, publicSiteUrl || "missing");
      assert.deepEqual(await payload(response), { error: "服务器内部错误" });
    }, {
      prefix: "aerogp-public-sitemap-config-",
      env: { PUBLIC_SITE_URL: publicSiteUrl }
    });
  }
});
