import { sanitizeContentHtml } from "../content/sanitize.js";
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

const SENSITIVE_PREVIEW_FIELDS = new Set([
  "phone", "phonenumber", "mobile", "mobilephone", "email",
  "password", "credential", "credentials", "session", "sessionid", "sessionversion",
  "token", "authorization",
  "user", "userid", "actor", "actorid", "admin", "adminid",
  "audit", "auditlog", "auditlogs", "review", "reviewstatus", "reviewedby",
  "reviewedat", "reviewnote", "reviewnotes", "note", "notes", "internalnote",
  "internalnotes", "remark", "remarks", "rejectreason", "createdby", "updatedby"
]);

function withoutSensitivePreviewFields(value) {
  if (Array.isArray(value)) return value.map(withoutSensitivePreviewFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_PREVIEW_FIELDS.has(key.toLowerCase()))
    .map(([key, child]) => [key, withoutSensitivePreviewFields(child)]));
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
  return { kind: "content", payload, context: { eventId, contentId: current?.id || null } };
}

export function buildSitePreview(db, kind, input, { now }) {
  const snapshot = structuredClone(db);
  let preview;
  if (kind === "homepage") preview = buildHomepagePreview(snapshot, input, now);
  else if (kind === "event") preview = buildEventPreview(snapshot, input, now);
  else if (kind === "content") preview = buildContentPreview(snapshot, input, now);
  else throw new SitePreviewError(404, "预览类型不存在");
  return withoutSensitivePreviewFields(preview);
}
