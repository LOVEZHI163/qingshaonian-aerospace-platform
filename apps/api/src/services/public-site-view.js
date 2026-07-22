import { APPROVED_GROUP_NAMES } from "../data/seed.js";
import { isRegistrationOpen } from "../domain/registration-window.js";
import { isPublicPost } from "./content-publishing.js";
import { selectHomeEvents } from "./public-site.js";

const HOME_LIMITS = { announcement: 5, news: 6, work: 6, recap: 6 };

export function mediaView(db, mediaId, {
  allowPrivate = false,
  urlFor = (id, variant = "original") => `/api/public/media/${encodeURIComponent(id)}?variant=${variant}`
} = {}) {
  if (!mediaId) return null;
  const media = (db.mediaAssets || []).find((row) => row.id === mediaId && !row.cleanedAt);
  if (!media || (!allowPrivate && media.visibility !== "public")) return null;
  return {
    id: media.id,
    url: urlFor(media.id, "original"),
    name: media.originalName,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    width: media.width ?? null,
    height: media.height ?? null,
    ...(media.variants?.mobile ? { mobileUrl: urlFor(media.id, "mobile") } : {}),
    ...(media.variants?.desktop ? { desktopUrl: urlFor(media.id, "desktop") } : {})
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

function attachmentsFor(db, contentId, mediaOptions) {
  return (db.contentAttachments || [])
    .filter((row) => row.contentId === contentId)
    .sort((left, right) => left.displayOrder - right.displayOrder || String(left.mediaId).localeCompare(String(right.mediaId)))
    .map((row) => attachmentView(db, row, mediaOptions))
    .filter(Boolean);
}

function comparePosts(left, right) {
  return Number(right.pinned) - Number(left.pinned)
    || left.sortOrder - right.sortOrder
    || Date.parse(right.publishAt) - Date.parse(left.publishAt)
    || String(left.id).localeCompare(String(right.id));
}

export function visiblePosts(db, now) {
  return (db.contentPosts || []).filter((row) => isPublicPost(row, now)).sort(comparePosts);
}

export function publicProfile(db, eventId) {
  return (db.eventPublicProfiles || []).find((row) => row.eventId === eventId && row.isVisible === true) || null;
}

export function eventIsPublic(db, event) {
  return Boolean(publicProfile(db, event?.id)) && ["published", "archived"].includes(event?.status);
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
  return {
    ...contentSummary(db, row, mediaOptions),
    bodyHtml: row.bodyHtml,
    attachments: attachmentsFor(db, row.id, mediaOptions)
  };
}

function publicRegistrationWindow(event, now) {
  if (event.status === "archived" || event.archivedAt) return { open: false, reason: "赛事已归档" };
  if (event.status !== "published") return { open: false, reason: "赛事尚未发布" };
  return isRegistrationOpen(event, now);
}

export function eventSummary(db, event, now, mediaOptions) {
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
    defaultHero: mediaView(db, settings.defaultHeroMediaId),
    shareImage: mediaView(db, settings.shareMediaId)
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

export function buildHomeView(db, now) {
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

export function buildEventDetailView(db, slug, now, { allowPrivateMedia = false } = {}) {
  const profile = (db.eventPublicProfiles || []).find((row) => row.slug === slug && row.isVisible === true);
  const event = profile && (db.events || []).find((row) => row.id === profile.eventId);
  if (!eventIsPublic(db, event)) return null;
  const mediaOptions = allowPrivateMedia ? { allowPrivate: true } : undefined;
  const posts = visiblePosts(db, now).filter((row) => row.eventId === event.id);
  const guideIds = new Set(posts.filter((row) => row.type === "guide").map((row) => row.id));
  const resources = (db.contentAttachments || [])
    .filter((row) => guideIds.has(row.contentId))
    .sort((left, right) => left.displayOrder - right.displayOrder || String(left.mediaId).localeCompare(String(right.mediaId)))
    .map((row) => attachmentView(db, row, mediaOptions))
    .filter(Boolean);
  return {
    event: eventSummary(db, event, now, mediaOptions),
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
    item.slug === slug && (allowUnpublished || isPublicPost(item, now))
  );
  if (!row) return null;
  const mediaOptions = mediaUrl ? { urlFor: mediaUrl } : undefined;
  return { row: contentDetail(db, row, mediaOptions) };
}
