import React, { useEffect, useMemo, useState } from "react";

import { fetchJson } from "../api/client.js";
import AsyncState from "../components/AsyncState.jsx";
import Seo from "../components/Seo.jsx";
import { navigatePublicListPage, parsePublicListLocation, publicContentListPath } from "../router.js";

function uniqueEvents(bootstrap) {
  const candidates = bootstrap?.mode === "history"
    ? [bootstrap.featuredEvent, ...(bootstrap.concurrentEvents || [])]
    : [];
  const seen = new Set();
  return candidates.filter((event) => {
    if (!event?.id || seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

export default function HistoryPage({ bootstrap, location = window.location.href }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: "loading", data: null });
  const query = useMemo(() => parsePublicListLocation(location), [location]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: "loading", data: null });
    fetchJson(publicContentListPath("recap", query.page, query.event), { signal: controller.signal })
      .then((data) => current && setState({ status: "success", data }))
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setState({ status: "error", data: null });
      });
    return () => { current = false; controller.abort(); };
  }, [attempt, query.event, query.page]);

  const events = uniqueEvents(bootstrap);
  const recaps = Array.isArray(state.data?.rows) ? state.data.rows : [];

  return (
    <section className="content-page history-page" aria-labelledby="history-title">
      <Seo title="历届赛事" description="回顾赛事历程、新闻记录和优秀成果。" pathname="/history" />
      <div className="content-page-heading">
        <p className="section-kicker">逐年回顾</p>
        <h1 id="history-title">历届赛事</h1>
        <p>回顾赛事历程、新闻记录和优秀成果。</p>
      </div>

      {events.length ? (
        <section aria-labelledby="history-event-title">
          <h2 id="history-event-title">公开历史赛事</h2>
          <div className="history-event-grid">
            {events.map((event) => (
              <article key={event.id}>
                <span>{event.dateLabel || "往届赛事"}</span>
                <h3>{event.slug ? <a href={`/events/${encodeURIComponent(event.slug)}`}>{event.name}</a> : event.name}</h3>
                {event.summary ? <p>{event.summary}</p> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="history-recaps" aria-labelledby="history-recap-title">
        <h2 id="history-recap-title">赛事回顾</h2>
        <AsyncState status={state.status} onRetry={() => setAttempt((value) => value + 1)}>
          {!recaps.length ? <p className="content-empty">暂无公开回顾</p> : (
            <div className="public-content-list">
              {recaps.map((row) => (
                <article key={row.id || row.slug}>
                  <div><span>赛事回顾</span>{row.publishAt ? <time dateTime={row.publishAt}>{new Date(row.publishAt).getFullYear()}</time> : null}</div>
                  <h3>{row.slug ? <a href={`/content/${encodeURIComponent(row.slug)}`}>{row.title}</a> : row.title}</h3>
                  {row.summary ? <p>{row.summary}</p> : null}
                  {row.eventSlug ? <a className="content-event-link" href={`/events/${encodeURIComponent(row.eventSlug)}`}>查看关联赛事</a> : null}
                </article>
              ))}
            </div>
          )}
          {state.data?.pagination?.totalPages > 1 ? (
            <nav className="pagination" aria-label="赛事回顾分页">
              <button type="button" disabled={state.data.pagination.page <= 1} onClick={() => navigatePublicListPage(location, state.data.pagination.page - 1, query.event)}>上一页</button>
              <span>第 {state.data.pagination.page} / {state.data.pagination.totalPages} 页</span>
              <button type="button" disabled={state.data.pagination.page >= state.data.pagination.totalPages} onClick={() => navigatePublicListPage(location, state.data.pagination.page + 1, query.event)}>下一页</button>
            </nav>
          ) : null}
        </AsyncState>
      </section>
    </section>
  );
}
