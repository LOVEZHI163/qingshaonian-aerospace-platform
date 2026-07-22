import React, { lazy, Suspense, useEffect, useState } from "react";
import { fetchJson } from "./api/client.js";
import { focusHashTarget, useRouter } from "./router.js";
import AsyncState from "./components/AsyncState.jsx";
import Seo from "./components/Seo.jsx";
import SiteFooter from "./components/SiteFooter.jsx";
import SiteHeader from "./components/SiteHeader.jsx";
import PreviewPage from "./pages/PreviewPage.jsx";

const ContentDetailPage = lazy(() => import("./pages/ContentDetailPage.jsx"));
const ContentListPage = lazy(() => import("./pages/ContentListPage.jsx"));
const EventDetailPage = lazy(() => import("./pages/EventDetailPage.jsx"));
const HistoryPage = lazy(() => import("./pages/HistoryPage.jsx"));
const HomePage = lazy(() => import("./pages/HomePage.jsx"));

function RouteLoading() {
  return (
    <div className="route-loading" role="status" aria-live="polite" aria-label="正在加载页面">
      <span className="loading-mark" aria-hidden="true" />
      <p>正在加载页面…</p>
    </div>
  );
}

function NotFoundPage() {
  return (
    <>
      <Seo title="页面未找到" description="您访问的页面不存在。" />
      <section className="page-skeleton not-found">
        <p>404</p>
        <h1>页面未找到</h1>
        <a href="/">返回首页</a>
      </section>
    </>
  );
}

function PublicRoute({ route, bootstrap, location }) {
  switch (route.name) {
    case "event": return <EventDetailPage slug={route.params.slug} />;
    case "announcements": return <ContentListPage mode="announcements" location={location} />;
    case "news": return <ContentListPage mode="news" location={location} />;
    case "history": return <HistoryPage location={location} />;
    case "content": return <ContentDetailPage slug={route.params.slug} />;
    default: return <NotFoundPage />;
  }
}

export default function App() {
  const { location, route } = useRouter();
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrap, setBootstrap] = useState({ status: "loading", data: null });

  useEffect(() => {
    if (route.name === "preview") return undefined;
    const controller = new AbortController();
    let current = true;
    setBootstrap({ status: "loading", data: null });

    fetchJson("/api/public/home", { signal: controller.signal })
      .then((data) => {
        if (!current) return;
        setBootstrap({ status: data == null ? "empty" : "success", data });
      })
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setBootstrap({ status: "error", data: null });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [bootstrapAttempt, route.name]);

  useEffect(() => {
    const hash = new URL(location || "/", window.location.origin).hash;
    if (!hash || focusHashTarget(hash)) return undefined;
    const observer = new MutationObserver(() => {
      if (focusHashTarget(hash)) observer.disconnect();
    });
    observer.observe(document.getElementById("main-content") || document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [location]);

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <SiteHeader routeKey={location} />
      <main id="main-content" tabIndex="-1">
        <Suspense fallback={<RouteLoading />}>
          {route.name === "preview" ? (
            <PreviewPage location={location} />
          ) : route.name === "not-found" ? (
            <NotFoundPage />
          ) : route.name === "home" ? (
            <div className="home-route">
              <Seo
                title={bootstrap.data?.site?.seoTitle || bootstrap.data?.site?.platformName || "温州市青少年航空航天创新比赛"}
                description={bootstrap.data?.site?.seoDescription || bootstrap.data?.site?.platformIntro || "温州市青少年航空航天创新赛事、公告、动态与优秀作品平台。"}
                pathname="/"
                image={bootstrap.data?.site?.shareImage || bootstrap.data?.featuredEvent?.hero}
              />
              <h1 className="visually-hidden">首页</h1>
              <AsyncState
                status={bootstrap.status}
                onRetry={() => setBootstrapAttempt((value) => value + 1)}
              >
                <HomePage data={bootstrap.data || {}} />
              </AsyncState>
            </div>
          ) : (
            <PublicRoute
              key={`${route.name}:${route.params.slug || ""}`}
              route={route}
              bootstrap={bootstrap.data}
              location={location}
            />
          )}
        </Suspense>
      </main>
      <SiteFooter site={bootstrap.data?.site || {}} />
    </div>
  );
}
