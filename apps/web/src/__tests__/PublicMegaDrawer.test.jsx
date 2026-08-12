import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SiteHeader from "../components/SiteHeader.jsx";

const first = {
  id: "event-first",
  slug: "first",
  name: "第一届航空挑战赛"
};

const second = {
  id: "event-second",
  slug: "second",
  name: "第二届航空挑战赛"
};

const home = {
  featuredEvent: first,
  concurrentEvents: [second]
};

function createMediaQueryList(media, initialMatches) {
  let matches = initialMatches;
  const listeners = new Set();
  return {
    media,
    onchange: null,
    get matches() { return matches; },
    addEventListener: vi.fn((type, listener) => {
      if (type === "change") listeners.add(listener);
    }),
    removeEventListener: vi.fn((type, listener) => {
      if (type === "change") listeners.delete(listener);
    }),
    setMatches(nextMatches) {
      matches = nextMatches;
      listeners.forEach((listener) => listener({ matches, media }));
    }
  };
}

function installMatchMedia({ hover = false, mobile = false, reducedMotion = false } = {}) {
  const hoverQuery = createMediaQueryList("(hover: hover) and (pointer: fine)", hover);
  const mobileQuery = createMediaQueryList("(max-width: 1120px)", mobile);
  const reducedMotionQuery = createMediaQueryList("(prefers-reduced-motion: reduce)", reducedMotion);
  vi.stubGlobal("matchMedia", vi.fn((media) => {
    if (media === mobileQuery.media) return mobileQuery;
    if (media === reducedMotionQuery.media) return reducedMotionQuery;
    return hoverQuery;
  }));
  return { mobileQuery };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("per-module public navigation", () => {
  it("opens only the hovered group and switches to the clicked group", () => {
    installMatchMedia({ hover: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "首页" }));
    expect(screen.getByRole("navigation", { name: "首页子导航" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "大赛章程" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关于大赛" }));
    expect(screen.queryByRole("navigation", { name: "首页子导航" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "关于大赛子导航" })).toBeVisible();
  });

  it("waits before hover closing, cancels on drawer entry, and closes after leaving the bridge", () => {
    vi.useFakeTimers();
    installMatchMedia({ hover: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "首页" });

    fireEvent.mouseEnter(trigger);
    const drawer = screen.getByRole("navigation", { name: "首页子导航" });
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(299));
    expect(drawer).toBeVisible();
    fireEvent.mouseEnter(drawer);
    act(() => vi.advanceTimersByTime(1));
    expect(drawer).toBeVisible();

    fireEvent.mouseLeave(drawer);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("navigation", { name: "首页子导航" })).not.toBeInTheDocument();
  });

  it("keeps a click-locked drawer open after the hover bridge is left", () => {
    vi.useFakeTimers();
    installMatchMedia({ hover: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "关于大赛" });

    fireEvent.click(trigger);
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByRole("navigation", { name: "关于大赛子导航" })).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("does not extend the hover bridge to the logo or other header controls", () => {
    vi.useFakeTimers();
    installMatchMedia({ hover: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "赛事资讯" });

    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("navigation", { name: "赛事资讯子导航" })).toBeVisible();
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "网站首页" }));
    act(() => vi.advanceTimersByTime(300));

    expect(screen.queryByRole("navigation", { name: "赛事资讯子导航" })).not.toBeInTheDocument();
  });

  it("moves focus only after a newly mounted drawer reports it is ready", async () => {
    installMatchMedia({ hover: true });
    render(
      <>
        <button type="button">焦点哨兵</button>
        <SiteHeader routeKey="/" homeData={home} homeStatus="success" />
      </>
    );
    const sentinel = screen.getByRole("button", { name: "焦点哨兵" });
    const hoverTrigger = screen.getByRole("button", { name: "首页" });
    const clickTrigger = screen.getByRole("button", { name: "关于大赛" });
    const keyboardTrigger = screen.getByRole("button", { name: "赛事资讯" });
    sentinel.focus();

    fireEvent.mouseEnter(hoverTrigger);
    expect(sentinel).toHaveFocus();
    fireEvent.mouseLeave(hoverTrigger);

    fireEvent.click(clickTrigger);
    expect(await screen.findByRole("link", { name: "大赛简介" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(clickTrigger).toHaveFocus();

    fireEvent.keyDown(keyboardTrigger, { key: "Enter", code: "Enter" });
    expect(await screen.findByRole("link", { name: "通知公告" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(keyboardTrigger).toHaveFocus();
  });

  it("marks registration guide as home and contact as its direct primary entry", () => {
    const { rerender } = render(<SiteHeader routeKey="/registration-guide" homeData={home} homeStatus="success" />);
    expect(screen.getByRole("button", { name: "首页" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "关于大赛" })).not.toHaveAttribute("aria-current");

    rerender(<SiteHeader routeKey="/contact" homeData={home} homeStatus="success" />);
    expect(screen.getByRole("link", { name: "联系我们" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "关于大赛" })).not.toHaveAttribute("aria-current");
  });

  it("renders grouped entries as buttons and direct entries as plain anchors", () => {
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const primary = screen.getByRole("navigation", { name: "主导航" });

    expect(within(primary).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "首页",
      "关于大赛",
      "赛事资讯"
    ]);
    for (const label of ["获奖查询", "联系我们"]) {
      expect(within(primary).getByRole("link", { name: label })).not.toHaveAttribute("aria-expanded");
    }
    expect(within(document.querySelector(".header-actions")).getByRole("link", { name: "报名入口" })).not.toHaveAttribute("aria-expanded");
  });

  it("closes the active drawer on Escape and restores its own trigger focus", () => {
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "赛事资讯" });

    fireEvent.click(trigger);
    expect(screen.getByRole("navigation", { name: "赛事资讯子导航" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("navigation", { name: "赛事资讯子导航" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the active drawer after an outside pointer down", () => {
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    fireEvent.click(screen.getByRole("button", { name: "首页" }));

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("navigation", { name: "首页子导航" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "首页" })).toHaveAttribute("aria-expanded", "false");
  });

  it("closes any drawer when the route changes", () => {
    const { rerender } = render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    fireEvent.click(screen.getByRole("button", { name: "关于大赛" }));

    rerender(<SiteHeader routeKey="/news?event=first" homeData={home} homeStatus="success" />);

    expect(screen.queryByRole("navigation", { name: "关于大赛子导航" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关于大赛" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps closing content inert until its transition finishes", () => {
    vi.useFakeTimers();
    installMatchMedia();
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    fireEvent.click(screen.getByRole("button", { name: "关于大赛" }));
    act(() => vi.advanceTimersByTime(16));
    const drawer = document.querySelector('[data-group-id="about"]');

    fireEvent.click(screen.getByRole("button", { name: "关于大赛" }));

    expect(drawer).toHaveAttribute("aria-hidden", "true");
    expect(drawer).toHaveAttribute("inert");
    expect(drawer).not.toHaveAttribute("hidden");
    act(() => vi.advanceTimersByTime(200));
    expect(drawer).toHaveAttribute("hidden");
  });

  it("hides a closed desktop drawer immediately when reduced motion is requested", () => {
    installMatchMedia({ reducedMotion: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "关于大赛" });
    fireEvent.click(trigger);
    const drawer = document.querySelector('[data-group-id="about"]');

    fireEvent.click(trigger);

    expect(drawer).toHaveAttribute("aria-hidden", "true");
    expect(drawer).toHaveAttribute("inert");
    expect(drawer).toHaveAttribute("hidden");
  });

  it("scopes drawer links to the selected event and marks the normalized location", () => {
    render(<SiteHeader routeKey="/news?event=second&page=2" homeData={home} homeStatus="success" />);
    fireEvent.click(screen.getByRole("button", { name: "赛事资讯" }));
    const drawer = screen.getByRole("navigation", { name: "赛事资讯子导航" });

    expect(within(drawer).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "通知公告",
      "新闻动态",
      "赛事回顾"
    ]);
    expect(within(drawer).getByRole("link", { name: "新闻动态" })).toHaveAttribute(
      "href",
      "/news?event=second"
    );
    expect(within(drawer).getByRole("link", { name: "新闻动态" })).toHaveAttribute("aria-current", "page");
  });
});

describe("mobile public navigation", () => {
  it("renders accordion groups, direct links, then login and registration actions", () => {
    installMatchMedia({ mobile: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    fireEvent.click(screen.getByRole("button", { name: "打开赛事导航" }));
    const mobileNavigation = screen.getByRole("navigation", { name: "移动端主导航" });

    expect(within(mobileNavigation).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "首页",
      "关于大赛",
      "赛事资讯"
    ]);
    expect(within(mobileNavigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "获奖查询",
      "联系我们"
    ]);
    const actions = document.querySelector(".mobile-navigation-actions");
    expect(within(actions).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "用户登录",
      "报名入口"
    ]);
  });

  it("expands only one mobile accordion group at a time", () => {
    installMatchMedia({ mobile: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    fireEvent.click(screen.getByRole("button", { name: "打开赛事导航" }));
    const mobileNavigation = screen.getByRole("navigation", { name: "移动端主导航" });
    const homeButton = within(mobileNavigation).getByRole("button", { name: "首页" });
    const aboutButton = within(mobileNavigation).getByRole("button", { name: "关于大赛" });

    fireEvent.click(homeButton);
    expect(homeButton).toHaveAttribute("aria-expanded", "true");
    expect(within(mobileNavigation).getByRole("link", { name: "报名流程" })).toBeVisible();
    fireEvent.click(aboutButton);

    expect(homeButton).toHaveAttribute("aria-expanded", "false");
    expect(aboutButton).toHaveAttribute("aria-expanded", "true");
    expect(within(mobileNavigation).queryByRole("link", { name: "报名流程" })).not.toBeInTheDocument();
    expect(within(mobileNavigation).getByRole("link", { name: "大赛章程" })).toBeVisible();
  });

  it("locks body scroll, contains focus and restores the hamburger after Escape", () => {
    installMatchMedia({ mobile: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "打开赛事导航" });
    fireEvent.click(trigger);
    const mobileNavigation = screen.getByRole("navigation", { name: "移动端主导航" });
    const firstControl = within(mobileNavigation).getByRole("button", { name: "首页" });

    expect(firstControl).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(within(document.querySelector(".mobile-navigation-actions")).getByRole("link", { name: "报名入口" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body.style.overflow).toBe("");
  });

  it("closes and releases the focus trap when the viewport crosses to desktop", () => {
    const { mobileQuery } = installMatchMedia({ mobile: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "打开赛事导航" });
    fireEvent.click(trigger);
    expect(document.body.style.overflow).toBe("hidden");

    act(() => mobileQuery.setMatches(false));

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "移动端主导航" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    act(() => mobileQuery.setMatches(true));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "移动端主导航" })).not.toBeInTheDocument();
  });
});
