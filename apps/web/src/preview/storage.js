export const PREVIEW_STORAGE_PREFIX = "aerogp:site-preview:v1:";

const PREVIEW_TOKEN_PATTERN = /^[a-f0-9]{48}$/;
const PREVIEW_KINDS = new Set(["homepage", "event", "content"]);

function cleanupExpiredPreviewSnapshots(storage, now) {
  const removed = new Set();
  let keys;
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => typeof key === "string" && key.startsWith(PREVIEW_STORAGE_PREFIX));
  } catch {
    return removed;
  }
  for (const key of keys) {
    try {
      const snapshot = JSON.parse(storage.getItem(key) || "null");
      if (Number.isFinite(snapshot?.expiresAt) && snapshot.expiresAt <= now) {
        storage.removeItem(key);
        removed.add(key);
      }
    } catch {
      // The requested malformed record is handled below; unrelated malformed records are left untouched.
    }
  }
  return removed;
}

export function readPreviewSnapshot(token, { now = Date.now(), storage = localStorage } = {}) {
  const removedExpired = cleanupExpiredPreviewSnapshots(storage, now);
  const normalizedToken = String(token || "");
  if (!PREVIEW_TOKEN_PATTERN.test(normalizedToken)) return { ok: false, reason: "invalid" };

  const key = `${PREVIEW_STORAGE_PREFIX}${normalizedToken}`;
  if (removedExpired.has(key)) return { ok: false, reason: "expired" };
  let serialized;
  try {
    serialized = storage.getItem(key);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(serialized || "null");
  } catch {
    try { storage.removeItem(key); } catch { /* Storage is unavailable. */ }
    return { ok: false, reason: "invalid" };
  }

  if (!snapshot || snapshot.version !== 1 || snapshot.token !== normalizedToken || !PREVIEW_KINDS.has(snapshot.kind)) {
    return { ok: false, reason: "invalid" };
  }

  if (!Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= now) {
    try { storage.removeItem(key); } catch { /* The expired value remains inaccessible. */ }
    return { ok: false, reason: "expired" };
  }

  return { ok: true, snapshot };
}
