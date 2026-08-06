export const PREVIEW_STORAGE_PREFIX = "aerogp:site-preview:v1:";
export const PREVIEW_TTL_MS = 15 * 60 * 1000;

const PREVIEW_SAFE_FIELDS = new Set([
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

function previewSafeDto(value) {
  if (Array.isArray(value)) return value.map(previewSafeDto);
  if (typeof value === "string") return redactPreviewText(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => PREVIEW_SAFE_FIELDS.has(key))
    .map(([key, child]) => [key, previewSafeDto(child)]));
}

function randomToken() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cleanupPreviewSnapshots({ now = Date.now(), storage = localStorage } = {}) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key) => key?.startsWith(PREVIEW_STORAGE_PREFIX));
  let removed = 0;

  for (const key of keys) {
    try {
      const envelope = JSON.parse(storage.getItem(key));
      if (Number.isFinite(envelope?.expiresAt) && envelope.expiresAt <= now) {
        storage.removeItem(key);
        removed += 1;
      }
    } catch {
      // A malformed entry cannot be treated as a valid snapshot, but is not an expired record.
    }
  }

  return removed;
}

export function createPreviewSnapshot({
  kind,
  payload,
  context = {},
  now = Date.now(),
  storage = localStorage
}) {
  cleanupPreviewSnapshots({ now, storage });
  const token = randomToken();
  const expiresAt = now + PREVIEW_TTL_MS;
  storage.setItem(`${PREVIEW_STORAGE_PREFIX}${token}`, JSON.stringify({
    version: 1,
    token,
    kind,
    createdAt: now,
    expiresAt,
    adminReturnPath: "/admin/",
    payload: previewSafeDto(payload),
    context: previewSafeDto(context)
  }));
  return { token, expiresAt, url: `/preview?token=${encodeURIComponent(token)}` };
}
