const CONTENT_TYPES = new Set(["announcement", "news", "work", "recap", "guide"]);
const CONTENT_STATUSES = new Set(["draft", "scheduled", "published", "offline"]);
const EDITABLE_FIELDS = ["slug", "eventId", "type", "title", "summary", "bodyHtml", "status", "publishAt", "pinned", "sortOrder", "coverMediaId"];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function contentError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function asNow(now) {
  const value = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(value.getTime())) throw new TypeError("now must be a valid date");
  return value;
}

function normalizePublishAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw contentError(422, "发布时间必须是 ISO 8601 时间");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw contentError(422, "发布时间必须是 ISO 8601 时间");
  const date = new Date(parsed);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw contentError(422, "发布时间必须是 ISO 8601 时间");
  }
  return date.toISOString();
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw contentError(422, `${label}不能为空`);
  return text;
}

export function isPublicPost(post, now) {
  if (post?.status !== "published") return false;
  const publishAt = Date.parse(post.publishAt);
  const current = asNow(now).getTime();
  return Number.isFinite(publishAt) && publishAt <= current;
}

export function normalizeContentInput(input, current = null, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw contentError(422, "请求内容必须是 JSON 对象");
  }
  const timestamp = asNow(now);
  const isUpdate = current && typeof current === "object" && Object.keys(current).length > 0;
  if (isUpdate && input.version !== current.version) {
    throw contentError(409, "内容已被其他修改覆盖", "CONTENT_VERSION_CONFLICT");
  }

  const next = { ...(isUpdate ? current : {}) };
  for (const field of EDITABLE_FIELDS) {
    if (Object.hasOwn(input, field)) next[field] = input[field];
  }

  next.slug = requiredText(next.slug, "slug");
  if (!SLUG.test(next.slug)) throw contentError(422, "slug格式不合法");
  if (!CONTENT_TYPES.has(next.type)) throw contentError(422, "内容类型不合法");
  next.title = requiredText(next.title, "标题");
  if (!CONTENT_STATUSES.has(next.status)) throw contentError(422, "内容状态不合法");
  if (!Number.isInteger(next.sortOrder)) throw contentError(422, "排序必须是整数");

  next.publishAt = normalizePublishAt(next.publishAt);
  if (next.status === "scheduled") {
    if (!next.publishAt || Date.parse(next.publishAt) <= timestamp.getTime()) {
      throw contentError(422, "定时发布必须指定未来发布时间");
    }
  }
  if (next.status === "published" && !next.publishAt) next.publishAt = timestamp.toISOString();
  next.version = isUpdate ? current.version + 1 : 1;
  return next;
}
