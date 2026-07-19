import React, { useState } from "react";

function contentHref(item) {
  return item?.slug ? `/content/${encodeURIComponent(item.slug)}` : null;
}

function ContentCover({ item }) {
  const [failed, setFailed] = useState(false);
  const cover = item.cover;
  const label = item.title || "内容";

  if (!cover?.url || failed) {
    return (
      <div className="content-cover media-placeholder" role="img" aria-label={`${label}暂无封面`}>
        <span aria-hidden="true">✦</span>
      </div>
    );
  }

  return (
    <picture className="content-cover">
      {cover.mobileUrl ? <source media="(max-width: 767px)" srcSet={cover.mobileUrl} /> : null}
      {cover.desktopUrl ? <source srcSet={cover.desktopUrl} /> : null}
      <img src={cover.url} alt={`${label}封面`} loading="lazy" onError={() => setFailed(true)} />
    </picture>
  );
}

function publishYear(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? String(date.getFullYear()) : "往届";
}

export default function ContentSection({
  id,
  title,
  kicker,
  items = [],
  variant = "cards",
  moreHref,
  emptyText = "暂无公开内容"
}) {
  const headingId = `${id}-title`;
  return (
    <section className={`home-section content-section content-section-${variant}`} aria-labelledby={headingId}>
      <div className="section-heading">
        <div>
          <p className="section-kicker">{kicker}</p>
          <h2 id={headingId}>{title}</h2>
        </div>
        {moreHref && items.length ? <a className="text-link" href={moreHref}>查看全部<span aria-hidden="true"> →</span></a> : null}
      </div>

      {!items.length ? <p className="compact-empty">{emptyText}</p> : null}

      {items.length && variant === "announcements" ? (
        <ul className="announcement-list">
          {items.map((item) => {
            const href = contentHref(item);
            return (
              <li key={item.id || item.slug}>
                <span className="announcement-mark" aria-hidden="true">{item.pinned ? "置顶" : "公告"}</span>
                {href ? <a href={href}>{item.title}</a> : <span>{item.title}</span>}
                <time dateTime={item.publishAt || undefined}>{item.publishAt ? new Date(item.publishAt).toLocaleDateString("zh-CN") : ""}</time>
              </li>
            );
          })}
        </ul>
      ) : null}

      {items.length && variant === "cards" ? (
        <div className="content-card-grid">
          {items.map((item) => {
            const href = contentHref(item);
            return (
              <article className="content-card" key={item.id || item.slug}>
                <ContentCover item={item} />
                <div className="content-card-copy">
                  <h3>{href ? <a href={href}>{item.title}</a> : item.title}</h3>
                  {item.summary ? <p>{item.summary}</p> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {items.length && variant === "history" ? (
        <ul className="history-list">
          {items.map((item) => {
            const href = contentHref(item);
            return (
              <li key={item.id || item.slug}>
                <span className="history-year">{publishYear(item.publishAt)}</span>
                <div>
                  <h3>{href ? <a href={href}>{item.title}</a> : item.title}</h3>
                  {item.summary ? <p>{item.summary}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
