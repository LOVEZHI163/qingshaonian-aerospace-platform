export const CONTENT_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: "announcement", label: "通知公告" }),
  Object.freeze({ value: "news", label: "新闻动态" }),
  Object.freeze({ value: "work", label: "优秀作品" }),
  Object.freeze({ value: "recap", label: "赛事回顾" }),
  Object.freeze({ value: "guide", label: "参赛指南" })
]);

export const CONTENT_TYPE_LABELS = Object.freeze(Object.fromEntries(
  CONTENT_TYPE_OPTIONS.map(({ value, label }) => [value, label])
));

export function contentTypeLabel(type, emptyFallback = "未填写") {
  if (type == null || type === "") return emptyFallback;
  const value = String(type);
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPE_LABELS, value)
    ? CONTENT_TYPE_LABELS[value]
    : value;
}
