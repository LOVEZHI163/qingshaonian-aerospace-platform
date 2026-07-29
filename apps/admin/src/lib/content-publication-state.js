function issue(code, message) {
  return { code, message };
}

export function contentPublicationState({ content, event, profile }) {
  const blockingIssues = [];
  const warnings = [];
  if (!String(content?.title || "").trim()) blockingIssues.push(issue("title", "请填写标题"));
  if (!String(content?.slug || "").trim()) blockingIssues.push(issue("slug", "请填写公开地址"));
  if (!String(content?.bodyHtml || "").replace(/<[^>]*>/g, "").trim()) {
    blockingIssues.push(issue("body", "请填写正文"));
  }
  if (content?.eventId && (!event || event.status === "draft")) {
    blockingIssues.push(issue("event-draft", "归属赛事尚未发布"));
  } else if (event?.status === "archived") {
    warnings.push(issue("event-archived", "内容将显示在历届赛事范围"));
  } else if (event && profile?.isVisible !== true) {
    warnings.push(issue("event-hidden", "赛事官网入口仍处于隐藏状态"));
  }
  if (!String(content?.summary || "").trim()) warnings.push(issue("summary", "建议填写摘要"));
  if (!content?.coverMediaId) warnings.push(issue("cover", "建议上传封面"));
  return {
    blockingIssues,
    warnings,
    resultLabel: blockingIssues.length ? "暂不能公开" : "可以发布"
  };
}
