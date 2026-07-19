import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("public site router", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ site: { platformName: "测试赛事平台" }, title: "测试数据" }))
    );
  });

  it.each([
    ["/", "首页"],
    ["/events/summer-cup", "赛事详情"],
    ["/announcements", "公告"],
    ["/news", "动态与作品"],
    ["/history", "历届赛事"],
    ["/content/opening-notice", "内容详情"]
  ])("renders the %s route inside the persistent site shell", async (path, heading) => {
    window.history.replaceState({}, "", path);
    render(<App />);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(await screen.findByText("页面基础数据已加载")).toBeInTheDocument();
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

  it("uses History API navigation and responds to popstate", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "公告" }));
    expect(window.location.pathname).toBe("/announcements");
    expect(screen.getByRole("heading", { name: "公告" })).toBeInTheDocument();

    window.history.pushState({}, "", "/history");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "历届赛事" })).toBeInTheDocument();
  });

  it("loads the history skeleton from the public recap list API", () => {
    window.history.replaceState({}, "", "/history");
    render(<App />);
    expect(fetch).toHaveBeenCalledWith(
      "/api/public/content?type=recap",
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

  it("does not let an obsolete request overwrite the new route site data", async () => {
    const home = deferred();
    const announcements = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementationOnce(() => home.promise).mockImplementationOnce(() => announcements.promise)
    );

    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "公告" }));
    announcements.resolve(jsonResponse({ site: { platformName: "当前平台" }, title: "当前公告" }));
    expect(await screen.findByText("当前平台")).toBeInTheDocument();

    home.resolve(jsonResponse({ site: { platformName: "过期平台" }, title: "过期首页" }));
    await waitFor(() => expect(screen.queryByText("过期平台")).not.toBeInTheDocument());
  });
});

describe("site header mobile menu", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ site: {} })));
  });

  it("has accessible menu state, closes on Escape and restores trigger focus", () => {
    render(<App />);
    const trigger = screen.getByRole("button", { name: "打开导航菜单" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes after route navigation and uses a safe event-selection registration link", () => {
    render(<App />);
    const trigger = screen.getByRole("button", { name: "打开导航菜单" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("link", { name: "公告" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: "报名入口" })).toHaveAttribute("href", "/#events");
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
