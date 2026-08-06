import React from "react";
import EventStatus from "./EventStatus.jsx";

export default function ConcurrentEvents({ events = [], featuredEventId }) {
  const seen = new Set();
  const rows = events.filter((event) => {
    if (!event?.id || event.id === featuredEventId || seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  }).slice(0, 2);

  if (!rows.length) return null;

  return (
    <section className="home-section concurrent-events" aria-labelledby="concurrent-events-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">同步启航</p>
          <h2 id="concurrent-events-title">同期赛事</h2>
        </div>
        <p>选择适合的赛事查看安排与报名状态</p>
      </div>
      <div className="concurrent-event-grid">
        {rows.map((event) => (
          <article className="concurrent-event-card" key={event.id}>
            <div className="concurrent-card-topline">
              <EventStatus event={event} mode="active" />
              <span>{event.dateLabel}</span>
            </div>
            <h3>{event.name}</h3>
            {event.theme ? <p className="concurrent-event-theme">{event.theme}</p> : null}
            {event.venue ? <p className="concurrent-event-venue"><span aria-hidden="true">⌖</span>{event.venue}</p> : null}
            {event.slug ? (
              <a className="text-link" href={`/events/${encodeURIComponent(event.slug)}`}>查看赛事详情<span aria-hidden="true"> →</span></a>
            ) : <span className="muted-note">赛事详情待发布</span>}
          </article>
        ))}
      </div>
    </section>
  );
}
