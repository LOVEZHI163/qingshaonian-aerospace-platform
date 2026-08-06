import React, { useEffect, useRef, useState } from "react";

import { fetchJson } from "../api/client.js";
import AsyncState from "../components/AsyncState.jsx";
import AttachmentList from "../components/AttachmentList.jsx";
import Seo from "../components/Seo.jsx";
import { enhanceBilibiliVideos } from "../lib/bilibili-video.js";

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
        description={row?.summary || "查看赛事公告、动态与优秀作品详情。"}
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

  if (state.status !== "success") {
    return (
      <article className="content-page content-detail-page">
        <Seo
          title="内容详情"
          description="查看赛事公告、动态与优秀作品详情。"
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
