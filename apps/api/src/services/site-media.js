import { contentBodyMediaIds } from "./content-body-media.js";

export class SiteMediaError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

export function mediaReferences(db, mediaId) {
  const references = [];
  const events = new Map((db.events || []).map((event) => [event.id, event]));
  const posts = new Map((db.contentPosts || []).map((post) => [post.id, post]));
  if (db.siteSettings?.defaultHeroMediaId === mediaId) {
    references.push({ kind: "default-hero", label: "首页主视觉", entityId: "default", eventId: null });
  }
  if (db.siteSettings?.shareMediaId === mediaId) {
    references.push({ kind: "share-image", label: "首页分享图", entityId: "default", eventId: null });
  }
  for (const profile of db.eventPublicProfiles || []) {
    if (profile.heroMediaId !== mediaId) continue;
    references.push({
      kind: "event-hero",
      label: "赛事封面",
      entityId: profile.eventId,
      eventId: profile.eventId,
      eventName: events.get(profile.eventId)?.name || profile.eventId
    });
  }
  for (const post of db.contentPosts || []) {
    if (post.coverMediaId === mediaId) {
      references.push({ kind: "content-cover", label: "文章封面", entityId: post.id, eventId: post.eventId || null, title: post.title || post.id });
    }
  }
  for (const attachment of db.contentAttachments || []) {
    if (attachment.mediaId !== mediaId) continue;
    const post = posts.get(attachment.contentId);
    references.push({
      kind: "content-attachment",
      label: attachment.label || "文章附件",
      entityId: attachment.contentId,
      eventId: post?.eventId || null,
      title: post?.title || attachment.contentId
    });
  }
  for (const post of db.contentPosts || []) {
    if (!contentBodyMediaIds(post.bodyHtml).includes(mediaId)) continue;
    references.push({ kind: "content-body", label: "文章正文", entityId: post.id, eventId: post.eventId || null, title: post.title || post.id });
  }
  return references;
}

export function mediaReference(db, mediaId) {
  return mediaReferences(db, mediaId)[0]?.label || null;
}

export function assertMediaUnreferenced(db, mediaId) {
  const reference = mediaReference(db, mediaId);
  if (reference) throw new SiteMediaError(409, `媒体仍被${reference}引用`, "MEDIA_IN_USE");
}

export function replaceMediaReferences(db, oldMediaId, newMediaId) {
  let migrated = 0;
  if (db.siteSettings?.defaultHeroMediaId === oldMediaId) {
    db.siteSettings.defaultHeroMediaId = newMediaId;
    migrated += 1;
  }
  if (db.siteSettings?.shareMediaId === oldMediaId) {
    db.siteSettings.shareMediaId = newMediaId;
    migrated += 1;
  }
  for (const profile of db.eventPublicProfiles || []) {
    if (profile.heroMediaId !== oldMediaId) continue;
    profile.heroMediaId = newMediaId;
    migrated += 1;
  }
  for (const post of db.contentPosts || []) {
    if (post.coverMediaId === oldMediaId) {
      post.coverMediaId = newMediaId;
      migrated += 1;
    }
  }
  for (const attachment of db.contentAttachments || []) {
    if (attachment.mediaId !== oldMediaId) continue;
    attachment.mediaId = newMediaId;
    migrated += 1;
  }
  const escaped = oldMediaId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = new RegExp(`(/api/public/media/)${escaped}(?=[?\\s\"'<>/#]|$)`, "g");
  for (const post of db.contentPosts || []) {
    const current = String(post.bodyHtml || "");
    const next = current.replace(source, `$1${newMediaId}`);
    if (next === current) continue;
    post.bodyHtml = next;
    migrated += 1;
  }
  return migrated;
}

export function promoteMedia(db, mediaIds) {
  const requested = new Set((Array.isArray(mediaIds) ? mediaIds : [mediaIds]).filter(Boolean));
  const promoted = [];
  for (const media of db.mediaAssets || []) {
    if (!requested.has(media.id) || media.cleanedAt) continue;
    media.visibility = "public";
    promoted.push(media);
  }
  return promoted;
}

export function promoteContentMedia(db, contentId) {
  const post = (db.contentPosts || []).find((row) => row.id === contentId);
  if (!post) throw new SiteMediaError(404, "内容不存在");
  if (post.status !== "published") return [];
  const mediaIds = [
    post.coverMediaId,
    ...(db.contentAttachments || []).filter((row) => row.contentId === contentId).map((row) => row.mediaId)
  ];
  return promoteMedia(db, mediaIds);
}
