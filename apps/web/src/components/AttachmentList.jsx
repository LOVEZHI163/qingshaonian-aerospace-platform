import React from "react";

function publicMediaHref(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/public/media/")) return null;
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
    .map((attachment) => ({ attachment, href: publicMediaHref(attachment?.url) }))
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
                <span>{formatType(attachment.mimeType)} · {formatSize(attachment.sizeBytes)}</span>
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

