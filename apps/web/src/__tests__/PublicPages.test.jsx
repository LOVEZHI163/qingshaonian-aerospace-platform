import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App.jsx";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

const site = {
  platformName: "温州航空航天赛事",
  platformIntro: "面向青少年的航空航天创新平台",
  organizers: ["温州市青少年活动中心"],
  contact: "0577-12345678",
  icp: "浙ICP备测试号"
};

function event(overrides = {}) {
  return {
    id: "E-2026",
    slug: "wenzhou-2026",
    name: "2026温州市青少年航空航天创新比赛",
    theme: "逐梦蓝天",
    slogan: "让创意启航",
    summary: "面向全市青少年的航空航天创新赛事。",
    dateLabel: "2026年11月21-22日",
    venue: "温州市青少年活动中心",
    contact: "组委会 0577-12345678",
    registrationStartAt: "2026-07-01T00:00:00.000Z",
    registrationEndAt: "2026-11-01T15:59:00.000Z",
    registrationMode: "automatic",
    status: "published",
    archivedAt: null,
    registrationWindow: { open: true, reason: "报名开放中" },
    hero: {
      id: "HERO",
      url: "/api/public/media/HERO?variant=original",
      mobileUrl: "/api/public/media/HERO?variant=mobile",
      desktopUrl: "/api/public/media/HERO?variant=desktop",
      name: "赛事封面.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      width: 1600,
      height: 900
    },
    ...overrides
  };
}

function content(id, type, overrides = {}) {
  return {
    id,
    slug: `${type}-${id.toLowerCase()}`,
    eventId: "E-2026",
    eventSlug: "wenzhou-2026",
    type,
    title: `${type}-${id} 标题`,
    summary: `${type}-${id} 摘要`,
    publishAt: "2026-07-19T08:00:00.000Z",
    pinned: false,
    cover: null,
    ...overrides
  };
}

const page = (rows, overrides = {}) => ({
  rows,
  pagination: { page: 1, pageSize: 10, total: rows.length, totalPages: rows.length ? 1 : 0 },
  ...overrides
});

const home = (overrides = {}) => ({
  site,
  mode: "active",
  featuredEvent: event(),
  concurrentEvents: [],
  services: [],
  announcements: [],
  news: [],
  works: [],
  history: [],
  ...overrides
});

function installApi(routes, bootstrap = home()) {
  const request = vi.fn(async (url) => {
    if (url === "/api/public/home") return jsonResponse(bootstrap);
    const handler = routes[url];
    if (typeof handler === "function") return handler();
    if (handler instanceof Response) return handler;
    if (handler !== undefined) return jsonResponse(handler);
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", request);
  return request;
}

describe("public event page", () => {
  beforeEach(() => window.history.replaceState({}, "", "/events/wenzhou-2026"));

  it("renders API facts, enabled projects, four groups, resources and event-scoped actions", async () => {
    installApi({
      "/api/public/events/wenzhou-2026": {
        event: event(),
        projects: [{
          id: "P1",
          eventId: "E-2026",
          name: "遥控纸飞机穿龙门",
          type: "individual",
          category: "航空模型",
          enabled: true,
          instructorRequired: true,
          displayOrder: 1,
          allowedGroups: ["小学低段", "小学高段"]
        }],
        groups: ["小学低段", "小学高段", "中学组", "职高/高中组"],
        resources: [{
          id: "RULES",
          label: "赛事规程",
          displayOrder: 0,
          url: "/api/public/media/RULES?variant=original",
          name: "赛事规程.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          width: null,
          height: null
        }],
        content: [
          content("NOTICE", "announcement"),
          content("NEWS", "news"),
          content("WORK", "work")
        ]
      }
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "2026温州市青少年航空航天创新比赛" })).toBeInTheDocument();
    expect(screen.getByText("2026年11月21-22日")).toBeInTheDocument();
    expect(screen.getAllByText("温州市青少年活动中心").length).toBeGreaterThan(0);
    expect(screen.getByText("报名开放中")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "遥控纸飞机穿龙门" })).toBeInTheDocument();
    for (const group of ["小学低段", "小学高段", "中学组", "职高/高中组"]) {
      expect(screen.getAllByText(group).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("link", { name: "立即报名" })).toHaveAttribute(
      "href",
      "/admin/?view=registration&eventId=E-2026"
    );
    expect(screen.getByRole("link", { name: "立即报名" })).toHaveAttribute("data-router-ignore", "true");
    expect(screen.getByRole("link", { name: "查询成绩" })).toHaveAttribute("href", "/admin/?view=records&eventId=E-2026");
    expect(screen.getByRole("link", { name: "查询证书" })).toHaveAttribute("href", "/admin/?view=certificates&eventId=E-2026");
    expect(screen.getByRole("link", { name: /赛事规程/ })).toHaveAttribute("href", "/api/public/media/RULES?variant=original");
    expect(screen.getByRole("link", { name: "announcement-NOTICE 标题" })).toHaveAttribute("href", "/content/announcement-notice");
  });

  it("uses the API registration window verbatim and removes registration for archived events", async () => {
    installApi({
      "/api/public/events/wenzhou-2026": {
        event: event({
          status: "archived",
          archivedAt: "2026-12-01T00:00:00.000Z",
          registrationMode: "force_open",
          registrationWindow: { open: false, reason: "赛事已归档" }
        }),
        projects: [], groups: ["小学低段", "小学高段", "中学组", "职高/高中组"], resources: [], content: []
      }
    });

    render(<App />);
    expect((await screen.findAllByText("赛事已归档")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "立即报名" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/admin/?view=registration"]')).toBeNull();
  });
});

describe("public content lists", () => {
  it("keeps announcements fixed to rows, paginates and preserves the legal type filter", async () => {
    window.history.replaceState({}, "", "/announcements");
    const first = page([content("A1", "announcement")], {
      pagination: { page: 1, pageSize: 10, total: 11, totalPages: 2 }
    });
    const second = page([content("A2", "announcement")], {
      pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 }
    });
    const request = installApi({
      "/api/public/content?type=announcement&page=1&pageSize=10": first,
      "/api/public/content?type=announcement&page=2&pageSize=10": second
    });

    render(<App />);
    expect(await screen.findByRole("link", { name: "announcement-A1 标题" })).toBeInTheDocument();
    expect(screen.queryByText("临时 items 数据")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("link", { name: "announcement-A2 标题" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "/api/public/content?type=announcement&page=2&pageSize=10",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(request.mock.calls.some(([url]) => url.includes("type=news"))).toBe(false);
  });

  it("loads news and work in parallel and switches accessible tabs without an illegal combined type", async () => {
    window.history.replaceState({}, "", "/news");
    const request = installApi({
      "/api/public/content?type=news&page=1&pageSize=10": page([content("N1", "news")]),
      "/api/public/content?type=work&page=1&pageSize=10": page([content("W1", "work")])
    });

    render(<App />);
    expect(await screen.findByRole("link", { name: "news-N1 标题" })).toBeInTheDocument();
    const newsCall = request.mock.calls.find(([url]) => url.includes("type=news"));
    const workCall = request.mock.calls.find(([url]) => url.includes("type=work"));
    expect(newsCall[1].signal).toBe(workCall[1].signal);
    expect(request.mock.calls.some(([url]) => url.includes("news,work"))).toBe(false);

    const tabs = screen.getByRole("tablist", { name: "内容分类" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "优秀作品" }));
    expect(screen.getByRole("link", { name: "work-W1 标题" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "优秀作品" })).toHaveAttribute("aria-selected", "true");
  });

  it("merges public archived-event summaries with recap rows without linking a hidden relation", async () => {
    window.history.replaceState({}, "", "/history");
    installApi({
      "/api/public/content?type=recap&page=1&pageSize=10": page([
        content("R1", "recap", { eventId: null, eventSlug: null }),
        content("R2", "recap", { eventId: "OLD", eventSlug: "old-event" })
      ])
    }, home({
      mode: "history",
      featuredEvent: event({ id: "OLD", slug: "old-event", name: "2025航空航天创新赛", status: "archived", registrationWindow: { open: false, reason: "赛事已归档" } }),
      concurrentEvents: []
    }));

    render(<App />);
    expect(await screen.findByRole("link", { name: "2025航空航天创新赛" })).toHaveAttribute("href", "/events/old-event");
    expect(screen.getByRole("link", { name: "recap-R1 标题" })).toHaveAttribute("href", "/content/recap-r1");
    expect(document.querySelector('a[href="/events/null"]')).toBeNull();
  });

  it("paginates recap rows without losing the history route", async () => {
    window.history.replaceState({}, "", "/history");
    const request = installApi({
      "/api/public/content?type=recap&page=1&pageSize=10": page([content("R1", "recap")], {
        pagination: { page: 1, pageSize: 10, total: 11, totalPages: 2 }
      }),
      "/api/public/content?type=recap&page=2&pageSize=10": page([content("R2", "recap")], {
        pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 }
      })
    });

    render(<App />);
    expect(await screen.findByText("recap-R1 标题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("recap-R2 标题")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/history");
    expect(request).toHaveBeenCalledWith(
      "/api/public/content?type=recap&page=2&pageSize=10",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("public content detail and failures", () => {
  beforeEach(() => window.history.replaceState({}, "", "/content/safe-story"));

  it("renders only public API HTML, hardens external links, fills image alt and lists safe attachments", async () => {
    window.__bodyScriptRan = false;
    installApi({
      "/api/public/content/safe-story": {
        row: {
          ...content("SAFE", "news", { slug: "safe-story", title: "安全公开内容" }),
          bodyHtml: '<p>服务端清洗正文</p><a href="https://example.org/resource">外部资料</a><a href="/history" target="_blank">站内历史</a><img src="/api/public/media/PHOTO?variant=original"><script>window.__bodyScriptRan=true</script>',
          attachments: [{
            id: "ATTACH",
            label: "下载赛事通知",
            displayOrder: 0,
            url: "/api/public/media/ATTACH?variant=original",
            name: "赛事通知.png",
            mimeType: "image/png",
            sizeBytes: 1536,
            width: 800,
            height: 600,
            filePath: "C:/private/never-show.png"
          }]
        }
      }
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "安全公开内容" })).toBeInTheDocument();
    expect(screen.getByText("服务端清洗正文")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "外部资料" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "外部资料" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "站内历史" })).not.toHaveAttribute("target");
    expect(screen.getByRole("img", { name: "正文图片" })).toBeInTheDocument();
    const attachment = screen.getByRole("link", { name: /下载赛事通知/ });
    expect(attachment).toHaveAttribute("href", "/api/public/media/ATTACH?variant=original");
    expect(attachment).toHaveAttribute("download", "赛事通知.png");
    expect(screen.getByText(/PNG 图片/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("C:/private/never-show.png");
    expect(window.__bodyScriptRan).toBe(false);
  });

  it("distinguishes a 404 from a retryable network failure", async () => {
    const request = installApi({
      "/api/public/content/safe-story": jsonResponse({ error: "内容不存在" }, 404)
    });
    const { unmount } = render(<App />);
    expect(await screen.findByRole("heading", { name: "内容不存在" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回内容列表" })).toHaveAttribute("href", "/news");
    expect(screen.queryByRole("button", { name: "重新加载" })).not.toBeInTheDocument();
    unmount();

    request.mockImplementation(async (url) => {
      if (url === "/api/public/home") return jsonResponse(home());
      throw new Error("network down");
    });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法加载页面数据");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });

  it("ignores stale list responses after a page change", async () => {
    window.history.replaceState({}, "", "/announcements");
    let resolveSecond;
    const secondResponse = new Promise((resolve) => { resolveSecond = resolve; });
    const request = vi.fn(async (url) => {
      if (url === "/api/public/home") return jsonResponse(home());
      if (url.includes("page=1")) return jsonResponse(page([content("A1", "announcement")], {
        pagination: { page: 1, pageSize: 10, total: 11, totalPages: 2 }
      }));
      return secondResponse;
    });
    vi.stubGlobal("fetch", request);

    const { unmount } = render(<App />);
    expect(await screen.findByText("announcement-A1 标题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    unmount();
    resolveSecond(jsonResponse(page([content("A2", "announcement")])));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });
});
