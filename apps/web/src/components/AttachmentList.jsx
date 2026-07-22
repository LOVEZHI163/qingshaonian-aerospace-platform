import React from "react";

const ADMIN_PREVIEW_MEDIA = /^\/api\/admin\/site-media\/[^/]+\/preview$/;

function safeMediaHref(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, window.location.origin);
    const allowedPath = url.pathname.startsWith("/api/public/media/")
      || ADMIN_PREVIEW_MEDIA.test(url.pathname);
    if (url.origin !== window.location.origin || !allowedPath) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
function formatSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatType(mimeType) {
  if (mimeType === "application/pdf") return "PDF 文档";
  if (mimeType === "image/png") return "PNG 图片";
  if (mimeType === "image/jpeg") return "JPEG 图片";
  if (mimeType === "image/webp") return "WebP 图片";
  return "附件";
}

export default function AttachmentList({ attachments = [], title = "附件下载" }) {
  const rows = attachments
    .map((attachment) => ({ attachment, href: safeMediaHref(attachment?.url) }))
    .filter((row) => row.href);

  if (!rows.length) return null;

  return (
    <section className="attachment-section" aria-labelledby="attachment-title">
      <h2 id="attachment-title">{title}</h2>
      <ul className="attachment-list">
        {rows.map(({ attachment, href }) => {
          const label = attachment.label || attachment.name || "下载附件";
          return (
            <li key={`${attachment.id || href}:${attachment.displayOrder || 0}`}>
              <div>
                <strong>{label}</strong>
                <span>
                  {formatType(attachment.mimeType)} · {formatSize(attachment.sizeBytes)}
                  {href.startsWith("/api/admin/site-media/") ? " · 草稿附件需保持管理后台登录状态" : null}
                </span>
              </div>
              <a href={href} download={attachment.name || undefined} data-router-ignore="true">
                下载<span className="visually-hidden">{label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
