export const PUBLIC_CONTENT_TYPE_LABELS = Object.freeze({
  announcement: "通知公告",
  news: "新闻动态",
  recap: "赛事回顾",
  work: "优秀作品",
  guide: "参赛指南"
});

export function publicContentTypeLabel(type) {
  const normalizedType = typeof type === "string" ? type : "";
  return Object.hasOwn(PUBLIC_CONTENT_TYPE_LABELS, normalizedType)
    ? PUBLIC_CONTENT_TYPE_LABELS[normalizedType]
    : normalizedType;
}
