import React, { useState } from "react";

function isProtectedPreviewMedia(url) {
  return /^\/api\/admin\/site-media\/[^/?#]+\/preview(?:[?#]|$)/.test(String(url || ""));
}

export function EventPicture({ event, className = "", decorative = false, testId }) {
  const [failedUrl, setFailedUrl] = useState("");
  const hero = event?.hero;
  const label = event?.name || "赛事";
  const failed = Boolean(hero?.url) && failedUrl === hero.url;
  const needsLogin = failed && isProtectedPreviewMedia(hero.url);

  if ((!hero?.url || failed) && decorative) return null;

  if (!hero?.url || failed) {
    return (
      <div
        className={`media-placeholder ${className}`.trim()}
        role="img"
        aria-label={`${label}${needsLogin ? "预览资源需要重新登录" : "暂无封面"}`}
      >
        <span aria-hidden="true">✦</span>
        {needsLogin ? <span className="media-placeholder-message">预览资源需要重新登录</span> : null}
      </div>
    );
  }

  return (
    <picture className={className} aria-hidden={decorative ? "true" : undefined} data-testid={testId}>
      {hero.mobileUrl ? <source media="(max-width: 767px)" srcSet={hero.mobileUrl} /> : null}
      {hero.desktopUrl ? <source srcSet={hero.desktopUrl} /> : null}
      <img
        src={hero.url}
        alt={decorative ? "" : `${label}赛事封面`}
        fetchPriority="high"
        onError={() => setFailedUrl(hero.url)}
      />
    </picture>
  );
}

export default function FeaturedEvent({ event }) {
  if (!event) {
    return (
      <section id="events" className="featured-event featured-event-empty" aria-labelledby="featured-empty-title">
        <div className="featured-empty-art" aria-hidden="true">✦</div>
        <div className="featured-event-copy">
          <p className="section-kicker">赛事回顾</p>
          <h2 id="featured-empty-title">期待下一次航空航天创意启航</h2>
          <p>当前暂无公开赛事，欢迎查看往届精彩内容。</p>
          <a className="button button-primary" href="/history">查看历届赛事</a>
        </div>
      </section>
    );
  }

  return (
    <section id="events" className="featured-event" aria-label={`${event.name}赛事海报`}>
      <div className="featured-event-poster">
        <EventPicture event={event} className="featured-event-media" />
      </div>
    </section>
  );
}
