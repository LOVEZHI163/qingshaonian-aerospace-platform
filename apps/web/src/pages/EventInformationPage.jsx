import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../api/client.js";
import Seo from "../components/Seo.jsx";
import { buildPublicEventContent } from "../lib/public-event-content.js";
import { eventScopedPath, publicEventOptions, selectedPublicEvent } from "../lib/public-navigation.js";

export default function EventInformationPage({ section, homeData, homeStatus, location }) {
  const event = selectedPublicEvent(homeData, location);
  const [detailState, setDetailState] = useState({ slug: null, status: "idle", data: null });

  useEffect(() => {
    if (!event?.slug) return undefined;
    const controller = new AbortController();
    setDetailState({ slug: event.slug, status: "loading", data: null });
    fetchJson(`/api/public/events/${encodeURIComponent(event.slug)}`, { signal: controller.signal })
      .then((data) => setDetailState({ slug: event.slug, status: "success", data }))
      .catch((error) => {
        if (error?.name !== "AbortError") setDetailState({ slug: event.slug, status: "error", data: null });
      });
    return () => controller.abort();
  }, [event?.slug]);

  const detail = detailState.slug === event?.slug ? detailState.data : null;
  const model = useMemo(
    () => buildPublicEventContent(section, { event, detail, site: homeData?.site }),
    [section, event, detail, homeData?.site]
  );
  const options = publicEventOptions(homeData);

  return (
    <section className="event-information-page" aria-labelledby="event-information-title">
      <Seo title={model.title} description={model.lead} pathname={new URL(location, window.location.origin).pathname} />
      <header className="event-information-hero">
        <p>{model.eyebrow}</p>
        <h1 id="event-information-title">{model.title}</h1>
        <p>{model.lead}</p>
      </header>
      {options.length > 1 ? (
        <nav className="event-information-switcher" aria-label="切换公开赛事">
          {options.map((row) => (
            <a
              key={row.id}
              href={eventScopedPath(new URL(location, window.location.origin).pathname, row)}
              aria-current={row.id === event?.id ? "page" : undefined}
            >
              {row.name}
            </a>
          ))}
        </nav>
      ) : null}
      {model.facts.length ? (
        <dl className="event-information-facts">
          {model.facts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : null}
      {homeStatus === "loading" || (detailState.status === "loading" && section === "projects") ? (
        <p role="status">正在加载赛事信息…</p>
      ) : null}
      <div className="event-information-sections">
        {model.sections.map((item) => (
          <article key={item.heading}>
            <h2>{item.heading}</h2>
            {(item.paragraphs || []).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {item.items ? <ul>{item.items.map((row) => <li key={row.id}>{row.name}</li>)}</ul> : null}
          </article>
        ))}
      </div>
      <div className="event-information-actions">
        {model.actions.map((action) => (
          <a
            key={action.label}
            href={action.href}
            data-router-ignore={action.externalRouter || undefined}
          >
            {action.label}
          </a>
        ))}
      </div>
    </section>
  );
}
