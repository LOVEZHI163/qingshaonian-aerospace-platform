import assert from "node:assert/strict";
import test from "node:test";

import { selectHomeEvents } from "../src/services/public-site.js";
import {
  buildContentDetailView,
  buildEventDetailView,
  buildHomeView,
  mediaView,
  visiblePosts
} from "../src/services/public-site-view.js";

const now = new Date("2026-07-19T12:00:00.000Z");

function event(id, overrides = {}) {
  return {
    id,
    status: "published",
    archivedAt: null,
    registrationStartAt: "2026-07-01T00:00:00.000Z",
    registrationEndAt: "2026-07-31T00:00:00.000Z",
    registrationMode: "automatic",
    ...overrides
  };
}

function profile(eventId, overrides = {}) {
  return { eventId, isVisible: true, displayOrder: 0, ...overrides };
}

function db(events, profiles, featuredEventId = null) {
  return { siteSettings: { featuredEventId }, events, eventPublicProfiles: profiles };
}

function seededPublicSiteDb() {
  return {
    siteSettings: { platformName: "青少年航空平台", featuredEventId: "CURRENT-EVENT" },
    events: [event("CURRENT-EVENT", { name: "当前赛事" })],
    eventPublicProfiles: [profile("CURRENT-EVENT", { slug: "current-event" })],
    contentPosts: [{
      id: "NEWS-ONE",
      slug: "news-one",
      eventId: "CURRENT-EVENT",
      type: "news",
      title: "新闻一",
      summary: "新闻摘要",
      bodyHtml: "<p>新闻正文</p>",
      status: "published",
      publishAt: "2026-07-01T00:00:00.000Z",
      pinned: false,
      sortOrder: 0,
      coverMediaId: null
    }],
    contentAttachments: [],
    mediaAssets: [],
    projects: []
  };
}

function seededPublicSiteDbWithPrivateMedia() {
  const source = seededPublicSiteDb();
  source.mediaAssets = [{
    id: "MEDIA-PRIVATE",
    visibility: "draft",
    originalName: "private.png",
    mimeType: "image/png",
    sizeBytes: 128,
    width: 64,
    height: 64,
    variants: {},
    cleanedAt: null
  }];
  return source;
}

test("public view builders preserve homepage, event and content shapes", () => {
  const source = seededPublicSiteDb();
  const current = new Date("2026-07-20T00:00:00.000Z");
  assert.equal(buildHomeView(source, current).site.platformName, source.siteSettings.platformName);
  assert.equal(buildEventDetailView(source, "current-event", current).event.slug, "current-event");
  assert.equal(buildContentDetailView(source, "news-one", current).row.slug, "news-one");
});

test("public content hides linked draft events but keeps platform content public", () => {
  const source = seededPublicSiteDb();
  const linked = source.contentPosts[0];
  source.contentPosts.push({ ...linked, id: "PLATFORM", slug: "platform", eventId: null });
  source.events[0].status = "draft";

  assert.equal(buildContentDetailView(source, "news-one", now), null);
  assert.equal(buildContentDetailView(source, "platform", now).row.id, "PLATFORM");
  assert.deepEqual(visiblePosts(source, now).map((row) => row.id), ["PLATFORM"]);
});

test("public content remains readable for published or archived event status", () => {
  for (const status of ["published", "archived"]) {
    const source = seededPublicSiteDb();
    source.events[0].status = status;
    assert.equal(buildContentDetailView(source, "news-one", now).row.id, "NEWS-ONE");
  }
});

test("mediaView hides private media unless an explicit protected URL builder is supplied", () => {
  const source = seededPublicSiteDbWithPrivateMedia();
  assert.equal(mediaView(source, "MEDIA-PRIVATE"), null);
  assert.equal(mediaView(source, "MEDIA-PRIVATE", { allowPrivate: true }), null);
  assert.equal(
    mediaView(source, "MEDIA-PRIVATE", {
      allowPrivate: true,
      urlFor: (id) => `/api/admin/site-media/${id}/preview`
    }).url,
    "/api/admin/site-media/MEDIA-PRIVATE/preview"
  );
});

test("unpublished content uses protected URLs for private cover and attachments", () => {
  const source = seededPublicSiteDbWithPrivateMedia();
  source.contentPosts[0] = {
    ...source.contentPosts[0],
    status: "draft",
    coverMediaId: "COVER-PRIVATE"
  };
  source.mediaAssets.push(
    {
      id: "COVER-PRIVATE",
      visibility: "draft",
      originalName: "cover-private.png",
      mimeType: "image/png",
      sizeBytes: 256,
      width: 128,
      height: 128,
      variants: {},
      cleanedAt: null
    },
    {
      id: "ATTACHMENT-PRIVATE",
      visibility: "draft",
      originalName: "attachment-private.pdf",
      mimeType: "application/pdf",
      sizeBytes: 512,
      width: null,
      height: null,
      variants: {},
      cleanedAt: null
    }
  );
  source.contentAttachments = [{
    contentId: "NEWS-ONE",
    mediaId: "ATTACHMENT-PRIVATE",
    label: "私有附件",
    displayOrder: 0
  }];

  const detail = buildContentDetailView(source, "news-one", new Date("2026-07-20T00:00:00.000Z"), {
    allowUnpublished: true,
    mediaUrl: (id) => `/api/admin/site-media/${id}/preview`
  });

  assert.equal(detail.row.cover.url, "/api/admin/site-media/COVER-PRIVATE/preview");
  assert.equal(detail.row.attachments[0].url, "/api/admin/site-media/ATTACHMENT-PRIVATE/preview");
});

test("homepage preview uses protected URLs for private event fallbacks and content covers", () => {
  const source = seededPublicSiteDb();
  source.siteSettings.defaultHeroMediaId = "DEFAULT-HERO-PRIVATE";
  source.events.push(event("CONCURRENT-EVENT", { name: "同期赛事" }));
  source.eventPublicProfiles.push(profile("CONCURRENT-EVENT", { slug: "concurrent-event" }));
  source.contentPosts[0].coverMediaId = "CONTENT-COVER-PRIVATE";
  source.mediaAssets.push(
    {
      id: "DEFAULT-HERO-PRIVATE",
      visibility: "draft",
      originalName: "default-private.png",
      mimeType: "image/png",
      sizeBytes: 256,
      width: 128,
      height: 72,
      variants: {},
      cleanedAt: null
    },
    {
      id: "CONTENT-COVER-PRIVATE",
      visibility: "draft",
      originalName: "content-private.png",
      mimeType: "image/png",
      sizeBytes: 256,
      width: 128,
      height: 72,
      variants: {},
      cleanedAt: null
    }
  );

  const view = buildHomeView(source, new Date("2026-07-20T00:00:00.000Z"), {
    mediaUrl: (id) => `/api/admin/site-media/${id}/preview`
  });

  assert.equal(view.featuredEvent.hero.url, "/api/admin/site-media/DEFAULT-HERO-PRIVATE/preview");
  assert.equal(view.concurrentEvents[0].hero.url, "/api/admin/site-media/DEFAULT-HERO-PRIVATE/preview");
  assert.equal(view.news[0].cover.url, "/api/admin/site-media/CONTENT-COVER-PRIVATE/preview");
  assert.doesNotMatch(JSON.stringify(view), /\/api\/public\/media\/(?:DEFAULT-HERO-PRIVATE|CONTENT-COVER-PRIVATE)/);
});

test("an in-window draft is public automatically while preview still preserves its status", () => {
  const source = seededPublicSiteDb();
  source.events[0].status = "draft";
  source.eventPublicProfiles[0].isVisible = false;

  assert.equal(buildEventDetailView(source, "current-event", now).event.status, "draft");
  const view = buildEventDetailView(source, "current-event", now, { allowUnpublished: true });

  assert.equal(view.event.status, "draft");
  assert.deepEqual(view.event.registrationWindow, { open: true, reason: "报名进行中" });
});

test("home event selection respects a valid manual feature and caps concurrent events", () => {
  const source = db(
    [event("E1"), event("E2"), event("E3")],
    [profile("E1", { displayOrder: 1 }), profile("E2", { displayOrder: 2 }), profile("E3", { displayOrder: 3 })],
    "E2"
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "E2");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["E1", "E3"]);
  assert.equal(selection.fallbackEvent, null);
  assert.equal(selection.mode, "active");
});

test("home event selection does not require a second website-visibility switch", () => {
  const source = db(
    [event("E1"), event("E2"), event("E3")],
    [profile("E1", { displayOrder: 2 }), profile("E2", { isVisible: false }), profile("E3", { displayOrder: 1 })],
    "E2"
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "E2");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["E3", "E1"]);
});

test("an automatic draft becomes visible in its registration window and force-open is immediately visible", () => {
  const source = db(
    [
      event("AUTO-DRAFT", { status: "draft" }),
      event("FORCED-DRAFT", { status: "draft", registrationMode: "force_open", registrationStartAt: "2030-01-01T00:00:00.000Z", registrationEndAt: "2030-02-01T00:00:00.000Z" })
    ],
    [profile("AUTO-DRAFT", { isVisible: false }), profile("FORCED-DRAFT", { isVisible: false })]
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "AUTO-DRAFT");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["FORCED-DRAFT"]);
});

test("home event selection keeps a valid manual feature outside the registration window", () => {
  const source = db(
    [event("FEATURED", { registrationEndAt: "2026-07-18T00:00:00.000Z" }), event("OPEN")],
    [profile("FEATURED"), profile("OPEN")],
    "FEATURED"
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "FEATURED");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["OPEN"]);
  assert.equal(selection.mode, "active");
});

test("home event selection orders automatic choices by registration end, display order, then id", () => {
  const source = db(
    [
      event("E3", { registrationEndAt: "2026-07-25T00:00:00.000Z" }),
      event("E2", { registrationEndAt: "2026-07-25T00:00:00.000Z" }),
      event("E1", { registrationEndAt: "2026-07-24T00:00:00.000Z" })
    ],
    [profile("E3", { displayOrder: 1 }), profile("E2", { displayOrder: 1 }), profile("E1", { displayOrder: 99 })]
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "E1");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["E2", "E3"]);
});

test("home event selection handles zero, one, two, and three open events", () => {
  const closed = db(
    [event("ENDED", { registrationEndAt: "2026-07-18T00:00:00.000Z" })],
    [profile("ENDED")]
  );
  const one = db([event("E1")], [profile("E1")]);
  const two = db([event("E1"), event("E2")], [profile("E1"), profile("E2")]);
  const three = db([event("E1"), event("E2"), event("E3")], [profile("E1"), profile("E2"), profile("E3")]);

  assert.equal(selectHomeEvents(closed, now).mode, "history");
  assert.equal(selectHomeEvents(closed, now).featuredEvent, null);
  assert.equal(selectHomeEvents(closed, now).fallbackEvent.id, "ENDED");
  assert.deepEqual(selectHomeEvents(one, now).concurrentEvents.map((row) => row.id), []);
  assert.deepEqual(selectHomeEvents(two, now).concurrentEvents.map((row) => row.id), ["E2"]);
  assert.deepEqual(selectHomeEvents(three, now).concurrentEvents.map((row) => row.id), ["E2", "E3"]);
});

test("home event selection honors forced registration opening and closing", () => {
  const source = db(
    [
      event("OPEN", { registrationMode: "force_open", registrationStartAt: "2030-01-01T00:00:00.000Z", registrationEndAt: "2030-02-01T00:00:00.000Z" }),
      event("CLOSED", { registrationMode: "force_closed" })
    ],
    [profile("OPEN"), profile("CLOSED")]
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "OPEN");
  assert.deepEqual(selection.concurrentEvents, []);
});

test("home event selection excludes hidden archived events from public history", () => {
  const noActiveDb = db(
    [
      event("PUBLIC-OLD", { registrationEndAt: "2026-07-10T00:00:00.000Z" }),
      event("ARCHIVED-NEW", { status: "archived", archivedAt: "2026-07-18T00:00:00.000Z", registrationEndAt: "2026-07-18T00:00:00.000Z" })
    ],
    [profile("PUBLIC-OLD"), profile("ARCHIVED-NEW", { isVisible: false })]
  );

  const selection = selectHomeEvents(noActiveDb, now);

  assert.equal(selection.mode, "history");
  assert.equal(selection.fallbackEvent.id, "PUBLIC-OLD");
  assert.equal(selection.featuredEvent, null);
  assert.deepEqual(selection.concurrentEvents, []);
});

test("home event selection returns a stable empty history when every archived event is hidden", () => {
  const noActiveDb = db(
    [event("ARCHIVED", { status: "archived", archivedAt: "2026-07-18T00:00:00.000Z", registrationEndAt: "2026-07-18T00:00:00.000Z" })],
    [profile("ARCHIVED", { isVisible: false })]
  );

  const selection = selectHomeEvents(noActiveDb, now);

  assert.equal(selection.mode, "history");
  assert.equal(selection.fallbackEvent, null);
  assert.equal(selection.featuredEvent, null);
  assert.deepEqual(selection.concurrentEvents, []);
});

test("home event selection excludes visible draft events from history fallback", () => {
  const noActiveDb = db(
    [
      event("PUBLISHED", { registrationEndAt: "2026-07-17T00:00:00.000Z" }),
      event("DRAFT", { status: "draft", registrationEndAt: "2026-07-18T00:00:00.000Z" })
    ],
    [profile("PUBLISHED"), profile("DRAFT")]
  );

  const selection = selectHomeEvents(noActiveDb, now);

  assert.equal(selection.mode, "history");
  assert.equal(selection.fallbackEvent.id, "PUBLISHED");
});
