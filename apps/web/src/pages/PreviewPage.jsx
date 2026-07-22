import React from "react";

import Seo from "../components/Seo.jsx";
import HomePage from "./HomePage.jsx";
import { readPreviewSnapshot } from "../preview/storage.js";

const messages = {
  invalid: ["预览链接无效", "请返回管理后台重新生成预览。"],
  expired: ["预览已过期", "草稿预览有效期为 15 分钟，请返回后台重新生成。"]
};

function previewToken(location) {
  try {
    const url = new URL(location || "/preview", window.location.origin);
    const values = url.searchParams.getAll("token");
    return values.length === 1 ? values[0] : null;
  } catch {
    return null;
  }
}

function adminReturnPath(value) {
  try {
    const url = new URL(value || "/admin/", window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/admin/")) return "/admin/";
    url.searchParams.delete("token");
    url.hash = "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/admin/";
  }
}

function PreviewStatus({ snapshot }) {
  const expiresAt = new Date(snapshot.expiresAt);
  const expiry = Number.isFinite(expiresAt.getTime())
    ? expiresAt.toLocaleString("zh-CN", { hour12: false })
    : "稍后";
  return (
    <aside className="preview-status" aria-label="草稿预览状态">
      <p>草稿预览 · 未保存 · 仅当前浏览器可见</p>
      <span>有效至：{expiry}</span>
      <a href={adminReturnPath(snapshot.adminReturnPath)} data-router-ignore="true">返回管理后台</a>
    </aside>
  );
}

function EventPreview({ payload }) {
  const event = payload?.event;
  return (
    <section className="page-skeleton preview-dispatch" aria-labelledby="preview-event-title">
      <p>草稿赛事</p>
      <h1 id="preview-event-title">{event?.name || "赛事草稿预览"}</h1>
      <p>赛事详情将在此按草稿快照展示。</p>
    </section>
  );
}

function ContentPreview({ payload }) {
  const row = payload?.row;
  return (
    <section className="page-skeleton preview-dispatch" aria-labelledby="preview-content-title">
      <p>草稿内容</p>
      <h1 id="preview-content-title">{row?.title || "内容草稿预览"}</h1>
      <p>{row?.summary || "内容详情将在此按草稿快照展示。"}</p>
    </section>
  );
}

function PreviewBody({ snapshot }) {
  switch (snapshot.kind) {
    case "homepage":
      return (
        <div className="home-route preview-dispatch">
          <h1 className="visually-hidden">{snapshot.payload?.site?.platformName || "首页草稿预览"}</h1>
          <HomePage data={snapshot.payload || {}} />
        </div>
      );
    case "event": return <EventPreview payload={snapshot.payload} />;
    case "content": return <ContentPreview payload={snapshot.payload} />;
    default: return null;
  }
}

function PreviewError({ reason }) {
  const [title, detail] = messages[reason] || messages.invalid;
  return (
    <>
      <Seo title={title} description={detail} robots="noindex, nofollow" canonical={false} />
      <section className="page-skeleton not-found preview-error" aria-labelledby="preview-error-title">
        <p>草稿预览</p>
        <h1 id="preview-error-title">{title}</h1>
        <p>{detail}</p>
        <a href="/admin/" data-router-ignore="true">返回管理后台</a>
      </section>
    </>
  );
}

export default function PreviewPage({ location }) {
  const result = readPreviewSnapshot(previewToken(location));
  if (!result.ok) return <PreviewError reason={result.reason} />;

  const { snapshot } = result;
  return (
    <>
      <Seo title="草稿预览" description="管理员草稿预览" robots="noindex, nofollow" canonical={false} />
      <PreviewStatus snapshot={snapshot} />
      <PreviewBody snapshot={snapshot} />
    </>
  );
}
