import { sanitizeContentHtml } from "../content/sanitize.js";
import { contentBodyMedia } from "./content-body-media.js";
import {
  buildContentDetailView,
  buildEventDetailView,
  buildHomeView
} from "./public-site-view.js";
import { createContent, updateContentForPreview, updateSiteSettings, upsertEventPublicProfile } from "./site-admin.js";

export class SitePreviewError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

const PREVIEW_SAFE_FIELDS = new Set([
  "kind", "payload", "context",
  "site", "mode", "featuredEvent", "concurrentEvents", "services",
  "announcements", "news", "works", "history",
  "event", "projects", "groups", "resources", "content", "row",
  "platformName", "platformIntro", "organizers", "icp", "seoTitle", "seoDescription",
  "defaultHero", "shareImage", "hero", "cover", "attachments",
  "id", "slug", "name", "theme", "slogan", "summary", "dateLabel", "venue",
  "registrationStartAt", "registrationEndAt", "registrationMode", "registrationWindow",
  "status", "archivedAt", "open", "reason",
  "key", "label", "eventId", "contentId", "available", "href",
  "eventSlug", "type", "title", "publishAt", "pinned", "bodyHtml",
  "url", "mimeType", "sizeBytes", "width", "height", "mobileUrl", "desktopUrl",
  "displayOrder", "category", "enabled", "instructorRequired", "allowedGroups"
]);

function redactPreviewText(value) {
  return String(value)
    .replace(
      /(^|[^\d])((?:\+?86[-\s]?)?1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})(?=$|[^\d])/g,
      "$1【联系方式已隐藏】"
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "【邮箱已隐藏】");
}

function toPreviewSafeDto(value) {
  if (Array.isArray(value)) return value.map(toPreviewSafeDto);
  if (typeof value === "string") return redactPreviewText(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => PREVIEW_SAFE_FIELDS.has(key))
    .map(([key, child]) => [key, toPreviewSafeDto(child)]));
}

function fail(status, message, code) {
  throw new SitePreviewError(status, message, code);
}

function assertObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(422, "请求内容必须是 JSON 对象");
}

function protectedMediaUrl(id, variant = "original") {
  const base = `/api/admin/site-media/${encodeURIComponent(id)}/preview`;
  return variant === "original" ? base : `${base}?variant=${encodeURIComponent(variant)}`;
}

function previewContentBodyHtml(html) {
  return String(html).replace(
    /(<img\b[^>]*\ssrc=")\/api\/public\/media\/([A-Za-z0-9][A-Za-z0-9._-]*)(")/gi,
    (_match, before, id, after) => `${before}${protectedMediaUrl(id)}${after}`
  );
}

function eventFor(db, eventId, { optional = false } = {}) {
  if (optional && (eventId === null || eventId === undefined || eventId === "")) return null;
  const event = (db.events || []).find((row) => row.id === eventId);
  if (!event) fail(422, "赛事不存在");
  return event;
}

function mediaFor(db, mediaId, label, eventId = null) {
  if (mediaId === null || mediaId === undefined || mediaId === "") return null;
  const media = (db.mediaAssets || []).find((row) => row.id === mediaId && !row.cleanedAt);
  if (!media) fail(422, `${label}不存在或已失效`);
  if (eventId && media.eventId && media.eventId !== eventId) fail(422, `${label}不属于当前赛事`);
  return media;
}

function normalizeAttachments(db, contentId, attachments, eventId) {
  if (!Array.isArray(attachments)) fail(422, "附件必须是数组");
  const seen = new Set();
  return attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) fail(422, "附件格式无效");
    const mediaId = String(attachment.mediaId || "").trim();
    if (!mediaId || seen.has(mediaId)) fail(422, "附件媒体不能为空或重复");
    seen.add(mediaId);
    mediaFor(db, mediaId, "附件媒体", eventId);
    const displayOrder = attachment.displayOrder ?? index;
    if (!Number.isInteger(displayOrder)) fail(422, "附件排序必须是整数");
    return { contentId, mediaId, label: String(attachment.label || ""), displayOrder };
  });
}

function buildHomepagePreview(db, input, now) {
  assertObject(input);
  updateSiteSettings(db, input, { incrementVersion: false });
  if (Object.hasOwn(input, "platformName")) db.siteSettings.platformName = String(input.platformName || "").trim();
  return {
    kind: "homepage",
    payload: buildHomeView(db, new Date(now), { mediaUrl: protectedMediaUrl }),
    context: { eventId: null, contentId: null }
  };
}

function buildEventPreview(db, input, now) {
  assertObject(input);
  const eventId = String(input.eventId || "").trim();
  const event = eventFor(db, eventId);
  mediaFor(db, input.heroMediaId, "赛事主视觉", eventId);
  const profileInput = { ...input };
  delete profileInput.eventId;
  const canHideProfileForPreview = !Object.hasOwn(profileInput, "isVisible")
    || typeof profileInput.isVisible === "boolean";
  if (!["published", "archived"].includes(event.status) && canHideProfileForPreview) {
    profileInput.isVisible = false;
  }
  const { row } = upsertEventPublicProfile(db, eventId, profileInput, { now, incrementVersion: false });
  const payload = buildEventDetailView(db, row.slug, new Date(now), {
    allowUnpublished: true,
    mediaUrl: protectedMediaUrl
  });
  if (!payload) fail(422, "赛事不可预览");
  return { kind: "event", payload, context: { eventId, contentId: null } };
}

function buildContentPreview(db, input, now) {
  assertObject(input);
  const requestedId = typeof input.contentId === "string" ? input.contentId : input.id;
  const current = requestedId ? (db.contentPosts || []).find((row) => row.id === requestedId) : null;
  if (requestedId && !current) fail(404, "内容不存在");
  const timestamp = new Date(now).toISOString();
  const sanitizedInput = {
    ...input,
    bodyHtml: sanitizeContentHtml(input.bodyHtml ?? current?.bodyHtml ?? "")
  };
  const eventId = (Object.hasOwn(sanitizedInput, "eventId") ? sanitizedInput.eventId : current?.eventId) || null;
  eventFor(db, eventId, { optional: true });
  contentBodyMedia(db, sanitizedInput.bodyHtml);
  const coverMediaId = Object.hasOwn(sanitizedInput, "coverMediaId")
    ? sanitizedInput.coverMediaId
    : current?.coverMediaId;
  mediaFor(db, coverMediaId, "文章封面", eventId);
  const contentId = current?.id || "preview-content";
  const attachmentInput = Object.hasOwn(input, "attachments")
    ? input.attachments
    : (db.contentAttachments || []).filter((attachment) => attachment.contentId === contentId);
  normalizeAttachments(db, contentId, attachmentInput || [], eventId);
  const mutationInput = { ...sanitizedInput, attachments: attachmentInput || [] };
  const row = current
    ? updateContentForPreview(db, current.id, mutationInput, { now: timestamp })
    : createContent(db, mutationInput, { id: contentId, actor: { id: null }, now: timestamp });
  const payload = buildContentDetailView(db, row.slug, new Date(now), {
    allowUnpublished: true,
    mediaUrl: protectedMediaUrl
  });
  payload.row.bodyHtml = previewContentBodyHtml(payload.row.bodyHtml);
  return { kind: "content", payload, context: { eventId, contentId: current?.id || null } };
}

export function buildSitePreview(db, kind, input, { now }) {
  const snapshot = structuredClone(db);
  let preview;
  if (kind === "homepage") preview = buildHomepagePreview(snapshot, input, now);
  else if (kind === "event") preview = buildEventPreview(snapshot, input, now);
  else if (kind === "content") preview = buildContentPreview(snapshot, input, now);
  else throw new SitePreviewError(404, "预览类型不存在");
  return toPreviewSafeDto(preview);
}
