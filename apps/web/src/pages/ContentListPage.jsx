import React, { useEffect, useMemo, useState } from "react";

import { fetchJson } from "../api/client.js";
import AsyncState from "../components/AsyncState.jsx";
import Seo from "../components/Seo.jsx";
import { PUBLIC_CONTENT_TYPE_LABELS, publicContentTypeLabel } from "../lib/public-content-labels.js";
import { navigatePublicListPage, parsePublicListLocation, publicContentListPath } from "../router.js";

function dateLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN") : "";
}

function ContentRows({ payload, emptyText }) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!rows.length) return <p className="content-empty">{emptyText}</p>;
  return (
    <div className="public-content-list">
      {rows.map((row) => (
        <article key={row.id || row.slug}>
          <div>
            <span>{publicContentTypeLabel(row.type) || "公开内容"}{row.pinned ? " · 置顶" : ""}</span>
            {row.publishAt ? <time dateTime={row.publishAt}>{dateLabel(row.publishAt)}</time> : null}
          </div>
          <h2>{row.slug ? <a href={`/content/${encodeURIComponent(row.slug)}`}>{row.title}</a> : row.title}</h2>
          {row.summary ? <p>{row.summary}</p> : null}
          {row.eventSlug ? <a className="content-event-link" href={`/events/${encodeURIComponent(row.eventSlug)}`}>查看关联赛事</a> : null}
        </article>
      ))}
    </div>
  );
}

function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label="内容分页">
      <button type="button" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>上一页</button>
      <span>第 {pagination.page} / {pagination.totalPages} 页</span>
      <button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => onPage(pagination.page + 1)}>下一页</button>
    </nav>
  );
}

export default function ContentListPage({ mode = "announcements", location = window.location.href }) {
  const newsMode = mode === "news";
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: "loading", pages: {} });
  const query = useMemo(() => parsePublicListLocation(location), [location]);
  const contentType = newsMode ? "news" : "announcement";

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: "loading", pages: {} });

    fetchJson(publicContentListPath(contentType, query.page, query.event), { signal: controller.signal })
      .then((payload) => {
        if (!current) return;
        setState({ status: "success", pages: { [contentType]: payload } });
      })
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setState({ status: "error", pages: {} });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [attempt, contentType, query.event, query.page]);

  function changePage(nextPage) {
    navigatePublicListPage(location, nextPage, query.event, newsMode ? "news" : null);
  }

  const heading = newsMode ? PUBLIC_CONTENT_TYPE_LABELS.news : PUBLIC_CONTENT_TYPE_LABELS.announcement;

  return (
    <section className="content-page content-list-page" aria-labelledby="content-list-title">
      <Seo
        title={heading}
        description={newsMode ? "了解平台及赛事最新新闻动态。" : "查看平台及赛事最新通知。"}
        pathname={newsMode ? "/news" : "/announcements"}
      />
      <div className="content-page-heading">
        <p className="section-kicker">官方发布</p>
        <h1 id="content-list-title">{heading}</h1>
        <p>{newsMode ? "了解平台及赛事最新新闻动态。" : "查看平台及赛事最新通知。"}</p>
      </div>

      <div className="content-list-body">
        <AsyncState status={state.status} onRetry={() => setAttempt((value) => value + 1)}>
          <ContentRows payload={state.pages[contentType]} emptyText="暂无公开内容" />
          <Pagination pagination={state.pages[contentType]?.pagination} onPage={changePage} />
        </AsyncState>
      </div>
    </section>
  );
}
