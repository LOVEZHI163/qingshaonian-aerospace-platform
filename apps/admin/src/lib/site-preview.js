export const PREVIEW_STORAGE_PREFIX = "aerogp:site-preview:v1:";
export const PREVIEW_TTL_MS = 15 * 60 * 1000;

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
    payload,
    context
  }));
  return { token, expiresAt, url: `/preview?token=${encodeURIComponent(token)}` };
}
