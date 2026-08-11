import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SiteHeader from "../components/SiteHeader.jsx";

const first = {
  id: "event-first",
  slug: "first",
  name: "第一届航空挑战赛",
  theme: "逐梦蓝天"
};

const second = {
  id: "event-second",
  slug: "second",
  name: "第二届航空挑战赛",
  slogan: "探索无界"
};

const home = {
  featuredEvent: first,
  concurrentEvents: [second, first, { id: "draft-without-slug", name: "未公开赛事" }]
};

function createMediaQueryList(media, initialMatches) {
  let matches = initialMatches;
  const listeners = new Set();
  const query = {
    media,
    onchange: null,
    get matches() { return matches; },
    addEventListener: vi.fn((type, listener) => {
      if (type === "change") listeners.add(listener);
    }),
    removeEventListener: vi.fn((type, listener) => {
      if (type === "change") listeners.delete(listener);
    }),
    addListener: vi.fn((listener) => listeners.add(listener)),
    removeListener: vi.fn((listener) => listeners.delete(listener)),
    dispatchEvent: vi.fn(),
    setMatches(nextMatches) {
      matches = nextMatches;
      const event = { matches, media };
      listeners.forEach((listener) => listener(event));
      query.onchange?.(event);
    }
  };
  return query;
}

function installMatchMedia({ hover = false, mobile = false } = {}) {
  const hoverQuery = createMediaQueryList("(hover: hover) and (pointer: fine)", hover);
  const mobileQuery = createMediaQueryList("(max-width: 1120px)", mobile);
  vi.stubGlobal("matchMedia", vi.fn((media) => media === mobileQuery.media ? mobileQuery : hoverQuery));
  return { hoverQuery, mobileQuery };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("public mega drawer interactions", () => {
  it("opens from hover, waits before closing, and cancels closing on re-entry", () => {
    vi.useFakeTimers();
    installMatchMedia({ hover: true });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    const zone = screen.getByTestId("public-navigation-zone");

    fireEvent.mouseEnter(zone);
    expect(screen.getByRole("navigation", { name: "赛事导航" })).toBeVisible();
    fireEvent.mouseLeave(zone);
    act(() => vi.advanceTimersByTime(299));
    expect(screen.getByRole("navigation", { name: "赛事导航" })).toBeVisible();
    fireEvent.mouseEnter(zone);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("navigation", { name: "赛事导航" })).toBeVisible();

    fireEvent.mouseLeave(zone);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("navigation", { name: "赛事导航" })).not.toBeInTheDocument();
  });

  it("ignores incidental mouse events when the device cannot hover with a fine pointer", () => {
    installMatchMedia({ hover: false });
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);

    fireEvent.mouseEnter(screen.getByTestId("public-navigation-zone"));

    expect(screen.getByRole("button", { name: "打开赛事导航" })).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("public-mega-drawer")).toHaveAttribute("hidden");
  });

  it("locks the drawer by click and closes on outside pointer down", () => {
    vi.useFakeTimers();
    render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
    fireEvent.click(screen.getByRole("button", { name: "打开赛事导航" }));

    expect(screen.getByRole("button", { name: "关闭赛事导航" })).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("public-mega-drawer")).toHaveAttribute("aria-hidden", "false");
    expect(document.getElementById("public-mega-drawer")).not.toHaveAttribute("hidden");
    fireEvent.mouseLeave(screen.getByTestId("public-navigation-zone"));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("button", { name: "关闭赛事导航" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("button", { name: "打开赛事导航" })).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("public-mega-drawer")).toHaveAttribute("aria-hidden", "true");
    expect(document.getElementById("public-mega-drawer")).toHaveAttribute("hidden");
  });

  it("returns focus after Escape and exposes links for the selected event", () => {
    render(<SiteHeader routeKey="/about?event=second" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "打开赛事导航" });
    fireEvent.click(trigger);

    expect(screen.getByRole("link", { name: "大赛简介" })).toHaveAttribute("href", "/about?event=second");
    expect(screen.getByRole("link", { name: "成绩查询" })).toHaveAttribute(
      "href",
      "/admin/?view=records&eventId=event-second"
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("moves focus into the drawer after an explicit open but not after hover", () => {
    installMatchMedia({ hover: true });
    render(
      <>
        <button type="button">焦点哨兵</button>
        <SiteHeader routeKey="/" homeData={home} homeStatus="success" />
      </>
    );
    const sentinel = screen.getByRole("button", { name: "焦点哨兵" });
    sentinel.focus();

    fireEvent.mouseEnter(screen.getByTestId("public-navigation-zone"));
    expect(sentinel).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "固定赛事导航" }));

    const drawerNavigation = screen.getByRole("navigation", { name: "赛事导航" });
    expect(within(drawerNavigation).getAllByRole("link")[0]).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "关闭赛事导航" }));
    expect(screen.getByRole("button", { name: "打开赛事导航" })).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("public-mega-drawer")).toHaveAttribute("hidden");
  });

  it("synchronizes body scrolling when an open menu crosses the mobile breakpoint", () => {
    const { mobileQuery } = installMatchMedia({ mobile: false });
    document.body.style.overflow = "clip";
    const { unmount } = render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);

    fireEvent.click(screen.getByRole("button", { name: "打开赛事导航" }));
    expect(document.body.style.overflow).toBe("clip");
    act(() => mobileQuery.setMatches(true));
    expect(document.body.style.overflow).toBe("hidden");
    act(() => mobileQuery.setMatches(false));
    expect(document.body.style.overflow).toBe("clip");
    unmount();
    expect(document.body.style.overflow).toBe("clip");
  });

  it("renders approved groups, scoped active links, event choices and account entries", () => {
    render(<SiteHeader routeKey="/news?event=second&type=work&page=2" homeData={home} homeStatus="success" />);
    const trigger = screen.getByRole("button", { name: "打开赛事导航" });
    expect(trigger).toHaveAttribute("aria-controls", "public-mega-drawer");
    fireEvent.click(trigger);

    const drawerNavigation = screen.getByRole("navigation", { name: "赛事导航" });
    expect(within(drawerNavigation).getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual([
      "赛事服务",
      "关于大赛",
      "赛事资讯"
    ]);
    expect(within(drawerNavigation).getByRole("link", { name: "新闻动态" })).not.toHaveAttribute("aria-current");
    expect(within(drawerNavigation).getByRole("link", { name: "优秀作品" })).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("link", { name: "赛事资讯" })).toHaveAttribute("aria-current", "page");
    expect(within(drawerNavigation).getByRole("link", { name: "证书查询" })).toHaveAttribute(
      "href",
      "/admin/?view=certificates&eventId=event-second"
    );
    expect(within(drawerNavigation).getByRole("link", { name: "证书查询" })).toHaveAttribute(
      "data-router-ignore",
      "true"
    );
    expect(screen.getByText("探索无界")).toBeInTheDocument();

    const switcher = screen.getByLabelText("切换赛事");
    expect(within(switcher).getAllByRole("link")).toHaveLength(2);
    expect(within(switcher).getByRole("link", { name: "第一届航空挑战赛" })).toHaveAttribute(
      "href",
      "/about?event=first"
    );
    expect(within(switcher).getByRole("link", { name: "第二届航空挑战赛" })).toHaveAttribute(
      "href",
      "/about?event=second"
    );
    expect(within(switcher).getByRole("link", { name: "第一届航空挑战赛" })).not.toHaveAttribute("aria-current");
    const currentEventLink = within(switcher).getByRole("link", { name: "第二届航空挑战赛" });
    expect(currentEventLink).toHaveAttribute("aria-current", "page");
    currentEventLink.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(currentEventLink);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("public-mega-drawer")).toHaveAttribute("hidden");
  });

  it("uses the implicitly selected featured event when matching the current drawer link", () => {
    render(<SiteHeader routeKey="/news" homeData={home} homeStatus="success" />);
    fireEvent.click(screen.getByRole("button", { name: "打开赛事导航" }));

    const drawerNavigation = screen.getByRole("navigation", { name: "赛事导航" });
    expect(within(drawerNavigation).getByRole("link", { name: "新闻动态" })).toHaveAttribute("aria-current", "page");
    expect(within(drawerNavigation).getByRole("link", { name: "优秀作品" })).not.toHaveAttribute("aria-current");
  });

  it("uses the approved fallback copy and closes after an internal drawer link", () => {
    render(<SiteHeader routeKey="/" homeData={{}} homeStatus="empty" />);
    const trigger = screen.getByRole("button", { name: "打开赛事导航" });
    fireEvent.click(trigger);

    expect(screen.getByText("科技强国，未来有我")).toBeInTheDocument();
    expect(screen.getByText("温州少航赛事平台")).toBeInTheDocument();
    const aboutLink = screen.getByRole("link", { name: "大赛简介" });
    aboutLink.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(aboutLink);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
