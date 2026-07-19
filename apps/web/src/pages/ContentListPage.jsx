import React, { useEffect, useMemo, useRef, useState } from "react";

import { fetchJson } from "../api/client.js";
import AsyncState from "../components/AsyncState.jsx";
import { navigatePublicListPage, parsePublicListLocation, publicContentListPath } from "../router.js";

const labels = { announcement: "公告", news: "动态", work: "优秀作品", recap: "赛事回顾" };

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
            <span>{labels[row.type] || "公开内容"}{row.pinned ? " · 置顶" : ""}</span>
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
  const [selectedType, setSelectedType] = useState(newsMode ? "news" : "announcement");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: "loading", pages: {} });
  const tabRefs = useRef({});
  const query = useMemo(() => parsePublicListLocation(location), [location]);
  const types = newsMode ? ["news", "work"] : ["announcement"];

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setSelectedType(newsMode ? "news" : "announcement");
    setState({ status: "loading", pages: {} });

    Promise.all(types.map(async (type) => [
      type,
      await fetchJson(publicContentListPath(type, query.page, query.event), { signal: controller.signal })
    ]))
      .then((entries) => {
        if (!current) return;
        setState({ status: "success", pages: Object.fromEntries(entries) });
      })
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setState({ status: "error", pages: {} });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [attempt, newsMode, query.event, query.page]);

  function changePage(nextPage) {
    navigatePublicListPage(location, nextPage, query.event);
  }

  function activateTab(type, focus = false) {
    setSelectedType(type);
    if (focus) tabRefs.current[type]?.focus();
  }

  function handleTabKeyDown(event, type) {
    const index = types.indexOf(type);
    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % types.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + types.length) % types.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = types.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(types[nextIndex], true);
  }

  const heading = newsMode ? "动态与优秀作品" : "公告";

  return (
    <section className="content-page content-list-page" aria-labelledby="content-list-title">
      <div className="content-page-heading">
        <p className="section-kicker">官方发布</p>
        <h1 id="content-list-title">{heading}</h1>
        <p>{newsMode ? "了解赛事动态，浏览青少年优秀航空航天作品。" : "查看平台及赛事最新通知。"}</p>
      </div>

      {newsMode ? (
        <div className="content-tabs" role="tablist" aria-label="内容分类">
          {[["news", "动态"], ["work", "优秀作品"]].map(([type, label]) => (
            <button
              type="button"
              role="tab"
              id={`content-tab-${type}`}
              aria-controls={`content-panel-${type}`}
              aria-selected={selectedType === type}
              tabIndex={selectedType === type ? 0 : -1}
              key={type}
              ref={(node) => { tabRefs.current[type] = node; }}
              onClick={() => activateTab(type)}
              onKeyDown={(event) => handleTabKeyDown(event, type)}
            >{label}</button>
          ))}
        </div>
      ) : null}

      {types.map((type) => {
        const payload = state.pages[type];
        return (
          <div
            role="tabpanel"
            id={`content-panel-${type}`}
            aria-labelledby={`content-tab-${type}`}
            tabIndex={0}
            hidden={selectedType !== type}
            key={type}
          >
            <AsyncState status={state.status} onRetry={() => setAttempt((value) => value + 1)}>
              <ContentRows payload={payload} emptyText={newsMode && type === "work" ? "暂无公开优秀作品" : "暂无公开内容"} />
              <Pagination pagination={payload?.pagination} onPage={changePage} />
            </AsyncState>
          </div>
        );
      })}
    </section>
  );
}
