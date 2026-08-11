const messages = {
  IMPORT_URL_INVALID: "链接格式不正确，请粘贴完整的 http 或 https 地址。",
  IMPORT_URL_BLOCKED: "该地址不是可安全访问的公网网页，请更换公开文章链接。",
  IMPORT_FETCH_TIMEOUT: "网页读取超时，请稍后重试或检查原网页是否可访问。",
  IMPORT_RESPONSE_TOO_LARGE: "原网页内容过大，暂时无法转载。",
  IMPORT_UNSUPPORTED_CONTENT: "该链接不是可识别的网页文章。",
  IMPORT_ARTICLE_NOT_FOUND: "没有识别到文章正文，请确认链接指向具体文章。",
  IMPORT_RATE_LIMITED: "检查链接过于频繁，请一分钟后再试。",
  IMPORT_BATCH_NOT_FOUND: "转载任务不存在，请重新检查链接。",
  IMPORT_BATCH_EXPIRED: "转载任务已过期，请重新检查链接。",
  IMPORT_BATCH_STATE_CONFLICT: "转载任务已经处理，请返回内容列表查看。",
  IMPORT_STORAGE_CRITICAL: "服务器存储空间不足，请先清理空间后再转载。",
  IMPORT_IMAGE_NOT_FOUND: "图片不存在，请刷新转载任务。",
  IMPORT_IMAGE_FETCH_FAILED: "图片下载失败，可稍后重试。",
  IMPORT_IMAGE_TOO_LARGE: "图片文件过大，已跳过。",
  IMPORT_IMAGE_TOO_SMALL: "图片尺寸过小，已过滤。",
  IMPORT_IMAGE_UNSUPPORTED: "图片格式不支持，已跳过。",
  IMPORT_IMAGE_INVALID: "图片文件无效，已跳过。",
  IMPORT_IMAGE_SELECTION_INVALID: "所选正文图片不可用，请重新选择。",
  IMPORT_COVER_INVALID: "所选封面不可用，请重新选择。",
  IMPORT_DUPLICATE_SOURCE: "该链接已经转载过，可直接打开已有内容。"
};

export function contentImportError(error) {
  return messages[error?.code] || error?.message || "转载操作失败，请稍后重试。";
}
