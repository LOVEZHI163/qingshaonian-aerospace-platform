import { sanitizeContentHtml } from "../content/sanitize.js";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PUBLIC_MEDIA = /\/api\/public\/media\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export function contentBodyMediaIds(html) {
  const ids = [];
  const seen = new Set();
  for (const match of sanitizeContentHtml(html).matchAll(PUBLIC_MEDIA)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function contentBodyMedia(db, html, { label = "正文图片" } = {}) {
  return contentBodyMediaIds(html).map((id) => {
    const media = (db.mediaAssets || []).find((row) => row.id === id && !row.cleanedAt);
    if (!media || !IMAGE_MIME_TYPES.has(media.mimeType)) {
      const error = new Error(`${label}不存在、已失效或不是支持的图片`);
      error.status = 422;
      error.code = "CONTENT_BODY_MEDIA_INVALID";
      throw error;
    }
    return media;
  });
}
