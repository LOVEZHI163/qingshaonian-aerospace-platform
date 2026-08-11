import express from "express";

import {
  buildContentDetailView,
  buildEventDetailView,
  buildHomeView,
  contentSummary,
  eventIsPublic,
  eventSummary,
  historicalEvents,
  publicProfile,
  visiblePosts
} from "../services/public-site-view.js";

const CONTENT_TYPES = new Set(["announcement", "news", "work", "recap", "guide"]);
const FIXED_ROUTES = [
  "/", "/about", "/rules", "/registration-guide", "/contact", "/projects",
  "/announcements", "/news", "/history"
];

function routeError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function asDate(clock) {
  const value = new Date(typeof clock === "function" ? clock() : clock);
  if (!Number.isFinite(value.getTime())) throw new TypeError("clock must return a valid date");
  return value;
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
    res.json(buildHomeView(db, asDate(clock)));
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
    const detail = buildEventDetailView(db, req.params.slug, now);
    if (!detail) throw routeError(404, "赛事不存在");
    res.json(detail);
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
    const detail = buildContentDetailView(db, req.params.slug, now);
    if (!detail) throw routeError(404, "内容不存在");
    res.json(detail);
  }));

  router.get("/public/sitemap.xml", asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.type("application/xml").send(sitemapXml(db, asDate(clock), publicSiteUrl));
  }));

  return router;
}
