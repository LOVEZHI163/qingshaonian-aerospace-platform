import React from "react";

import Seo from "../components/Seo.jsx";
import HomePage from "./HomePage.jsx";
import { readPreviewSnapshot } from "../preview/storage.js";
import { EventDetailView } from "./EventDetailPage.jsx";
import { ContentDetailView } from "./ContentDetailPage.jsx";

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

export function readPreviewPageSnapshot(location) {
  return readPreviewSnapshot(previewToken(location));
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
    <aside className="preview-banner" aria-label="草稿预览状态">
      <p>草稿预览 · 未保存 · 仅当前浏览器可见</p>
      <span>有效至：{expiry}</span>
      <a href={adminReturnPath(snapshot.adminReturnPath)} data-router-ignore="true">返回管理后台</a>
    </aside>
  );
}

function PreviewBody({ snapshot }) {
  switch (snapshot.kind) {
    case "homepage": {
      const site = snapshot.payload?.site || {};
      return (
        <>
          <Seo
            title={site.seoTitle || site.platformName || "草稿预览"}
            description={site.seoDescription || site.platformIntro || "管理员草稿预览"}
            image={site.shareImage || snapshot.payload?.featuredEvent?.hero}
            robots="noindex, nofollow"
            canonical={false}
          />
          <div className="home-route">
            <h1 className="visually-hidden">{snapshot.payload?.site?.platformName || "首页草稿预览"}</h1>
            <HomePage data={snapshot.payload || {}} />
          </div>
        </>
      );
    }
    case "event": return <EventDetailView payload={snapshot.payload || {}} preview />;
    case "content": return <ContentDetailView row={snapshot.payload?.row || null} preview />;
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

export default function PreviewPage({ location, result }) {
  const initialized = React.useRef(false);
  const [liveResult, setLiveResult] = React.useState(
    () => result || readPreviewPageSnapshot(location)
  );

  React.useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    setLiveResult(result || readPreviewPageSnapshot(location));
  }, [location, result]);

  React.useEffect(() => {
    if (!liveResult.ok) return undefined;

    const checkExpiry = () => {
      setLiveResult(readPreviewPageSnapshot(location));
    };
    const delay = Math.max(0, liveResult.snapshot.expiresAt - Date.now());
    const timer = window.setTimeout(checkExpiry, delay);
    window.addEventListener("focus", checkExpiry);
    document.addEventListener("visibilitychange", checkExpiry);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", checkExpiry);
      document.removeEventListener("visibilitychange", checkExpiry);
    };
  }, [location, liveResult.ok ? liveResult.snapshot.expiresAt : null]);

  if (!liveResult.ok) return <PreviewError reason={liveResult.reason} />;

  const { snapshot } = liveResult;
  return (
    <>
      <PreviewStatus snapshot={snapshot} />
      <div className="preview-page">
        <PreviewBody snapshot={snapshot} />
      </div>
    </>
  );
}
