export class SiteMediaError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

export function mediaReference(db, mediaId) {
  if (db.siteSettings?.defaultHeroMediaId === mediaId) return "首页主视觉";
  if (db.siteSettings?.shareMediaId === mediaId) return "首页分享图";
  if ((db.eventPublicProfiles || []).some((row) => row.heroMediaId === mediaId)) return "赛事公开资料";
  if ((db.contentPosts || []).some((row) => row.coverMediaId === mediaId)) return "文章封面";
  if ((db.contentAttachments || []).some((row) => row.mediaId === mediaId)) return "文章附件";
  return null;
}

export function assertMediaUnreferenced(db, mediaId) {
  const reference = mediaReference(db, mediaId);
  if (reference) throw new SiteMediaError(409, `媒体仍被${reference}引用`, "MEDIA_IN_USE");
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
