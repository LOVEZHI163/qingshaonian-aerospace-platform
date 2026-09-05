import React, { useEffect, useMemo, useState } from "react";

import { fetchJson } from "../api/client.js";
import AsyncState from "../components/AsyncState.jsx";
import Seo from "../components/Seo.jsx";
import {
  navigateHistoryEventsPage,
  navigatePublicListPage,
  parsePublicListLocation,
  publicContentListPath,
  publicHistoryEventsPath
} from "../router.js";

export default function HistoryPage({ location = window.location.href }) {
  const [attempt, setAttempt] = useState(0);
  const [eventState, setEventState] = useState({ status: "loading", data: null });
  const [recapState, setRecapState] = useState({ status: "loading", data: null });
  const query = useMemo(() => parsePublicListLocation(location), [location]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setEventState({ status: "loading", data: null });
    fetchJson(publicHistoryEventsPath(query.eventsPage), { signal: controller.signal })
      .then((data) => current && setEventState({ status: "success", data }))
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setEventState({ status: "error", data: null });
      });
    return () => { current = false; controller.abort(); };
  }, [attempt, query.eventsPage]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setRecapState({ status: "loading", data: null });
    fetchJson(publicContentListPath("recap", query.page, query.event), { signal: controller.signal })
      .then((data) => current && setRecapState({ status: "success", data }))
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setRecapState({ status: "error", data: null });
      });
    return () => { current = false; controller.abort(); };
  }, [attempt, query.event, query.page]);

  const events = Array.isArray(eventState.data?.rows) ? eventState.data.rows : [];
  const recaps = Array.isArray(recapState.data?.rows) ? recapState.data.rows : [];

  return (
    <section className="content-page history-page" aria-labelledby="history-title">
      <Seo title="历届赛事" description="回顾赛事历程、新闻记录和优秀成果。" pathname="/history" />
      <div className="content-page-heading">
        <p className="section-kicker">逐年回顾</p>
        <h1 id="history-title">历届赛事</h1>
        <p>回顾赛事历程、新闻记录和优秀成果。</p>
      </div>

      <section aria-labelledby="history-event-title">
          <h2 id="history-event-title">公开历史赛事</h2>
          <AsyncState status={eventState.status} onRetry={() => setAttempt((value) => value + 1)}>
            {!events.length ? <p className="content-empty">暂无公开历史赛事</p> : (
              <div className="history-event-grid">
                {events.map((event) => (
                  <article key={event.id}>
                    <span>{event.dateLabel || "往届赛事"}</span>
                    <h3>{event.slug ? <a href={`/events/${encodeURIComponent(event.slug)}`}>{event.name}</a> : event.name}</h3>
                    {event.summary ? <p>{event.summary}</p> : null}
                  </article>
                ))}
              </div>
            )}
            {eventState.data?.pagination?.totalPages > 1 ? (
              <nav className="pagination" aria-label="历史赛事分页">
                <button type="button" aria-label="上一页历史赛事" disabled={eventState.data.pagination.page <= 1} onClick={() => navigateHistoryEventsPage(location, eventState.data.pagination.page - 1)}>上一页</button>
                <span>第 {eventState.data.pagination.page} / {eventState.data.pagination.totalPages} 页</span>
                <button type="button" aria-label="下一页历史赛事" disabled={eventState.data.pagination.page >= eventState.data.pagination.totalPages} onClick={() => navigateHistoryEventsPage(location, eventState.data.pagination.page + 1)}>下一页</button>
              </nav>
            ) : null}
          </AsyncState>
      </section>

      <section className="history-recaps" aria-labelledby="history-recap-title">
        <h2 id="history-recap-title">赛事回顾</h2>
        <AsyncState status={recapState.status} onRetry={() => setAttempt((value) => value + 1)}>
          {!recaps.length ? <p className="content-empty">暂无公开回顾</p> : (
            <div className="public-content-list">
              {recaps.map((row) => (
                <article key={row.id || row.slug}>
                  <div><span>赛事回顾</span></div>
                  <h3>{row.slug ? <a href={`/content/${encodeURIComponent(row.slug)}`}>{row.title}</a> : row.title}</h3>
                  {row.summary ? <p>{row.summary}</p> : null}
                  {row.eventSlug ? <a className="content-event-link" href={`/events/${encodeURIComponent(row.eventSlug)}`}>查看关联赛事</a> : null}
                </article>
              ))}
            </div>
          )}
          {recapState.data?.pagination?.totalPages > 1 ? (
            <nav className="pagination" aria-label="赛事回顾分页">
              <button type="button" disabled={recapState.data.pagination.page <= 1} onClick={() => navigatePublicListPage(location, recapState.data.pagination.page - 1, query.event)}>上一页</button>
              <span>第 {recapState.data.pagination.page} / {recapState.data.pagination.totalPages} 页</span>
              <button type="button" disabled={recapState.data.pagination.page >= recapState.data.pagination.totalPages} onClick={() => navigatePublicListPage(location, recapState.data.pagination.page + 1, query.event)}>下一页</button>
            </nav>
          ) : null}
        </AsyncState>
      </section>
    </section>
  );
}
