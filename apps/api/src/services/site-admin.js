import { sanitizeContentHtml } from "../content/sanitize.js";
import { isRegistrationOpen } from "../domain/registration-window.js";
import { contentBodyMedia, contentBodyMediaIds } from "./content-body-media.js";
import { normalizeContentInput } from "./content-publishing.js";
import { eventProfileSlugIsLocked } from "./event-profile-publication.js";
import { promoteContentMedia, promoteMedia } from "./site-media.js";

const SETTINGS_FIELDS = new Set([
  "featuredEventId",
  "platformIntro",
  "organizers",
  "contact",
  "icp",
  "seoTitle",
  "seoDescription",
  "defaultHeroMediaId",
  "shareMediaId"
]);
const PROFILE_FIELDS = ["slug", "slogan", "summary", "isVisible", "displayOrder", "heroMediaId"];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SiteAdminError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

function fail(status, message, code) {
  throw new SiteAdminError(status, message, code);
}

function assertVersion(input, current, code = "VERSION_CONFLICT") {
  if (!Number.isInteger(input?.version) || input.version !== current.version) {
    fail(409, "内容已被其他修改覆盖", code);
  }
}

function assertEvent(db, eventId, { optional = false } = {}) {
  if (optional && (eventId === null || eventId === undefined || eventId === "")) return null;
  const event = (db.events || []).find((row) => row.id === eventId);
  if (!event) fail(422, "赛事不存在");
  return event;
}

function assertContentEventPublishable(db, eventId) {
  const event = assertEvent(db, eventId, { optional: true });
  if (event && !["published", "archived"].includes(event.status)) {
    fail(422, "关联赛事尚未发布，内容只能保存为草稿", "CONTENT_EVENT_NOT_PUBLISHED");
  }
  return event;
}

function contentPlainText(html) {
  return sanitizeContentHtml(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assertContentReadyForPublication(db, post) {
  assertContentEventPublishable(db, post.eventId);
  if (!contentPlainText(post.bodyHtml)) {
    fail(422, "正文不能为空", "CONTENT_BODY_REQUIRED");
  }
  return sanitizeContentHtml(post.bodyHtml);
}

function media(db, mediaId, label) {
  if (mediaId === null || mediaId === undefined || mediaId === "") return null;
  const row = (db.mediaAssets || []).find((item) => item.id === mediaId && !item.cleanedAt);
  if (!row) fail(422, `${label}不存在或已失效`);
  return row;
}

function safeMediaDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.eventId ?? null,
    purpose: row.purpose,
    visibility: row.visibility,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width ?? null,
    height: row.height ?? null,
    variants: Object.fromEntries(Object.entries(row.variants || {}).map(([name, variant]) => [name, {
      mimeType: variant.mimeType,
      sizeBytes: variant.sizeBytes,
      width: variant.width ?? null,
      height: variant.height ?? null
    }]))
  };
}

function normalizeSlug(value) {
  const slug = typeof value === "string" ? value.trim() : "";
  if (!SLUG.test(slug)) fail(422, "slug格式不合法");
  return slug;
}

function assertUniqueSlug(rows, slug, key, currentKey = null) {
  if (rows.some((row) => row[key] !== currentKey && row.slug === slug)) fail(409, "slug已存在", "SLUG_CONFLICT");
}

function versionAfterMutation(currentVersion, incrementVersion) {
  return incrementVersion ? currentVersion + 1 : currentVersion;
}

function contentSlugIsLocked(db, post) {
  return ["published", "offline"].includes(post.status)
    || (db.auditLogs || []).some((row) => row.action === "content.publish" && row.targetId === post.id);
}

export function updateSiteSettings(db, input, { incrementVersion = true } = {}) {
  const current = db.siteSettings;
  assertVersion(input, current, "SITE_SETTINGS_VERSION_CONFLICT");
  const next = { ...current };
  for (const field of SETTINGS_FIELDS) {
    if (Object.hasOwn(input, field)) next[field] = input[field];
  }
  if (next.featuredEventId !== null) {
    const event = assertEvent(db, next.featuredEventId);
    const visible = (db.eventPublicProfiles || []).some((row) => row.eventId === next.featuredEventId && row.isVisible === true);
    if (!visible || event.status !== "published" || event.archivedAt) fail(422, "首页推荐赛事必须已公开");
  }
  if (!Array.isArray(next.organizers) || !next.organizers.every((item) => typeof item === "string")) {
    fail(422, "主办单位必须是字符串数组");
  }
  media(db, next.defaultHeroMediaId, "首页主视觉");
  media(db, next.shareMediaId, "分享图片");
  next.version = versionAfterMutation(current.version, incrementVersion);
  db.siteSettings = next;
  promoteMedia(db, [next.defaultHeroMediaId, next.shareMediaId]);
  return next;
}

export function upsertEventPublicProfile(db, eventId, input, { now, incrementVersion = true } = {}) {
  const event = assertEvent(db, eventId);
  const profiles = db.eventPublicProfiles || (db.eventPublicProfiles = []);
  const current = profiles.find((row) => row.eventId === eventId);
  if (current) assertVersion(input, current, "EVENT_PROFILE_VERSION_CONFLICT");
  const slug = normalizeSlug(Object.hasOwn(input, "slug") ? input.slug : current?.slug);
  if (current && slug !== current.slug && eventProfileSlugIsLocked(db, eventId)) {
    fail(409, "已公开过的赛事不能更改slug", "EVENT_SLUG_STABLE");
  }
  assertUniqueSlug(profiles, slug, "eventId", eventId);
  const next = current ? { ...current } : {
    eventId,
    slogan: "",
    summary: "",
    isVisible: false,
    displayOrder: 0,
    heroMediaId: null,
    version: 1
  };
  for (const field of PROFILE_FIELDS) {
    if (Object.hasOwn(input, field)) next[field] = input[field];
  }
  next.slug = slug;
  if (typeof next.isVisible !== "boolean") fail(422, "公开状态必须是布尔值");
  if (!Number.isInteger(next.displayOrder)) fail(422, "排序必须是整数");
  if (next.isVisible && !["published", "archived"].includes(event.status)
    && !event.isCurrent && !isRegistrationOpen(event, new Date(now)).open) {
    fail(422, "赛事尚未发布，不能在官网公开", "EVENT_NOT_PUBLISHED");
  }
  media(db, next.heroMediaId, "赛事主视觉");
  next.version = current ? versionAfterMutation(current.version, incrementVersion) : 1;
  next.updatedAt = new Date(now).toISOString();
  if (current) profiles[profiles.indexOf(current)] = next;
  else profiles.push(next);
  if (next.isVisible) promoteMedia(db, next.heroMediaId);
  return { row: next, created: !current };
}

export function listEventPublicProfiles(db) {
  return (db.eventPublicProfiles || []).map((profile) => ({
    ...profile,
    event: (db.events || []).find((event) => event.id === profile.eventId) || null
  }));
}

function normalizeAttachments(db, contentId, attachments) {
  if (!Array.isArray(attachments)) fail(422, "附件必须是数组");
  const seen = new Set();
  return attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) fail(422, "附件格式无效");
    const mediaId = String(attachment.mediaId || "").trim();
    if (!mediaId || seen.has(mediaId)) fail(422, "附件媒体不能为空或重复");
    seen.add(mediaId);
    media(db, mediaId, "附件媒体");
    const displayOrder = attachment.displayOrder ?? index;
    if (!Number.isInteger(displayOrder)) fail(422, "附件排序必须是整数");
    return { contentId, mediaId, label: String(attachment.label || ""), displayOrder };
  });
}

function replaceAttachments(db, contentId, attachments) {
  db.contentAttachments ||= [];
  db.contentAttachments = db.contentAttachments.filter((row) => row.contentId !== contentId);
  db.contentAttachments.push(...attachments);
}

function assertContentReferences(db, post) {
  assertEvent(db, post.eventId, { optional: true });
  media(db, post.coverMediaId, "文章封面");
  const attachments = (db.contentAttachments || []).filter((row) => row.contentId === post.id);
  for (const attachment of attachments) media(db, attachment.mediaId, "附件媒体");
  return attachments;
}

export function createContent(db, input, { id, actor, now } = {}) {
  const slug = normalizeSlug(input?.slug);
  assertUniqueSlug(db.contentPosts || [], slug, "id");
  assertEvent(db, input?.eventId, { optional: true });
  media(db, input?.coverMediaId, "文章封面");
  const timestamp = new Date(now).toISOString();
  const row = normalizeContentInput({
    slug,
    eventId: input?.eventId || null,
    type: input?.type,
    title: input?.title,
    summary: input?.summary || "",
    bodyHtml: input?.bodyHtml || "",
    status: "draft",
    publishAt: null,
    pinned: input?.pinned ?? false,
    sortOrder: input?.sortOrder ?? 0,
    coverMediaId: input?.coverMediaId || null
  }, null, timestamp);
  row.bodyHtml = sanitizeContentHtml(row.bodyHtml);
  contentBodyMedia(db, row.bodyHtml);
  Object.assign(row, { id, createdBy: actor.id, createdAt: timestamp, updatedAt: timestamp });
  const attachments = normalizeAttachments(db, id, input?.attachments || []);
  db.contentPosts ||= [];
  db.contentPosts.push(row);
  replaceAttachments(db, id, attachments);
  return row;
}

function buildContentUpdateCandidate(db, contentId, input, {
  now,
  incrementVersion = true,
  allowVisibilityStatuses = false
} = {}) {
  const current = (db.contentPosts || []).find((row) => row.id === contentId);
  if (!current) fail(404, "内容不存在");
  assertVersion(input, current, "CONTENT_VERSION_CONFLICT");
  if (!allowVisibilityStatuses && current.status === "published") {
    fail(409, "已发布内容请先下线再编辑", "CONTENT_EDIT_REQUIRES_OFFLINE");
  }
  if (!allowVisibilityStatuses && Object.hasOwn(input, "status") && !["draft", "scheduled"].includes(input.status)) {
    fail(422, "普通编辑只能设置草稿或定时发布状态");
  }
  const slug = Object.hasOwn(input, "slug") ? normalizeSlug(input.slug) : current.slug;
  if (slug !== current.slug && contentSlugIsLocked(db, current)) {
    fail(409, "已发布过的内容不能更改slug", "CONTENT_SLUG_STABLE");
  }
  assertUniqueSlug(db.contentPosts, slug, "id", current.id);
  const status = Object.hasOwn(input, "status") ? input.status : current.status;
  const publishAt = status === "draft"
    ? null
    : status === "scheduled"
      ? (Object.hasOwn(input, "publishAt") ? input.publishAt : current.publishAt)
      : allowVisibilityStatuses && Object.hasOwn(input, "publishAt")
        ? input.publishAt
        : current.publishAt;
  const candidate = {
    ...input,
    slug,
    status,
    publishAt,
    version: current.version
  };
  const next = normalizeContentInput(candidate, current, now);
  next.bodyHtml = sanitizeContentHtml(next.bodyHtml);
  contentBodyMedia(db, next.bodyHtml);
  if (next.status === "scheduled") assertContentReadyForPublication(db, next);
  next.version = versionAfterMutation(current.version, incrementVersion);
  next.createdBy = current.createdBy;
  next.createdAt = current.createdAt;
  next.updatedAt = new Date(now).toISOString();
  assertEvent(db, next.eventId, { optional: true });
  media(db, next.coverMediaId, "文章封面");
  const attachments = Object.hasOwn(input, "attachments")
    ? normalizeAttachments(db, current.id, input.attachments)
    : (db.contentAttachments || []).filter((row) => row.contentId === current.id);
  return { current, next, attachments };
}

function applyContentUpdateCandidate(db, { current, next, attachments }) {
  db.contentPosts[db.contentPosts.indexOf(current)] = next;
  replaceAttachments(db, current.id, attachments);
  return next;
}

export function updateContent(db, contentId, input, { now, incrementVersion = true } = {}) {
  const candidate = buildContentUpdateCandidate(db, contentId, input, { now, incrementVersion });
  return applyContentUpdateCandidate(db, candidate);
}

export function updateContentForPreview(db, contentId, input, { now } = {}) {
  const candidate = buildContentUpdateCandidate(db, contentId, input, {
    now,
    incrementVersion: false,
    allowVisibilityStatuses: true
  });
  return applyContentUpdateCandidate(db, candidate);
}

export function contentDetail(db, contentId) {
  const row = (db.contentPosts || []).find((post) => post.id === contentId);
  if (!row) fail(404, "内容不存在");
  const attachments = (db.contentAttachments || [])
    .filter((attachment) => attachment.contentId === contentId)
    .sort((left, right) => left.displayOrder - right.displayOrder || left.mediaId.localeCompare(right.mediaId))
    .map((attachment) => ({
      ...attachment,
      media: safeMediaDto((db.mediaAssets || []).find((item) => item.id === attachment.mediaId))
    }));
  return { ...row, attachments, previewHtml: sanitizeContentHtml(row.bodyHtml) };
}

export function deleteContent(db, contentId, input) {
  const current = (db.contentPosts || []).find((row) => row.id === contentId);
  if (!current) fail(404, "内容不存在");
  assertVersion(input, current, "CONTENT_VERSION_CONFLICT");
  if (!["draft", "offline"].includes(current.status)) {
    fail(409, "内容必须处于草稿或下线状态才能删除", "CONTENT_DELETE_STATE_CONFLICT");
  }
  db.contentPosts = db.contentPosts.filter((row) => row.id !== contentId);
  db.contentAttachments = (db.contentAttachments || []).filter((row) => row.contentId !== contentId);
  return current;
}

export function publishContent(db, contentId, input, { now, incrementVersion = true } = {}) {
  const current = (db.contentPosts || []).find((row) => row.id === contentId);
  if (!current) fail(404, "内容不存在");
  assertVersion(input, current, "CONTENT_VERSION_CONFLICT");
  assertContentReferences(db, current);
  const bodyHtml = assertContentReadyForPublication(db, current);
  contentBodyMedia(db, bodyHtml);
  const timestamp = new Date(now).toISOString();
  const next = normalizeContentInput({
    version: current.version,
    status: "published",
    publishAt: timestamp,
    bodyHtml
  }, current, timestamp);
  next.version = versionAfterMutation(current.version, incrementVersion);
  next.updatedAt = timestamp;
  db.contentPosts[db.contentPosts.indexOf(current)] = next;
  promoteContentMedia(db, contentId);
  promoteMedia(db, contentBodyMediaIds(bodyHtml));
  return next;
}

export function offlineContent(db, contentId, input, { now, incrementVersion = true } = {}) {
  const current = (db.contentPosts || []).find((row) => row.id === contentId);
  if (!current) fail(404, "内容不存在");
  assertVersion(input, current, "CONTENT_VERSION_CONFLICT");
  const next = {
    ...current,
    status: "offline",
    version: versionAfterMutation(current.version, incrementVersion),
    updatedAt: new Date(now).toISOString()
  };
  db.contentPosts[db.contentPosts.indexOf(current)] = next;
  return next;
}
