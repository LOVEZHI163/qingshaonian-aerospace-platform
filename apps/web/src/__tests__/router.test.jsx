import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.jsx";
import { fetchJson } from "../api/client.js";
import { matchRoute, shouldHandleLinkClick } from "../router.js";

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const emptyPage = { rows: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 } };

afterEach(() => vi.useRealTimers());

function routePayload(url) {
  if (url === "/api/public/home") return {
    site: { platformName: "测试赛事平台" },
    mode: "active",
    featuredEvent: null,
    concurrentEvents: [],
    services: [],
    announcements: [],
    news: [],
    works: [],
    history: []
  };
  if (url.startsWith("/api/public/events/")) return {
    event: {
      id: "E1", slug: "summer-cup", name: "测试赛事详情", status: "published",
      registrationWindow: { open: false, reason: "报名尚未开始" }
    },
    projects: [], groups: [], resources: [], content: []
  };
  if (url.startsWith("/api/public/content/opening-notice")) return {
    row: { id: "C1", slug: "opening-notice", type: "announcement", title: "测试内容详情", bodyHtml: "", attachments: [] }
  };
  return emptyPage;
}

describe("public site router", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => jsonResponse(routePayload(url)))
    );
  });

  it.each([
    ["/", "首页"],
    ["/events/summer-cup", "测试赛事详情"],
    ["/announcements", "通知公告"],
    ["/news", "新闻动态"],
    ["/history", "历届赛事"],
    ["/content/opening-notice", "测试内容详情"]
  ])("renders the %s route inside the persistent site shell", async (path, heading) => {
    window.history.replaceState({}, "", path);
    render(<App />);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it.each([
    ["/about", "大赛简介"],
    ["/rules", "大赛章程"],
    ["/registration-guide", "报名流程"],
    ["/contact", "联系我们"],
    ["/projects", "赛事项目与组别"]
  ])("renders the %s event information route", async (path, heading) => {
    window.history.replaceState({}, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  });

  it("shows a 404 page for unknown and malformed encoded paths", () => {
    window.history.replaceState({}, "", "/events/%E0%A4%A");
    const { rerender } = render(<App />);
    expect(screen.getByRole("heading", { name: "页面未找到" })).toBeInTheDocument();

    window.history.replaceState({}, "", "/not-a-route");
    window.dispatchEvent(new PopStateEvent("popstate"));
    rerender(<App />);
    expect(screen.getByRole("heading", { name: "页面未找到" })).toBeInTheDocument();
  });

  it("decodes legal slugs and rejects malformed encodings", () => {
    expect(matchRoute("/events/%E9%A3%9E%E8%A1%8C%E6%AF%94%E8%B5%9B")).toMatchObject({
      name: "event",
      params: { slug: "飞行比赛" }
    });
    expect(matchRoute("/content/%E0%A4%A")).toMatchObject({ name: "not-found" });
  });

  it("recognizes only the fixed preview path", () => {
    expect(matchRoute("/preview")).toEqual({ name: "preview", params: {} });
    expect(matchRoute("/preview/extra").name).toBe("not-found");
  });

  it("uses History API navigation and responds to popstate", async () => {
    render(<App />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("link", { name: "赛事资讯" }));
    expect(window.location.pathname).toBe("/news");
    expect(screen.getByRole("heading", { name: "新闻动态" })).toBeInTheDocument();

    window.history.pushState({}, "", "/history");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "历届赛事" })).toBeInTheDocument();
  });

  it("scrolls and moves focus for repeated real same-page skip-link clicks", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<App />);

    fireEvent.click(screen.getByRole("link", { name: "跳到主要内容" }));
    await waitFor(() => expect(document.getElementById("main-content")).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();

    screen.getByRole("link", { name: "网站首页" }).focus();
    fireEvent.click(screen.getByRole("link", { name: "跳到主要内容" }));
    expect(document.getElementById("main-content")).toHaveFocus();
  });

  it("keeps cross-route hash focus pending for a target that appears after two seconds", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/news");
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<App />);
    const delayedLink = document.createElement("a");
    delayedLink.href = "/#late-registration";
    delayedLink.textContent = "延迟报名锚点";
    document.body.append(delayedLink);

    fireEvent.click(delayedLink);
    await act(async () => { vi.advanceTimersByTime(2_500); });
    const target = document.createElement("section");
    target.id = "late-registration";
    target.tabIndex = -1;
    document.getElementById("main-content").append(target);
    await act(async () => { await Promise.resolve(); });

    expect(target).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("loads the history skeleton from the public recap list API", () => {
    window.history.replaceState({}, "", "/history");
    render(<App />);
    expect(fetch).toHaveBeenCalledWith(
      "/api/public/content?type=recap&page=1&pageSize=10",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("renders the footer from the public site settings contract", async () => {
    fetch.mockResolvedValueOnce(jsonResponse({
      site: {
        platformName: "温州航空赛事",
        platformIntro: "面向青少年的航空航天创新平台",
        organizers: ["主办甲", "主办乙"],
        contact: "0577-12345678",
        icp: "浙ICP备测试号"
      }
    }));
    render(<App />);

    expect(await screen.findByText("温州航空赛事")).toBeInTheDocument();
    expect(screen.getByText("面向青少年的航空航天创新平台")).toBeInTheDocument();
    expect(screen.getByText("主办甲、主办乙")).toBeInTheDocument();
    expect(screen.getByText("0577-12345678")).toBeInTheDocument();
    expect(screen.getByText("浙ICP备测试号")).toBeInTheDocument();
  });

  it("only intercepts unmodified same-origin primary-link navigation", () => {
    const anchor = document.createElement("a");
    anchor.href = "/news";
    expect(shouldHandleLinkClick({ button: 0, target: anchor })).toBe(true);
    expect(shouldHandleLinkClick({ button: 0, ctrlKey: true, target: anchor })).toBe(false);

    anchor.target = "_blank";
    expect(shouldHandleLinkClick({ button: 0, target: anchor })).toBe(false);
    anchor.removeAttribute("target");
    anchor.download = "news.html";
    expect(shouldHandleLinkClick({ button: 0, target: anchor })).toBe(false);
    anchor.removeAttribute("download");
    anchor.href = "https://example.com/news";
    expect(shouldHandleLinkClick({ button: 0, target: anchor })).toBe(false);
    anchor.href = "/admin/";
    anchor.dataset.routerIgnore = "true";
    expect(shouldHandleLinkClick({ button: 0, target: anchor })).toBe(false);
  });
});

describe("public site async states", () => {
  beforeEach(() => window.history.replaceState({}, "", "/"));

  it("shows loading, a retryable error and then an empty state without blanking the shell", async () => {
    const first = deferred();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);

    render(<App />);
    expect(screen.getByRole("status", { name: "正在加载" })).toBeInTheDocument();
    first.reject(new Error("网络不可用"));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法加载页面数据");
    expect(screen.getByRole("banner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("暂无可显示内容")).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts the page request when the route component unmounts", () => {
    let capturedSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => {
        capturedSignal = options.signal;
        return new Promise(() => {});
      })
    );

    const { unmount } = render(<App />);
    expect(capturedSignal.aborted).toBe(false);
    unmount();
    expect(capturedSignal.aborted).toBe(true);
  });

  it("keeps successful business content visible when the site bootstrap fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path) => {
      if (path === "/api/public/home") throw new Error("bootstrap unavailable");
      return jsonResponse({ rows: [{ id: "notice-1", slug: "notice-1", type: "announcement", title: "业务公告" }], pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 } });
    }));
    window.history.replaceState({}, "", "/announcements");

    render(<App />);
    expect(await screen.findByText("业务公告")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });
});

describe("site bootstrap and route data", () => {
  const site = {
    platformName: "全站真实平台",
    platformIntro: "全站公开简介",
    organizers: ["全站主办方"],
    contact: "0577-88888888",
    icp: "浙ICP备全站号"
  };

  beforeEach(() => window.history.replaceState({}, "", "/"));

  it.each([
    "/events/summer-cup",
    "/announcements",
    "/news",
    "/history",
    "/content/opening-notice"
  ])("bootstraps the real footer on a direct visit to %s", async (path) => {
    window.history.replaceState({}, "", path);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/api/public/home") return jsonResponse({ site });
      return jsonResponse(url.startsWith("/api/public/events/") ? routePayload(url) : url.startsWith("/api/public/content/opening-notice") ? routePayload(url) : emptyPage);
    }));

    render(<App />);
    expect(await screen.findByText("全站真实平台")).toBeInTheDocument();
    expect(screen.getByText("全站公开简介")).toBeInTheDocument();
    expect(screen.getByText("全站主办方")).toBeInTheDocument();
    expect(screen.getByText("浙ICP备全站号")).toBeInTheDocument();
  });

  it("reuses the bootstrap payload on home without requesting home twice", async () => {
    const request = vi.fn(async () => jsonResponse({ site }));
    vi.stubGlobal("fetch", request);
    render(<App />);

    expect(await screen.findByText("页面基础数据已加载")).toBeInTheDocument();
    expect(request.mock.calls.filter(([url]) => url === "/api/public/home")).toHaveLength(1);
  });

  it("keeps footer ownership with bootstrap instead of route payloads", async () => {
    window.history.replaceState({}, "", "/announcements");
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/api/public/home") return jsonResponse({ site });
      return jsonResponse({ ...emptyPage, site: { platformName: "错误业务平台" } });
    }));

    render(<App />);
    expect(await screen.findByText("全站真实平台")).toBeInTheDocument();
    expect(screen.queryByText("错误业务平台")).not.toBeInTheDocument();
  });

  it("aborts bootstrap and route requests when a direct route unmounts", () => {
    window.history.replaceState({}, "", "/events/summer-cup");
    const signals = [];
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    }));

    const { unmount } = render(<App />);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted === false)).toBe(true);
    unmount();
    expect(signals.every((signal) => signal.aborted === true)).toBe(true);
  });

  it("loads only the public news stream", async () => {
    window.history.replaceState({}, "", "/news");
    const request = vi.fn(async (url) => {
      if (url === "/api/public/home") return jsonResponse({ site });
      return jsonResponse({ rows: [{ id: "news-1", slug: "news-1", type: "news", title: "动态一" }], pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 } });
    });
    vi.stubGlobal("fetch", request);

    render(<App />);
    expect(await screen.findByText("动态一")).toBeInTheDocument();
    const newsCall = request.mock.calls.find(([url]) => url === "/api/public/content?type=news&page=1&pageSize=10");
    expect(newsCall).toBeDefined();
    expect(request.mock.calls.some(([url]) => url.includes("type=work"))).toBe(false);
  });

  it("does not fail the news page for a removed work endpoint", async () => {
    window.history.replaceState({}, "", "/news");
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/api/public/home") return jsonResponse({ site });
      return jsonResponse(emptyPage);
    }));

    render(<App />);
    expect(await screen.findByText("暂无公开内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("site header mobile menu", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ site: {} })));
    vi.stubGlobal("matchMedia", vi.fn((media) => ({
      matches: media === "(max-width: 1280px)",
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })));
  });

  it("has accessible menu state, closes on Escape and restores trigger focus", () => {
    render(<App />);
    const trigger = screen.getByRole("button", { name: "打开赛事导航" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes after route navigation and uses a safe event-selection registration link", () => {
    render(<App />);
    const trigger = screen.getByRole("button", { name: "打开赛事导航" });
    fireEvent.click(trigger);
    const mobileNavigation = screen.getByRole("navigation", { name: "移动端主导航" });
    const registration = within(document.querySelector(".mobile-navigation-actions")).getByRole("link", { name: "报名入口" });
    expect(registration).toHaveAttribute("href", "/admin/?view=eventCenter");
    fireEvent.click(within(mobileNavigation).getByRole("button", { name: "赛事资讯" }));
    fireEvent.click(within(mobileNavigation).getByRole("link", { name: "通知公告" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(window.location.pathname).toBe("/announcements");
    expect(screen.getByRole("link", { name: "用户登录" })).toHaveAttribute("href", "/admin/");
    expect(screen.getByRole("link", { name: "用户登录" })).toHaveAttribute("data-router-ignore", "true");
    expect(screen.getByRole("link", { name: "管理入口" })).toHaveAttribute("data-router-ignore", "true");
  });
});

describe("fetchJson", () => {
  it("returns null for 204 and empty successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response("", { status: 200 })));
    await expect(fetchJson("/empty-204")).resolves.toBeNull();
    await expect(fetchJson("/empty-200")).resolves.toBeNull();
  });

  it("throws a typed error for non-2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "SITE_UNAVAILABLE", message: "维护中" }, { status: 503 })));
    await expect(fetchJson("/error")).rejects.toMatchObject({
      status: 503,
      code: "SITE_UNAVAILABLE",
      message: "维护中"
    });
  });

  it("reports invalid JSON clearly and preserves AbortError semantics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(fetchJson("/invalid")).rejects.toThrow("服务器返回了无效的 JSON");

    const abortError = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortError)));
    await expect(fetchJson("/abort")).rejects.toBe(abortError);
  });
});
