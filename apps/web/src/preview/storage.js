export const PREVIEW_STORAGE_PREFIX = "aerogp:site-preview:v1:";

const PREVIEW_TOKEN_PATTERN = /^[a-f0-9]{48}$/;
const PREVIEW_KINDS = new Set(["homepage", "event", "content"]);

export function readPreviewSnapshot(token, { now = Date.now(), storage = localStorage } = {}) {
  const normalizedToken = String(token || "");
  if (!PREVIEW_TOKEN_PATTERN.test(normalizedToken)) return { ok: false, reason: "invalid" };

  const key = `${PREVIEW_STORAGE_PREFIX}${normalizedToken}`;
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
