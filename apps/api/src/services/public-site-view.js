import { APPROVED_GROUP_NAMES } from "../data/seed.js";
import { sanitizeContentHtml } from "../content/sanitize.js";
import { isRegistrationOpen } from "../domain/registration-window.js";
import { contentBodyMediaIds } from "./content-body-media.js";
import { isPublicPost } from "./content-publishing.js";
import { selectHomeEvents } from "./public-site.js";

const HOME_LIMITS = { announcement: 5, news: 6, work: 6, recap: 6 };
const LEGACY_IMPORTED_IMAGE_LABEL = "转载正文图片";
const IMPORT_IMAGE_TOKEN = /<img\b[^>]*\bsrc=(['"])@@SITE_IMPORT_IMAGE:([A-Za-z0-9_-]+)@@\1[^>]*>/gi;

export function mediaView(db, mediaId, {
  allowPrivate = false,
  urlFor
} = {}) {
  if (!mediaId) return null;
  const media = (db.mediaAssets || []).find((row) => row.id === mediaId && !row.cleanedAt);
  if (!media || (media.visibility !== "public" && (!allowPrivate || typeof urlFor !== "function"))) return null;
  const publicUrlFor = (id, variant = "original") =>
    `/api/public/media/${encodeURIComponent(id)}?variant=${variant}`;
  const resolvedUrlFor = typeof urlFor === "function" ? urlFor : publicUrlFor;
  return {
    id: media.id,
    url: resolvedUrlFor(media.id, "original"),
    name: media.originalName,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    width: media.width ?? null,
    height: media.height ?? null,
    ...(media.variants?.mobile ? { mobileUrl: resolvedUrlFor(media.id, "mobile") } : {}),
    ...(media.variants?.desktop ? { desktopUrl: resolvedUrlFor(media.id, "desktop") } : {})
  };
}

function attachmentView(db, attachment, mediaOptions) {
  const media = mediaView(db, attachment.mediaId, mediaOptions);
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

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function comparableContentHtml(value) {
  return sanitizeContentHtml(value)
    .replace(/<figure>\s*<\/figure>/gi, "")
    .replace(/>\s+</g, "><")
    .trim();
}

function legacyImportTemplate(db, row, legacyAttachments) {
  if (!row.sourceUrlFingerprint || !legacyAttachments.length) return null;
  const candidates = (db.siteContentImportBatches || [])
    .filter((batch) => batch.status === "committed"
      && batch.sourceUrlFingerprint === row.sourceUrlFingerprint
      && String(batch.bodyTemplateHtml || "").includes("@@SITE_IMPORT_IMAGE:"))
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
  for (const batch of candidates) {
    const textOnlyTemplate = String(batch.bodyTemplateHtml || "").replace(IMPORT_IMAGE_TOKEN, "");
    if (comparableContentHtml(textOnlyTemplate) === comparableContentHtml(row.bodyHtml)) return batch;
  }
  return null;
}

function restoreLegacyImportedBody(db, row, legacyAttachments) {
  const batch = legacyImportTemplate(db, row, legacyAttachments);
  if (!batch) return null;

  const attachmentsByName = new Map();
  for (const attachment of legacyAttachments) {
    const key = String(attachment.name || "").trim().toLowerCase();
    const queue = attachmentsByName.get(key) || [];
    queue.push(attachment);
    attachmentsByName.set(key, queue);
  }
  const attachmentByImageId = new Map();
  for (const image of batch.images || []) {
    const key = String(image.originalName || "").trim().toLowerCase();
    const attachment = attachmentsByName.get(key)?.shift();
    if (attachment) attachmentByImageId.set(image.id, attachment);
  }
  if (attachmentByImageId.size !== legacyAttachments.length) return null;

  const restored = String(batch.bodyTemplateHtml || "").replace(
    IMPORT_IMAGE_TOKEN,
    (tag, _quote, imageId) => {
      const attachment = attachmentByImageId.get(imageId);
      if (!attachment) return "";
      return tag.replace(
        `@@SITE_IMPORT_IMAGE:${imageId}@@`,
        `/api/public/media/${encodeURIComponent(attachment.id)}`
      );
    }
  );
  return sanitizeContentHtml(restored);
}

function contentMedia(db, row, mediaOptions) {
  const views = (db.contentAttachments || [])
    .filter((attachment) => attachment.contentId === row.id)
    .sort((left, right) => left.displayOrder - right.displayOrder || String(left.mediaId).localeCompare(String(right.mediaId)))
    .map((attachment) => attachmentView(db, attachment, mediaOptions))
    .filter(Boolean);
  let bodyHtml = String(row.bodyHtml || "");
  const bodyMediaIds = new Set(contentBodyMediaIds(bodyHtml));
  const legacyFigures = [];
  const legacyAttachments = [];

  for (const attachment of views) {
    if (bodyMediaIds.has(attachment.id)) continue;
    if (attachment.label !== LEGACY_IMPORTED_IMAGE_LABEL || !String(attachment.mimeType || "").startsWith("image/")) continue;
    bodyMediaIds.add(attachment.id);
    legacyAttachments.push(attachment);
    const alt = escapeHtmlAttribute(attachment.label || attachment.name || "正文图片");
    legacyFigures.push(`<figure><img src="/api/public/media/${encodeURIComponent(attachment.id)}" alt="${alt}"></figure>`);
  }

  if (legacyFigures.length) {
    bodyHtml = restoreLegacyImportedBody(db, row, legacyAttachments)
      || sanitizeContentHtml(`${bodyHtml}${legacyFigures.join("")}`);
  }
  const referencedMediaIds = new Set(contentBodyMediaIds(bodyHtml));
  return {
    bodyHtml,
    attachments: views.filter((attachment) => !referencedMediaIds.has(attachment.id))
  };
}

function comparePosts(left, right) {
  return Number(right.pinned) - Number(left.pinned)
    || left.sortOrder - right.sortOrder
    || Date.parse(right.publishAt) - Date.parse(left.publishAt)
    || String(left.id).localeCompare(String(right.id));
}

export function isPublicContentPost(db, row, now) {
  if (!isPublicPost(row, now)) return false;
  if (!row.eventId) return true;
  const event = (db.events || []).find((item) => item.id === row.eventId);
  return ["published", "archived"].includes(event?.status);
}

export function visiblePosts(db, now) {
  return (db.contentPosts || []).filter((row) => isPublicContentPost(db, row, now)).sort(comparePosts);
}

export function publicProfile(db, eventId) {
  return (db.eventPublicProfiles || []).find((row) => row.eventId === eventId) || null;
}

export function eventIsPublic(db, event, now = new Date()) {
  const profile = publicProfile(db, event?.id);
  if (!profile) return false;
  if (event?.status === "archived") return profile.isVisible === true;
  return event?.status === "published" || event?.isCurrent === true
    || (!event?.archivedAt && isRegistrationOpen(event, now).open);
}

export function contentSummary(db, row, mediaOptions) {
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
    cover: mediaView(db, row.coverMediaId, mediaOptions)
  };
}

function contentDetail(db, row, mediaOptions) {
  const media = contentMedia(db, row, mediaOptions);
  return {
    ...contentSummary(db, row, mediaOptions),
    bodyHtml: media.bodyHtml,
    attachments: media.attachments,
    source: publicContentSource(row)
  };
}

function publicContentSource(row) {
  if (!row?.sourceUrl) return null;
  try {
    const url = new URL(row.sourceUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return {
      name: String(row.sourceName || "").trim(),
      author: String(row.sourceAuthor || "").trim(),
      url: url.href,
      publishedAt: row.sourcePublishedAt || null
    };
  } catch {
    return null;
  }
}

function publicRegistrationWindow(event, now) {
  if (event.status === "archived" || event.archivedAt) return { open: false, reason: "赛事已归档" };
  return isRegistrationOpen(event, now);
}

export function eventSummary(db, event, now, mediaOptions, profileOverride) {
  if (!event) return null;
  const profile = profileOverride === undefined ? publicProfile(db, event.id) : profileOverride;
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
    hero: mediaView(db, profile.heroMediaId || db.siteSettings?.defaultHeroMediaId, mediaOptions)
  };
}

export function historicalEvents(db, now) {
  const selection = selectHomeEvents(db, now);
  const homepageEventIds = new Set([
    selection.featuredEvent?.id,
    ...(selection.concurrentEvents || []).map((event) => event.id)
  ].filter(Boolean));
  return (db.events || [])
    .filter((event) => {
      if (!eventIsPublic(db, event, now) || publicProfile(db, event.id)?.isVisible !== true) return false;
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

function publicSiteSettings(db, mediaOptions) {
  const settings = db.siteSettings || {};
  return {
    platformName: settings.platformName || "",
    platformIntro: settings.platformIntro || "",
    organizers: Array.isArray(settings.organizers) ? settings.organizers : [],
    contact: settings.contact || "",
    icp: settings.icp || "",
    seoTitle: settings.seoTitle || "",
    seoDescription: settings.seoDescription || "",
    defaultHero: mediaView(db, settings.defaultHeroMediaId, mediaOptions),
    shareImage: mediaView(db, settings.shareMediaId, mediaOptions)
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

export function buildHomeView(db, now, { mediaUrl } = {}) {
  const mediaOptions = typeof mediaUrl === "function" ? { allowPrivate: true, urlFor: mediaUrl } : undefined;
  const selection = selectHomeEvents(db, now);
  const selected = selection.featuredEvent || selection.fallbackEvent;
  const featuredEvent = eventSummary(db, selected, now, mediaOptions);
  const posts = visiblePosts(db, now);
  const section = (type) => posts
    .filter((row) => row.type === type)
    .slice(0, HOME_LIMITS[type])
    .map((row) => contentSummary(db, row, mediaOptions));
  return {
    site: publicSiteSettings(db, mediaOptions),
    mode: selection.mode,
    featuredEvent,
    concurrentEvents: selection.concurrentEvents.map((row) => eventSummary(db, row, now, mediaOptions)).filter(Boolean),
    services: servicesFor(featuredEvent, selection.mode),
    announcements: section("announcement"),
    news: section("news"),
    works: section("work"),
    history: section("recap")
  };
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
    submissionMode: row.submissionMode || "none",
    allowedGroups: Array.isArray(row.allowedGroups) ? row.allowedGroups : []
  };
}

export function buildEventDetailView(db, slug, now, { allowUnpublished = false, mediaUrl } = {}) {
  const profile = (db.eventPublicProfiles || []).find((row) =>
    row.slug === slug && (allowUnpublished || eventIsPublic(db, (db.events || []).find((event) => event.id === row.eventId), now)));
  const event = profile && (db.events || []).find((row) => row.id === profile.eventId);
  if (!event || (!allowUnpublished && !eventIsPublic(db, event, now))) return null;
  const mediaOptions = typeof mediaUrl === "function" ? { allowPrivate: true, urlFor: mediaUrl } : undefined;
  const posts = visiblePosts(db, now).filter((row) => row.eventId === event.id);
  const guideIds = new Set(posts.filter((row) => row.type === "guide").map((row) => row.id));
  const resources = (db.contentAttachments || [])
    .filter((row) => guideIds.has(row.contentId))
    .sort((left, right) => left.displayOrder - right.displayOrder || String(left.mediaId).localeCompare(String(right.mediaId)))
    .map((row) => attachmentView(db, row, mediaOptions))
    .filter(Boolean);
  return {
    event: eventSummary(db, event, now, mediaOptions, profile),
    projects: (db.projects || [])
      .filter((row) => row.eventId === event.id && row.enabled)
      .sort((left, right) => left.displayOrder - right.displayOrder || String(left.id).localeCompare(String(right.id)))
      .map(publicProject),
    groups: [...APPROVED_GROUP_NAMES],
    resources,
    content: posts.map((row) => contentSummary(db, row, mediaOptions))
  };
}

export function buildContentDetailView(db, slug, now, { allowUnpublished = false, mediaUrl } = {}) {
  const row = (db.contentPosts || []).find((item) =>
    item.slug === slug && (allowUnpublished || isPublicContentPost(db, item, now))
  );
  if (!row) return null;
  const mediaOptions = typeof mediaUrl === "function" ? { allowPrivate: true, urlFor: mediaUrl } : undefined;
  return { row: contentDetail(db, row, mediaOptions) };
}
