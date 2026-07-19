import React, { useEffect, useRef, useState } from "react";

import { fetchJson } from "../api/client.js";
import AsyncState from "../components/AsyncState.jsx";

const PAGE_SIZE = 10;
const labels = { announcement: "公告", news: "动态", work: "优秀作品", recap: "赛事回顾" };

function listUrl(type, page) {
  return `/api/public/content?type=${type}&page=${page}&pageSize=${PAGE_SIZE}`;
}

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

export default function ContentListPage({ mode = "announcements" }) {
  const newsMode = mode === "news";
  const [selectedType, setSelectedType] = useState(newsMode ? "news" : "announcement");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: "loading", pages: {} });
  const controllers = useRef(new Set());

  useEffect(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    let current = true;
    setSelectedType(newsMode ? "news" : "announcement");
    setState({ status: "loading", pages: {} });
    const types = newsMode ? ["news", "work"] : ["announcement"];

    Promise.all(types.map(async (type) => [type, await fetchJson(listUrl(type, 1), { signal: controller.signal })]))
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
      controllers.current.delete(controller);
    };
  }, [attempt, newsMode]);

  useEffect(() => () => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  }, []);

  async function changePage(nextPage) {
    const controller = new AbortController();
    controllers.current.add(controller);
    setState((current) => ({ ...current, status: "loading" }));
    try {
      const payload = await fetchJson(listUrl(selectedType, nextPage), { signal: controller.signal });
      if (!controller.signal.aborted) {
        setState((current) => ({
          status: "success",
          pages: { ...current.pages, [selectedType]: payload }
        }));
      }
    } catch (error) {
      if (error?.name !== "AbortError" && !controller.signal.aborted) {
        setState((current) => ({ ...current, status: "error" }));
      }
    } finally {
      controllers.current.delete(controller);
    }
  }

  const payload = state.pages[selectedType];
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
              aria-selected={selectedType === type}
              tabIndex={selectedType === type ? 0 : -1}
              key={type}
              onClick={() => setSelectedType(type)}
            >{label}</button>
          ))}
        </div>
      ) : null}

      <AsyncState status={state.status} onRetry={() => setAttempt((value) => value + 1)}>
        <ContentRows payload={payload} emptyText={newsMode && selectedType === "work" ? "暂无公开优秀作品" : "暂无公开内容"} />
        <Pagination pagination={payload?.pagination} onPage={changePage} />
      </AsyncState>
    </section>
  );
}
