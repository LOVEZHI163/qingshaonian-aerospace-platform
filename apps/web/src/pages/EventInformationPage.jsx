import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../api/client.js";
import { EventPicture } from "../components/FeaturedEvent.jsx";
import Seo from "../components/Seo.jsx";
import { buildPublicEventContent } from "../lib/public-event-content.js";
import { eventScopedPath, publicEventOptions, selectedPublicEvent } from "../lib/public-navigation.js";

export default function EventInformationPage({ section, homeData, homeStatus, location }) {
  const event = selectedPublicEvent(homeData, location);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [detailState, setDetailState] = useState({ slug: null, status: "idle", data: null });

  useEffect(() => {
    if (!event?.slug) return undefined;
    const controller = new AbortController();
    let current = true;
    setDetailState({ slug: event.slug, status: "loading", data: null });
    fetchJson(`/api/public/events/${encodeURIComponent(event.slug)}`, { signal: controller.signal })
      .then((data) => {
        if (current) setDetailState({ slug: event.slug, status: "success", data });
      })
      .catch((error) => {
        if (current && error?.name !== "AbortError") {
          setDetailState({ slug: event.slug, status: "error", data: null });
        }
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [detailAttempt, event?.slug]);

  const detailIsCurrent = detailState.slug === event?.slug;
  const detail = detailIsCurrent ? detailState.data : null;
  const detailStatus = detailIsCurrent ? detailState.status : "idle";
  const model = useMemo(
    () => buildPublicEventContent(section, { event, detail, site: homeData?.site }),
    [section, event, detail, homeData?.site]
  );
  const options = publicEventOptions(homeData);

  return (
    <section className="event-information-page" aria-labelledby="event-information-title">
      <Seo title={model.title} description={model.lead} pathname={new URL(location, window.location.origin).pathname} />
      <header className="event-information-hero">
        {event?.hero?.url ? (
          <EventPicture
            event={event}
            className="event-information-hero-media"
            decorative
            testId="event-information-hero-media"
          />
        ) : null}
        <div className="event-information-hero-copy">
          <p>{model.eyebrow}</p>
          <h1 id="event-information-title">{model.title}</h1>
          <p>{model.lead}</p>
        </div>
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
      {model.document ? (
        <section className="event-information-document" aria-labelledby="event-information-document-title">
          <header className="event-information-document-header">
            <div>
              <p className="event-information-document-eyebrow">官方文件</p>
              <h2 id="event-information-document-title">章程原文</h2>
              <p>{model.document.title}</p>
            </div>
            <div className="event-information-document-actions">
              <a href={model.document.downloadUrl} download={model.document.downloadName}>下载章程原文件</a>
            </div>
          </header>
          <div className="event-information-document-body">
            {(model.document.chapters || []).map((chapter) => (
              <article className="event-information-document-chapter" key={chapter.heading}>
                <h3>{chapter.heading}</h3>
                {chapter.items?.length ? (
                  <ul>{chapter.items.map((item) => <li key={item}>{item}</li>)}</ul>
                ) : null}
                {(chapter.paragraphs || []).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                {chapter.signature?.length ? (
                  <div className="event-information-document-signature">
                    {chapter.signature.map((line) => <p key={line}>{line}</p>)}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {homeStatus === "loading" || (detailStatus === "loading" && section === "projects") ? (
        <p role="status">正在加载赛事信息…</p>
      ) : null}
      {detailStatus === "error" ? (
        <div className="event-information-error" role="alert">
          <p>暂时无法加载赛事详情，请稍后重试。</p>
          <button type="button" onClick={() => setDetailAttempt((value) => value + 1)}>重新加载</button>
        </div>
      ) : null}
      <div className="event-information-sections">
        {model.sections.map((item) => (
          <article
            key={item.heading}
            className={[
              item.wide ? "event-information-section-wide" : "",
              item.steps?.length ? "event-information-process" : ""
            ].filter(Boolean).join(" ") || undefined}
            role={item.steps?.length ? "region" : undefined}
            aria-label={item.steps?.length ? item.heading : undefined}
          >
            <h2>{item.heading}</h2>
            {(item.paragraphs || []).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {item.steps?.length ? (
              <ol className="event-information-process-list">
                {item.steps.map((step, index) => (
                  <li key={step.title}>
                    <span aria-hidden="true">{index + 1}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
            {item.contact ? (
              <div className="event-information-contact">
                {item.contact.name ? <p>联系人：{item.contact.name}</p> : null}
                {item.contact.phones.length ? (
                  <p>
                    联系电话：
                    {item.contact.phones.map((phone, index) => (
                      <React.Fragment key={phone.href}>
                        {index ? " / " : ""}
                        <a href={phone.href}>{phone.label}</a>
                      </React.Fragment>
                    ))}
                  </p>
                ) : null}
              </div>
            ) : null}
            {item.items?.length ? <ul>{item.items.map((row) => <li key={row.id}>{row.name}</li>)}</ul> : null}
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
