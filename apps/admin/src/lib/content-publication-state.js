import { sanitizedEditorPlainText } from "./rich-text.js";

function issue(code, message) {
  return { code, message };
}

export function contentPublicationState({ content, event, profile }) {
  const blockingIssues = [];
  const warnings = [];
  const bodyReady = Boolean(sanitizedEditorPlainText(content?.bodyHtml));
  if (!String(content?.title || "").trim()) blockingIssues.push(issue("title", "请填写标题"));
  if (!String(content?.slug || "").trim()) blockingIssues.push(issue("slug", "请填写公开地址"));
  if (!bodyReady) {
    blockingIssues.push(issue("body", "请填写正文"));
  }
  if (content?.eventId && (!event || event.status === "draft")) {
    blockingIssues.push(issue("event-draft", "归属赛事尚未发布"));
  } else if (event) {
    if (event.status === "archived") {
      warnings.push(issue("event-archived", "赛事已归档，公开入口按历届赛事规则处理"));
    }
    if (profile?.isVisible !== true) {
      warnings.push(issue(
        "event-hidden",
        event.status === "archived"
          ? "赛事官网隐藏；历届赛事入口及关联链接将隐藏，但内容不会因此变为私有"
          : "赛事官网隐藏；赛事入口及关联链接将隐藏，但内容不会因此变为私有"
      ));
    }
  }
  if (!String(content?.summary || "").trim()) warnings.push(issue("summary", "建议填写摘要"));
  if (!content?.coverMediaId) warnings.push(issue("cover", "建议上传封面"));

  const scheduled = content?.status === "scheduled";
  const attachmentCount = Array.isArray(content?.attachments) ? content.attachments.length : 0;
  const eventStatusLabel = !content?.eventId
    ? "平台通用"
    : ({ draft: "草稿", published: "已发布", archived: "已归档" }[event?.status] || "未知");
  const websiteStatusLabel = !content?.eventId
    ? "不适用"
    : profile?.isVisible === true ? "公开" : "隐藏";
  const publicationTiming = scheduled
    ? "最终确认后将在设定时间公开。"
    : "最终确认后将立即公开。";

  let publicOutcome = blockingIssues.length
    ? "校验通过前不会公开。"
    : publicationTiming;
  let publicEntry = "全站内容列表和直接地址";
  if (event && profile?.isVisible === true) {
    publicEntry = event.status === "archived"
      ? "全站内容列表、直接地址和历届赛事入口"
      : "全站内容列表、直接地址和赛事入口";
  } else if (event) {
    publicOutcome = blockingIssues.length
      ? publicOutcome
      : `${publicationTiming}发布后，全站内容列表和直接地址仍可访问。`;
    publicEntry = event.status === "archived"
      ? "历届赛事入口及关联链接隐藏"
      : "赛事入口及关联链接隐藏";
  }

  return {
    blockingIssues,
    warnings,
    resultLabel: blockingIssues.length ? "暂不能公开" : "可以发布",
    bodyReady,
    bodyReadinessLabel: bodyReady ? "正文已就绪" : "正文未就绪",
    mediaReadinessLabel: `${content?.coverMediaId ? "封面已就绪" : "未设置封面"}，${attachmentCount} 个附件`,
    placementLabel: `${content?.pinned ? "置顶" : "不置顶"}，排序 ${Number(content?.sortOrder || 0)}`,
    publicationModeLabel: scheduled ? "定时发布" : "立即发布",
    intendedPublishAt: scheduled ? (content?.publishAt || null) : null,
    eventStatusLabel,
    websiteStatusLabel,
    publicOutcome,
    publicEntry
  };
}
