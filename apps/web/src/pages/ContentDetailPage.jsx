import React, { useEffect, useRef, useState } from "react";

import { fetchJson } from "../api/client.js";
import AsyncState from "../components/AsyncState.jsx";
import AttachmentList from "../components/AttachmentList.jsx";
import Seo from "../components/Seo.jsx";
import { enhanceBilibiliVideos } from "../lib/bilibili-video.js";

const DEFAULT_CONTENT_DESCRIPTION = "查看通知公告与新闻动态详情。";

function ContentNotFound() {
  return (
    <>
      <Seo title="内容不存在" description="该内容可能尚未发布或已经停止展示。" />
      <section className="resource-state" aria-labelledby="content-not-found-title">
        <p>404</p>
        <h1 id="content-not-found-title">内容不存在</h1>
        <p>该内容可能尚未发布或已经停止展示。</p>
        <a className="button button-solid" href="/news">返回内容列表</a>
      </section>
    </>
  );
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "";
}

export function ContentDetailView({ row, preview = false, canonicalPath = null }) {
  const bodyRef = useRef(null);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    for (const anchor of root.querySelectorAll("a[href]")) {
      try {
        const url = new URL(anchor.getAttribute("href"), window.location.href);
        if (url.origin !== window.location.origin) {
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
        } else {
          anchor.removeAttribute("target");
        }
      } catch {
        anchor.removeAttribute("href");
      }
    }
    for (const image of root.querySelectorAll("img")) {
      if (!image.hasAttribute("alt")) image.alt = "正文图片";
      image.loading = "lazy";
    }
    enhanceBilibiliVideos(root);
  }, [row?.bodyHtml]);

  return (
    <article className="content-page content-detail-page">
      <Seo
        title={row?.title || "内容详情"}
        description={row?.summary || DEFAULT_CONTENT_DESCRIPTION}
        {...(!preview ? { pathname: canonicalPath || `/content/${encodeURIComponent(row?.slug || "")}` } : {})}
        image={row?.cover}
        type="article"
        robots={preview ? "noindex, nofollow" : null}
        canonical={!preview}
      />
      {row ? (
        <>
          <header className="content-detail-heading">
            <p className="section-kicker">官方内容</p>
            <h1>{row.title}</h1>
            {row.summary ? <p>{row.summary}</p> : null}
            <div className="content-detail-meta">
              {row.publishAt ? <time dateTime={row.publishAt}>发布时间：{formatDate(row.publishAt)}</time> : null}
              {row.eventSlug ? <a href={`/events/${encodeURIComponent(row.eventSlug)}`}>查看关联赛事</a> : null}
            </div>
          </header>
          {row.source ? (
            <aside className="content-source" aria-label="转载来源">
              <div>
                <strong>来源：{row.source.name || "原发布平台"}</strong>
                {row.source.author ? <span>作者：{row.source.author}</span> : null}
                {row.source.publishedAt ? <time dateTime={row.source.publishedAt}>原文发布时间：{formatDate(row.source.publishedAt)}</time> : null}
              </div>
              <a href={row.source.url} target="_blank" rel="noopener noreferrer">查看原文</a>
              <p>本文转载自“{row.source.name || "原发布平台"}”，版权归原作者及原平台所有；如有侵权请联系删除。</p>
            </aside>
          ) : null}
          <div
            ref={bodyRef}
            className="rich-content"
            dangerouslySetInnerHTML={{ __html: row.bodyHtml || "" }}
          />
          <AttachmentList attachments={row.attachments || []} />
        </>
      ) : null}
    </article>
  );
}

export default function ContentDetailPage({ slug }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: "loading", row: null });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: "loading", row: null });
    fetchJson(`/api/public/content/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then((data) => current && setState({ status: "success", row: data?.row || null }))
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setState({ status: error?.status === 404 ? "not-found" : "error", row: null });
      });
    return () => { current = false; controller.abort(); };
  }, [attempt, slug]);

  if (state.status === "not-found") return <ContentNotFound />;

  if (state.status === "success" && state.row?.type === "work") return <ContentNotFound />;

  if (state.status !== "success") {
    return (
      <article className="content-page content-detail-page">
        <Seo
          title="内容详情"
          description={DEFAULT_CONTENT_DESCRIPTION}
          pathname={`/content/${encodeURIComponent(slug)}`}
          type="article"
        />
        <AsyncState status={state.status} onRetry={() => setAttempt((value) => value + 1)} />
      </article>
    );
  }

  return (
    <AsyncState status={state.status} onRetry={() => setAttempt((value) => value + 1)}>
      {state.row ? (
        <ContentDetailView
          row={state.row}
          canonicalPath={`/content/${encodeURIComponent(slug)}`}
        />
      ) : null}
    </AsyncState>
  );
}
