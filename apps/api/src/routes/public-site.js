import express from "express";

import { APPROVED_GROUP_NAMES } from "../data/seed.js";
import { isRegistrationOpen } from "../domain/registration-window.js";
import { isPublicPost } from "../services/content-publishing.js";
import { selectHomeEvents } from "../services/public-site.js";

const CONTENT_TYPES = new Set(["announcement", "news", "work", "recap", "guide"]);
const HOME_LIMITS = { announcement: 5, news: 6, work: 6, recap: 6 };
const FIXED_ROUTES = ["/", "/announcements", "/news", "/history"];

function routeError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function asDate(clock) {
  const value = new Date(typeof clock === "function" ? clock() : clock);
  if (!Number.isFinite(value.getTime())) throw new TypeError("clock must return a valid date");
  return value;
}

function publicMedia(db, mediaId) {
  if (!mediaId) return null;
  const media = (db.mediaAssets || []).find((row) => row.id === mediaId);
  if (!media || media.visibility !== "public" || media.cleanedAt) return null;
  const result = {
    id: media.id,
    url: `/api/public/media/${encodeURIComponent(media.id)}?variant=original`,
    name: media.originalName,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    width: media.width ?? null,
    height: media.height ?? null
  };
  if (media.variants?.mobile) {
    result.mobileUrl = `/api/public/media/${encodeURIComponent(media.id)}?variant=mobile`;
  }
  if (media.variants?.desktop) {
    result.desktopUrl = `/api/public/media/${encodeURIComponent(media.id)}?variant=desktop`;
  }
  return result;
}

function publicAttachment(db, attachment) {
  const media = publicMedia(db, attachment.mediaId);
  if (!media) return null;
  return {
    id: media.id,
    label: attachment.label,
    displayOrder: attachment.displayOrder,
    url: media.url,
    name: media.name,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    width: media.width,
    height: media.height
  };
}

function attachmentsFor(db, contentId) {
  return (db.contentAttachments || [])
    .filter((row) => row.contentId === contentId)
    .sort((left, right) => left.displayOrder - right.displayOrder || String(left.mediaId).localeCompare(String(right.mediaId)))
    .map((row) => publicAttachment(db, row))
    .filter(Boolean);
}

function comparePosts(left, right) {
  return Number(right.pinned) - Number(left.pinned)
    || left.sortOrder - right.sortOrder
    || Date.parse(right.publishAt) - Date.parse(left.publishAt)
    || String(left.id).localeCompare(String(right.id));
}

function visiblePosts(db, now) {
  return (db.contentPosts || []).filter((row) => isPublicPost(row, now)).sort(comparePosts);
}

function contentSummary(db, row) {
  const event = (db.events || []).find((item) => item.id === row.eventId);
  const profile = eventIsPublic(db, event) ? publicProfile(db, event.id) : null;
  return {
    id: row.id,
    slug: row.slug,
    eventId: profile ? event.id : null,
    eventSlug: profile?.slug || null,
    type: row.type,
    title: row.title,
    summary: row.summary,
    publishAt: row.publishAt,
    pinned: row.pinned,
    cover: publicMedia(db, row.coverMediaId)
  };
}

function contentDetail(db, row) {
  return {
    ...contentSummary(db, row),
    bodyHtml: row.bodyHtml,
    attachments: attachmentsFor(db, row.id)
  };
}

function publicProfile(db, eventId) {
  return (db.eventPublicProfiles || []).find((row) => row.eventId === eventId && row.isVisible === true) || null;
}

function eventIsPublic(db, event) {
  return Boolean(publicProfile(db, event?.id)) && ["published", "archived"].includes(event?.status);
}

function publicRegistrationWindow(event, now) {
  if (event.status === "archived" || event.archivedAt) return { open: false, reason: "赛事已归档" };
  if (event.status !== "published") return { open: false, reason: "赛事尚未发布" };
  return isRegistrationOpen(event, now);
}

function eventSummary(db, event, now) {
  if (!event) return null;
  const profile = publicProfile(db, event.id);
  if (!profile) return null;
  return {
    id: event.id,
    slug: profile.slug,
    name: event.name,
    theme: event.theme,
    slogan: profile.slogan,
    summary: profile.summary,
    dateLabel: event.dateLabel,
    venue: event.venue,
    contact: event.contact,
    registrationStartAt: event.registrationStartAt,
    registrationEndAt: event.registrationEndAt,
    registrationMode: event.registrationMode,
    status: event.status,
    archivedAt: event.archivedAt,
    registrationWindow: publicRegistrationWindow(event, now),
    hero: publicMedia(db, profile.heroMediaId || db.siteSettings?.defaultHeroMediaId)
  };
}

function historicalEvents(db, now) {
  const selection = selectHomeEvents(db, now);
  const homepageEventIds = new Set([
    selection.featuredEvent?.id,
    ...(selection.concurrentEvents || []).map((event) => event.id),
    db.siteSettings?.featuredEventId
  ].filter(Boolean));
  return (db.events || [])
    .filter((event) => {
      if (!eventIsPublic(db, event)) return false;
      if (event.isCurrent === true || homepageEventIds.has(event.id)) return false;
      const endedAt = Date.parse(event.registrationEndAt);
      return event.status === "archived"
        || Boolean(event.archivedAt)
        || (!isRegistrationOpen(event, now).open && Number.isFinite(endedAt) && endedAt < now.getTime());
    })
    .sort((left, right) => {
      const leftEndedAt = Date.parse(left.registrationEndAt);
      const rightEndedAt = Date.parse(right.registrationEndAt);
      return (Number.isFinite(rightEndedAt) ? rightEndedAt : 0) - (Number.isFinite(leftEndedAt) ? leftEndedAt : 0)
        || String(left.id).localeCompare(String(right.id));
    });
}

function publicSiteSettings(db) {
  const settings = db.siteSettings || {};
  return {
    platformName: settings.platformName || "",
    platformIntro: settings.platformIntro || "",
    organizers: Array.isArray(settings.organizers) ? settings.organizers : [],
    contact: settings.contact || "",
    icp: settings.icp || "",
    seoTitle: settings.seoTitle || "",
    seoDescription: settings.seoDescription || "",
    defaultHero: publicMedia(db, settings.defaultHeroMediaId),
    shareImage: publicMedia(db, settings.shareMediaId)
  };
}

function servicesFor(event, mode) {
  const eventId = event?.id || null;
  const eventSlug = event?.slug || null;
  const registrationAvailable = Boolean(eventId && mode === "active" && event.registrationWindow.open);
  return [
    {
      key: "registration",
      label: "报名中心",
      eventId,
      available: registrationAvailable,
      href: registrationAvailable ? `/admin/?view=registration&eventId=${encodeURIComponent(eventId)}` : "/history"
    },
    {
      key: "guide",
      label: "参赛指南",
      eventId,
      available: Boolean(eventSlug),
      href: eventSlug ? `/events/${encodeURIComponent(eventSlug)}` : "/history"
    },
    {
      key: "results",
      label: "成绩查询",
      eventId,
      available: Boolean(eventId),
      href: eventId ? `/admin/?view=records&eventId=${encodeURIComponent(eventId)}` : "/history"
    },
    {
      key: "certificates",
      label: "证书中心",
      eventId,
      available: Boolean(eventId),
      href: eventId ? `/admin/?view=certificates&eventId=${encodeURIComponent(eventId)}` : "/history"
    }
  ];
}

function homePayload(db, now) {
  const selection = selectHomeEvents(db, now);
  const selected = selection.featuredEvent || selection.fallbackEvent;
  const featuredEvent = eventSummary(db, selected, now);
  const posts = visiblePosts(db, now);
  const section = (type) => posts
    .filter((row) => row.type === type)
    .slice(0, HOME_LIMITS[type])
    .map((row) => contentSummary(db, row));
  return {
    site: publicSiteSettings(db),
    mode: selection.mode,
    featuredEvent,
    concurrentEvents: selection.concurrentEvents.map((row) => eventSummary(db, row, now)).filter(Boolean),
    services: servicesFor(featuredEvent, selection.mode),
    announcements: section("announcement"),
    news: section("news"),
    works: section("work"),
    history: section("recap")
  };
}

function positiveInteger(value, fallback, label, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw routeError(422, `${label}不合法`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw routeError(422, `${label}不合法`);
  return result;
}

function normalizeSiteUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("PUBLIC_SITE_URL is required");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("PUBLIC_SITE_URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_SITE_URL is invalid");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function publicProject(row) {
  return {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    type: row.type,
    category: row.category,
    enabled: row.enabled,
    instructorRequired: row.instructorRequired,
    displayOrder: row.displayOrder,
    allowedGroups: Array.isArray(row.allowedGroups) ? row.allowedGroups : []
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sitemapXml(db, now, publicSiteUrl) {
  const baseUrl = normalizeSiteUrl(publicSiteUrl);
  const eventRoutes = (db.events || [])
    .filter((event) => eventIsPublic(db, event))
    .map((event) => `/events/${encodeURIComponent(publicProfile(db, event.id).slug)}`);
  const contentRoutes = visiblePosts(db, now).map((row) => `/content/${encodeURIComponent(row.slug)}`);
  const locations = [...new Set([...FIXED_ROUTES, ...eventRoutes, ...contentRoutes])];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations
    .map((route) => `  <url><loc>${escapeXml(`${baseUrl}${route}`)}</loc></url>`)
    .join("\n")}\n</urlset>\n`;
}

export function createPublicSiteRouter({
  store,
  asyncRoute,
  clock = () => new Date(),
  publicSiteUrl = process.env.PUBLIC_SITE_URL
}) {
  const router = express.Router();

  router.get("/public/home", asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.json(homePayload(db, asDate(clock)));
  }));

  router.get("/public/events", asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const now = asDate(clock);
    const page = positiveInteger(req.query.page, 1, "页码");
    const pageSize = positiveInteger(req.query.pageSize, 6, "每页数量", 50);
    const events = historicalEvents(db, now);
    const total = events.length;
    const offset = (page - 1) * pageSize;
    res.json({
      rows: events.slice(offset, offset + pageSize).map((event) => eventSummary(db, event, now)),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) }
    });
  }));

  router.get("/public/events/:slug", asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const now = asDate(clock);
    const profile = (db.eventPublicProfiles || []).find(
      (row) => row.slug === req.params.slug && row.isVisible === true
    );
    const event = profile && (db.events || []).find((row) => row.id === profile.eventId);
    if (!eventIsPublic(db, event)) throw routeError(404, "赛事不存在");
    const posts = visiblePosts(db, now).filter((row) => row.eventId === event.id);
    const guideIds = new Set(posts.filter((row) => row.type === "guide").map((row) => row.id));
    const resources = (db.contentAttachments || [])
      .filter((row) => guideIds.has(row.contentId))
      .sort((left, right) => left.displayOrder - right.displayOrder || String(left.mediaId).localeCompare(String(right.mediaId)))
      .map((row) => publicAttachment(db, row))
      .filter(Boolean);
    res.json({
      event: eventSummary(db, event, now),
      projects: (db.projects || [])
        .filter((row) => row.eventId === event.id && row.enabled)
        .sort((left, right) => left.displayOrder - right.displayOrder || String(left.id).localeCompare(String(right.id)))
        .map(publicProject),
      groups: [...APPROVED_GROUP_NAMES],
      resources,
      content: posts.map((row) => contentSummary(db, row))
    });
  }));

  router.get("/public/content", asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const now = asDate(clock);
    const page = positiveInteger(req.query.page, 1, "页码");
    const pageSize = positiveInteger(req.query.pageSize, 10, "每页数量", 50);
    if (req.query.type !== undefined && !CONTENT_TYPES.has(String(req.query.type))) {
      throw routeError(422, "内容类型不合法");
    }
    let eventId = null;
    if (req.query.event !== undefined) {
      const eventValue = String(req.query.event);
      const profile = (db.eventPublicProfiles || []).find(
        (row) => row.isVisible === true && (row.slug === eventValue || row.eventId === eventValue)
      );
      const event = profile && (db.events || []).find((row) => row.id === profile.eventId);
      if (!eventIsPublic(db, event)) throw routeError(422, "赛事筛选不合法");
      eventId = event.id;
    }
    const rows = visiblePosts(db, now).filter((row) =>
      (req.query.type === undefined || row.type === req.query.type)
      && (!eventId || row.eventId === eventId)
    );
    const total = rows.length;
    const offset = (page - 1) * pageSize;
    res.json({
      rows: rows.slice(offset, offset + pageSize).map((row) => contentSummary(db, row)),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) }
    });
  }));

  router.get("/public/content/:slug", asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const now = asDate(clock);
    const row = (db.contentPosts || []).find((item) => item.slug === req.params.slug && isPublicPost(item, now));
    if (!row) throw routeError(404, "内容不存在");
    res.json({ row: contentDetail(db, row) });
  }));

  router.get("/public/sitemap.xml", asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.type("application/xml").send(sitemapXml(db, asDate(clock), publicSiteUrl));
  }));

  return router;
}
