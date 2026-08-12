import React, { useState } from "react";
import EventStatus from "./EventStatus.jsx";

function isProtectedPreviewMedia(url) {
  return /^\/api\/admin\/site-media\/[^/?#]+\/preview(?:[?#]|$)/.test(String(url || ""));
}

export function EventPicture({ event, className = "" }) {
  const [failedUrl, setFailedUrl] = useState("");
  const hero = event?.hero;
  const label = event?.name || "赛事";
  const failed = Boolean(hero?.url) && failedUrl === hero.url;
  const needsLogin = failed && isProtectedPreviewMedia(hero.url);

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
    <picture className={className}>
      {hero.mobileUrl ? <source media="(max-width: 767px)" srcSet={hero.mobileUrl} /> : null}
      {hero.desktopUrl ? <source srcSet={hero.desktopUrl} /> : null}
      <img
        src={hero.url}
        alt={`${label}赛事封面`}
        fetchPriority="high"
        onError={() => setFailedUrl(hero.url)}
      />
    </picture>
  );
}

function eventDetailHref(event) {
  return event?.slug ? `/events/${encodeURIComponent(event.slug)}` : "/history";
}

export default function FeaturedEvent({ event, mode = "active" }) {
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

  const canRegister = mode === "active" && event.registrationWindow?.open && event.id;
  const primaryHref = canRegister
    ? `/admin/?view=registration&eventId=${encodeURIComponent(event.id)}`
    : eventDetailHref(event);
  const primaryLabel = canRegister
    ? "立即报名"
    : mode === "history" ? "查看赛事回顾" : "查看赛事安排";

  return (
    <section id="events" className="featured-event" aria-labelledby="featured-event-title">
      <div
        className="featured-event-poster"
        role="group"
        aria-label={`${event.name}赛事操作`}
        tabIndex={0}
      >
        <EventPicture event={event} className="featured-event-media" />
        <div className="featured-event-interaction" data-testid="featured-event-mobile-copy">
          <div className="featured-event-copy">
            <div className="featured-event-meta-row">
              <p className="section-kicker">{mode === "history" ? "往届精选" : "重点赛事"}</p>
              <EventStatus event={event} mode={mode} />
            </div>
            <h2 id="featured-event-title">{event.name}</h2>
            {event.theme ? <p className="featured-event-theme">{event.theme}</p> : null}
            {event.slogan ? <p className="featured-event-slogan">{event.slogan}</p> : null}
            <dl className="event-facts">
              {event.dateLabel ? <div><dt>比赛时间</dt><dd>{event.dateLabel}</dd></div> : null}
              {event.venue ? <div><dt>比赛地点</dt><dd>{event.venue}</dd></div> : null}
            </dl>
            <div className="featured-event-actions">
              <a
                className="button button-primary"
                href={primaryHref}
                data-router-ignore={canRegister ? "true" : undefined}
              >
                {primaryLabel}
              </a>
              {event.slug && canRegister ? (
                <a className="button button-secondary" href={eventDetailHref(event)}>了解赛事</a>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
