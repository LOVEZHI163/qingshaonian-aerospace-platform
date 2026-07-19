import React, { useEffect, useState } from "react";
import { fetchJson } from "./api/client.js";
import { useRouter } from "./router.js";
import AsyncState from "./components/AsyncState.jsx";
import SiteFooter from "./components/SiteFooter.jsx";
import SiteHeader from "./components/SiteHeader.jsx";
import ContentDetailPage from "./pages/ContentDetailPage.jsx";
import ContentListPage from "./pages/ContentListPage.jsx";
import EventDetailPage from "./pages/EventDetailPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import HomePage from "./pages/HomePage.jsx";

function NotFoundPage() {
  return (
    <section className="page-skeleton not-found">
      <p>404</p>
      <h1>页面未找到</h1>
      <a href="/">返回首页</a>
    </section>
  );
}

function PublicRoute({ route, bootstrap }) {
  switch (route.name) {
    case "event": return <EventDetailPage slug={route.params.slug} />;
    case "announcements": return <ContentListPage mode="announcements" />;
    case "news": return <ContentListPage mode="news" />;
    case "history": return <HistoryPage bootstrap={bootstrap} />;
    case "content": return <ContentDetailPage slug={route.params.slug} />;
    default: return <NotFoundPage />;
  }
}

export default function App() {
  const { location, route } = useRouter();
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrap, setBootstrap] = useState({ status: "loading", data: null });

  useEffect(() => {
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
  }, [bootstrapAttempt]);

  return (
    <div className="site-shell">
      <SiteHeader routeKey={location} />
      <main id="main-content">
        {route.name === "not-found" ? (
          <NotFoundPage />
        ) : route.name === "home" ? (
          <div className="home-route">
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
          />
        )}
      </main>
      <SiteFooter site={bootstrap.data?.site || {}} />
    </div>
  );
}
