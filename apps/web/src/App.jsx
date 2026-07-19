import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "./api/client.js";
import { useRouter } from "./router.js";
import AsyncState from "./components/AsyncState.jsx";
import SiteFooter from "./components/SiteFooter.jsx";
import SiteHeader from "./components/SiteHeader.jsx";

const pageDefinitions = {
  home: { heading: "首页", endpoint: () => "/api/public/home" },
  event: { heading: "赛事详情", endpoint: ({ slug }) => `/api/public/events/${encodeURIComponent(slug)}` },
  announcements: { heading: "公告", endpoint: () => "/api/public/content?type=announcement" },
  news: { heading: "动态与作品", endpoint: () => "/api/public/content?type=news,work" },
  history: { heading: "历届赛事", endpoint: () => "/api/public/content?type=recap" },
  content: { heading: "内容详情", endpoint: ({ slug }) => `/api/public/content/${encodeURIComponent(slug)}` }
};

function PageSkeleton({ route, onSite }) {
  const definition = pageDefinitions[route.name];
  const endpoint = useMemo(() => definition.endpoint(route.params), [definition, route.params.slug]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: "loading", data: null });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: "loading", data: null });

    fetchJson(endpoint, { signal: controller.signal })
      .then((data) => {
        if (!current) return;
        if (data?.site) onSite(data.site);
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
  }, [attempt, endpoint, onSite]);

  return (
    <section className="page-skeleton" aria-labelledby="page-title">
      <div className="page-heading">
        <p>官方网站</p>
        <h1 id="page-title">{definition.heading}</h1>
      </div>
      <AsyncState status={state.status} onRetry={() => setAttempt((value) => value + 1)}>
        <div className="page-ready">
          <strong>页面基础数据已加载</strong>
          <p>完整页面内容将在后续页面任务中呈现。</p>
        </div>
      </AsyncState>
    </section>
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
  const [site, setSite] = useState({});
  const routeKey = `${route.name}:${route.params.slug || ""}`;

  return (
    <div className="site-shell">
      <SiteHeader routeKey={location} />
      <main id="main-content">
        {route.name === "not-found" ? (
          <NotFoundPage />
        ) : (
          <PageSkeleton key={routeKey} route={route} onSite={setSite} />
        )}
      </main>
      <SiteFooter site={site} />
    </div>
  );
}
