import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "./api/client.js";
import { useRouter } from "./router.js";
import AsyncState from "./components/AsyncState.jsx";
import SiteFooter from "./components/SiteFooter.jsx";
import SiteHeader from "./components/SiteHeader.jsx";

const pageDefinitions = {
  home: { heading: "首页" },
  event: { heading: "赛事详情", endpoint: ({ slug }) => `/api/public/events/${encodeURIComponent(slug)}` },
  announcements: { heading: "公告", endpoint: () => "/api/public/content?type=announcement" },
  news: { heading: "动态与作品" },
  history: { heading: "历届赛事", endpoint: () => "/api/public/content?type=recap" },
  content: { heading: "内容详情", endpoint: ({ slug }) => `/api/public/content/${encodeURIComponent(slug)}` }
};

async function loadRouteData(route, signal) {
  if (route.name === "news") {
    const [news, work] = await Promise.all([
      fetchJson("/api/public/content?type=news", { signal }),
      fetchJson("/api/public/content?type=work", { signal })
    ]);
    return {
      news: { type: "news", items: news?.items || [] },
      work: { type: "work", items: work?.items || [] }
    };
  }

  const definition = pageDefinitions[route.name];
  return fetchJson(definition.endpoint(route.params), { signal });
}

function PageLayout({ heading, state, onRetry }) {
  return (
    <section className="page-skeleton" aria-labelledby="page-title">
      <div className="page-heading">
        <p>官方网站</p>
        <h1 id="page-title">{heading}</h1>
      </div>
      <AsyncState status={state.status} onRetry={onRetry}>
        <div className="page-ready">
          <strong>页面基础数据已加载</strong>
          <p>完整页面内容将在后续页面任务中呈现。</p>
        </div>
      </AsyncState>
    </section>
  );
}

function RemotePageSkeleton({ route }) {
  const definition = pageDefinitions[route.name];
  const routeRequestKey = useMemo(
    () => `${route.name}:${route.params.slug || ""}`,
    [route.name, route.params.slug]
  );
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: "loading", data: null });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: "loading", data: null });

    loadRouteData(route, controller.signal)
      .then((data) => {
        if (!current) return;
        setState({ status: data == null ? "empty" : "success", data });
      })
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setState({ status: "error", data: null });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [attempt, routeRequestKey]);

  return (
    <PageLayout
      heading={definition.heading}
      state={state}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

function NotFoundPage() {
  return (
    <section className="page-skeleton not-found">
      <p>404</p>
      <h1>页面未找到</h1>
      <a href="/">返回首页</a>
    </section>
  );
}

export default function App() {
  const { location, route } = useRouter();
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrap, setBootstrap] = useState({ status: "loading", data: null });
  const routeKey = `${route.name}:${route.params.slug || ""}`;

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
          <PageLayout
            heading={pageDefinitions.home.heading}
            state={bootstrap}
            onRetry={() => setBootstrapAttempt((value) => value + 1)}
          />
        ) : (
          <RemotePageSkeleton key={routeKey} route={route} />
        )}
      </main>
      <SiteFooter site={bootstrap.data?.site || {}} />
    </div>
  );
}
