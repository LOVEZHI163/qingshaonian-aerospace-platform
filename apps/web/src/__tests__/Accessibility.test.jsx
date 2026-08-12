import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App.jsx";
import SiteHeader from "../components/SiteHeader.jsx";
import HomePage from "../pages/HomePage.jsx";

const navigationStyles = readFileSync(resolve(process.cwd(), "src/styles/navigation.css"), "utf8");

function mediaMatches(params, { width, reducedMotion = false }) {
  const maxWidth = params.match(/max-width:\s*(\d+)px/);
  const minWidth = params.match(/min-width:\s*(\d+)px/);
  if (maxWidth && width > Number(maxWidth[1])) return false;
  if (minWidth && width < Number(minWidth[1])) return false;
  if (/prefers-reduced-motion:\s*reduce/.test(params) && !reducedMotion) return false;
  return true;
}

function navigationStyleAt(selector, viewport) {
  const declarations = {};
  parse(navigationStyles).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const media = rule.parent?.type === "atrule" && rule.parent.name === "media" ? rule.parent.params : null;
    if (media && !mediaMatches(media, viewport)) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
  });
  return declarations;
}

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
  ...init
});

const emptyPage = {
  rows: [],
  pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 }
};

const homePayload = {
  site: {
    platformName: "温州市青少年航空航天创新比赛",
    seoTitle: "温州青少年航空航天赛事平台",
    seoDescription: "面向青少年的航空航天创新赛事平台"
  },
  mode: "active",
  featuredEvent: null,
  concurrentEvents: [],
  services: [],
  announcements: [],
  news: [],
  works: [],
  history: []
};

function apiPayload(url) {
  if (url === "/api/public/home") return homePayload;
  return emptyPage;
}

afterEach(() => vi.unstubAllEnvs());

describe("public site keyboard and semantics", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/news");
    vi.stubGlobal("fetch", vi.fn(async (url) => jsonResponse(apiPayload(url))));
  });

  it("offers a skip link and marks the current primary navigation item", async () => {
    render(<App />);

    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveAttribute("href", "#main-content");
    const primaryNavigation = screen.getByRole("navigation", { name: "主导航" });
    expect(within(primaryNavigation).getByRole("button", { name: "赛事资讯" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "用户登录" })).toHaveAttribute("href", "/admin/");
    expect(screen.getByRole("link", { name: "用户登录" })).toHaveAttribute("data-router-ignore", "true");
    expect(within(primaryNavigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "获奖查询",
      "联系我们"
    ]);
    expect(within(primaryNavigation).getByRole("button", { name: "首页" })).not.toHaveAttribute("aria-current");
    expect(within(primaryNavigation).getByRole("link", { name: "获奖查询" })).toHaveAttribute("data-router-ignore", "true");
    expect(within(document.querySelector(".header-actions")).getByRole("link", { name: "报名入口" })).toHaveAttribute("data-router-ignore", "true");
    expect(await screen.findByRole("heading", { name: "新闻动态" })).toBeInTheDocument();
  });

  it.each([
    ["/", "首页", "button"],
    ["/about", "关于大赛", "button"],
    ["/rules", "关于大赛", "button"],
    ["/registration-process", "首页", "button"],
    ["/projects", "关于大赛", "button"],
    ["/contact", "联系我们", "link"],
    ["/announcements", "赛事资讯", "button"],
    ["/news", "赛事资讯", "button"],
    ["/history", "赛事资讯", "button"]
  ])("marks the route family for %s as %s", (path, label, role) => {
    render(<SiteHeader routeKey={path} homeData={{}} homeStatus="empty" />);
    const primaryNavigation = screen.getByRole("navigation", { name: "主导航" });

    expect(within(primaryNavigation).getByRole(role, { name: label })).toHaveAttribute("aria-current", "page");
    const visiblePrimaryItems = [
      ...within(primaryNavigation).getAllByRole("button"),
      ...within(primaryNavigation).getAllByRole("link")
    ];
    expect(visiblePrimaryItems.filter((item) => item.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("moves focus into the opened mobile menu and returns it after Escape", () => {
    render(<App />);
    const trigger = screen.getByRole("button", { name: "打开赛事导航" });

    fireEvent.click(trigger);
    const mobileNavigation = screen.getByRole("navigation", { name: "移动端主导航" });
    expect(within(mobileNavigation).getByRole("button", { name: "首页" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the account login available before registration in the mobile menu", () => {
    render(<SiteHeader routeKey="/" homeData={{}} homeStatus="empty" />);

    fireEvent.click(screen.getByRole("button", { name: "打开赛事导航" }));

    const actions = document.querySelector(".mobile-navigation-actions");
    const login = within(actions).getByRole("link", { name: "用户登录" });
    const registration = within(actions).getByRole("link", { name: "报名入口" });
    expect(login).toHaveAttribute("href", "/admin/");
    expect(login).toHaveAttribute("data-router-ignore", "true");
    expect(registration).toHaveAttribute("href", "/admin/?view=eventCenter");
    expect(registration).toHaveAttribute("data-router-ignore", "true");
    expect(login.compareDocumentPosition(registration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps desktop navigation before the login and registration action group in keyboard order", () => {
    render(<SiteHeader routeKey="/" homeData={{}} homeStatus="empty" />);

    const siteNavigation = document.querySelector(".site-navigation");
    const primaryNavigation = within(siteNavigation).getByRole("navigation", { name: "主导航" });
    const actions = siteNavigation.querySelector(".header-actions");
    const login = within(actions).getByRole("link", { name: "用户登录" });
    const registration = within(actions).getByRole("link", { name: "报名入口" });
    const primaryTabStops = [...primaryNavigation.querySelectorAll("a[href], button:not([disabled])")];
    const desktopTabStops = [...siteNavigation.querySelectorAll("a[href], button:not([disabled])")];

    expect(within(primaryNavigation).queryByRole("link", { name: "报名入口" })).not.toBeInTheDocument();
    expect([...actions.querySelectorAll("a[href]")]).toEqual([login, registration]);
    expect(primaryNavigation.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(desktopTabStops).toEqual([...primaryTabStops, login, registration]);
    expect(desktopTabStops.every((element) => element.tabIndex === 0)).toBe(true);
  });

  it("computes a three-part desktop header and anchors each bounded drawer to its trigger item", () => {
    render(<SiteHeader routeKey="/" homeData={{}} homeStatus="empty" />);

    const header = navigationStyleAt(".site-header-inner", { width: 1440 });
    const brand = navigationStyleAt(".brand", { width: 1440 });
    const navigation = navigationStyleAt(".primary-navigation-links", { width: 1440 });
    const actions = navigationStyleAt(".header-actions", { width: 1440 });
    const mobileBrand = navigationStyleAt(".mobile-brand-name", { width: 1440 });
    const menuTrigger = navigationStyleAt(".menu-trigger", { width: 1440 });
    const primaryLink = navigationStyleAt(".primary-navigation-links > a", { width: 1440 });
    const primaryTrigger = navigationStyleAt(".primary-navigation-trigger", { width: 1440 });
    const drawer = navigationStyleAt(".public-mega-drawer", { width: 1440 });
    const drawerInner = navigationStyleAt(".public-mega-drawer-inner", { width: 1440 });
    const drawerLink = navigationStyleAt(".public-mega-drawer a", { width: 1440 });

    expect(header.display).toBe("grid");
    expect(header.width).toBe("min(var(--content-max), calc(100% - 2.5rem))");
    expect(brand["grid-row"]).toBe("1");
    expect(navigation["grid-row"]).toBe("1");
    expect(actions["grid-row"]).toBe("1");
    expect(navigation.display).toBe("flex");
    expect(navigation.gap).toBe("2rem");
    expect(actions.display).toBe("flex");
    expect(mobileBrand.display).toBe("none");
    expect(menuTrigger.display).toBe("none");
    expect(primaryLink["font-size"]).toBe("1rem");
    expect(primaryLink["font-weight"]).toBe("700");
    expect(primaryTrigger["font-size"]).toBe("1rem");
    expect(primaryTrigger["font-weight"]).toBe("700");
    expect(drawer.position).toBe("absolute");
    expect(drawer["inline-size"]).toBe("9.5rem");
    expect(drawer["max-inline-size"]).toBe("min(22rem, calc(100vw - 2rem))");
    expect(drawerInner.padding).toBe("0.25rem");
    expect(drawerLink["min-width"]).toBe("0");
    expect(drawerLink.width).toBe("100%");
    expect(drawerLink["min-height"]).toBe("2.75rem");
    expect(drawerLink["justify-content"]).toBe("center");
    expect(drawerLink["text-align"]).toBe("center");
    expect(drawerLink["font-size"]).toBe("1rem");
    expect(drawerLink["font-weight"]).toBe("600");

    for (const trigger of screen.getAllByRole("button", { expanded: false }).filter((button) => button.classList.contains("primary-navigation-trigger"))) {
      const item = trigger.closest(".primary-navigation-item");
      expect(item).not.toBeNull();
      expect(item.querySelector(`#${trigger.getAttribute("aria-controls")}`)).not.toBeNull();
    }
  });

  it("computes a complete, scrollable and inline-safe mobile navigation at 390px", () => {
    render(<SiteHeader routeKey="/" homeData={{}} homeStatus="empty" />);

    const desktopNavigation = navigationStyleAt(".site-navigation", { width: 390 });
    const mobileBrand = navigationStyleAt(".mobile-brand-name", { width: 390 });
    const menuTrigger = navigationStyleAt(".menu-trigger", { width: 390 });
    const mobilePanel = navigationStyleAt(".public-mobile-navigation", { width: 390 });
    const visibleMobilePanel = navigationStyleAt(".public-mobile-navigation:not([hidden])", { width: 390 });

    expect(desktopNavigation.display).toBe("none");
    expect(mobileBrand.display).toBe("block");
    expect(menuTrigger.display).toBe("grid");
    expect(visibleMobilePanel.display).toBe("block");
    expect(mobilePanel["max-inline-size"]).toBe("100vw");
    expect(mobilePanel["max-block-size"]).toBe("calc(100dvh - 72px)");
    expect(mobilePanel["overflow-x"]).toBe("hidden");
    expect(mobilePanel["overflow-y"]).toBe("auto");
    expect(document.querySelectorAll("#public-mobile-navigation nav > a")).toHaveLength(2);
  });

  it("keeps navigation targets at least 44px and removes navigation motion on request", () => {
    const desktopTrigger = navigationStyleAt(".primary-navigation-trigger", { width: 1440 });
    const mobileLink = navigationStyleAt(".public-mobile-navigation a", { width: 390 });
    const drawerReduced = navigationStyleAt(".public-mega-drawer", { width: 1440, reducedMotion: true });
    const actionReduced = navigationStyleAt(".login-link:hover", { width: 1440, reducedMotion: true });

    expect(desktopTrigger["min-height"]).toBe("2.75rem");
    expect(mobileLink["min-height"]).toBe("2.75rem");
    expect(drawerReduced.transition).toBe("none");
    expect(actionReduced.transform).toBe("none");
  });

  it("keeps the desktop wordmark inside its grid track and the primary action legible", () => {
    const brand = navigationStyleAt(".brand", { width: 1440 });
    const wordmark = navigationStyleAt(".brand-wordmark", { width: 1440 });
    const registration = navigationStyleAt(".header-actions > .registration-link", { width: 1440 });

    expect(brand["max-width"]).toBe("100%");
    expect(brand.overflow).toBe("hidden");
    expect(wordmark.flex).toBe("1 1 auto");
    expect(wordmark["min-width"]).toBe("0");
    expect(registration.color).toBe("var(--color-brand-ink)");
    expect(registration.background).toBe("var(--color-white)");
  });

  it("keeps controls named, loading status announced and images meaningful", () => {
    const data = {
      ...homePayload,
      featuredEvent: {
        id: "event-1",
        slug: "event-1",
        name: "纸飞机挑战赛",
        registrationWindow: { open: false },
        hero: { url: "/hero.png" }
      },
      news: [{
        id: "news-1",
        slug: "news-1",
        title: "赛事新闻",
        cover: { url: "/news.png" }
      }]
    };
    render(<HomePage data={data} />);

    expect(screen.getByRole("img", { name: "纸飞机挑战赛赛事封面" })).toHaveAttribute("fetchpriority", "high");
    expect(screen.getByRole("img", { name: "赛事新闻封面" })).toHaveAttribute("loading", "lazy");
    for (const button of screen.queryAllByRole("button")) {
      expect(button.getAttribute("aria-label") || button.textContent.trim()).not.toBe("");
    }
  });

  it("disables real animation while preserving the skip link reveal transform", () => {
    const styles = readFileSync(
      resolve(process.cwd(), "src/styles.css"),
      "utf8"
    );
    const homeStyles = readFileSync(resolve(process.cwd(), "src/styles/home.css"), "utf8");
    const reducedMotion = styles.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/)?.[1] || "";

    expect(styles).toMatch(/\.skip-link\s*\{[\s\S]*transform:\s*translateY\(-180%\)/);
    expect(styles).toMatch(/\.skip-link:focus\s*\{\s*transform:\s*translateY\(0\)/);
    expect(reducedMotion).toMatch(/scroll-behavior:\s*auto\s*!important/);
    expect(reducedMotion).toMatch(/animation:\s*none\s*!important/);
    expect(reducedMotion).toMatch(/transition:\s*none\s*!important/);
    expect(reducedMotion).not.toMatch(/\*[^}]*transform:\s*none\s*!important/);
    expect(homeStyles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.button:hover\s*\{[^}]*transform:\s*none\s*!important/);
  });

  it("preserves the poster composition and exposes actions without hover-only access", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
    const homeStyles = readFileSync(resolve(process.cwd(), "src/styles/home.css"), "utf8");

    expect(tokens).toMatch(/--color-brand:\s*#155add/i);
    expect(tokens).toMatch(/--color-brand-deep:\s*#07185e/i);
    expect(tokens).toMatch(/--color-brand-accent:\s*#6e35e7/i);
    expect(homeStyles).toMatch(/\.featured-event-media img\s*\{[^}]*object-fit:\s*contain/);
    expect(homeStyles).toMatch(/\.featured-event-poster:hover\s+\.featured-event-interaction/);
    expect(homeStyles).toMatch(/\.featured-event-poster:focus-within\s+\.featured-event-interaction/);
    expect(homeStyles).toMatch(/@media\s*\(hover:\s*none\)[\s\S]*\.featured-event-interaction\s*\{[^}]*position:\s*relative/);
    expect(homeStyles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.featured-event-interaction\s*\{[^}]*transition:\s*none/);
  });

  it("aligns desktop poster copy with the lower safe area and resets it on mobile", () => {
    const homeStyles = readFileSync(resolve(process.cwd(), "src/styles/home.css"), "utf8");
    const copyRule = homeStyles.match(/(?:^|\n)\.featured-event-copy\s*\{([^}]*)\}/)?.[1] || "";
    const headingRule = homeStyles.match(/(?:^|\n)\.featured-event h2\s*\{([^}]*)\}/)?.[1] || "";
    const mobileRules = homeStyles.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

    expect(copyRule).toMatch(/transform:\s*translateY\(clamp\(2rem,\s*3vw,\s*3rem\)\)/);
    expect(headingRule).toMatch(/font-size:\s*clamp\(1\.625rem,\s*3vw,\s*3rem\)/);
    expect(mobileRules).toMatch(/\.featured-event-copy\s*\{[^}]*transform:\s*none/);
  });

  it("gives mobile text links a real 44px touch box", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/home.css"), "utf8");
    const textLinkRule = styles.match(/(?:^|\n)\.text-link\s*\{([^}]*)\}/)?.[1] || "";
    const mobileRules = styles.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
    render(<HomePage data={{
      ...homePayload,
      announcements: [{ id: "notice-1", slug: "notice-1", title: "测试公告" }]
    }} />);

    expect(screen.getByRole("link", { name: /查看全部/ })).toHaveClass("text-link");
    expect(textLinkRule).toMatch(/display:\s*inline-(?:flex|block)/);
    expect(mobileRules).toMatch(/\.button,\s*\.text-link\s*\{[^}]*min-height:\s*44px/);
  });

  it("keeps the preview banner visible, wrapping and clear of focused content", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const bannerRule = styles.match(/\.preview-banner\s*\{([^}]*)\}/)?.[1] || "";
    const mobileRules = styles.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

    expect(bannerRule).toMatch(/position:\s*sticky/);
    expect(bannerRule).toMatch(/flex-wrap:\s*wrap/);
    expect(bannerRule).toMatch(/color:\s*var\(--color-white\)/);
    expect(bannerRule).not.toMatch(/animation|transition/);
    expect(styles).toMatch(/\.preview-page\s+:focus-visible\s*\{[^}]*scroll-margin-top:/);
    expect(mobileRules).toMatch(/\.preview-banner\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(mobileRules).toMatch(/\.preview-banner\s+a\s*\{[^}]*min-height:\s*44px/);
  });

  it("cleans stale assets before producing route chunks", () => {
    const config = readFileSync(resolve(process.cwd(), "vite.config.js"), "utf8");
    expect(config).toMatch(/emptyOutDir:\s*true/);
  });
});

describe("public site SEO", () => {
  beforeEach(() => {
    document.title = "初始标题";
    document.head.querySelectorAll('[data-public-seo="true"]').forEach((node) => node.remove());
  });

  it.each([
    ["/", "温州青少年航空航天赛事平台"],
    ["/announcements", "通知公告"],
    ["/news", "新闻动态"],
    ["/history", "历届赛事"]
  ])("updates metadata for the public route %s", async (path, title) => {
    vi.stubEnv("VITE_PUBLIC_SITE_URL", "https://aerogp.cn/");
    window.history.replaceState({}, "", path);
    vi.stubGlobal("fetch", vi.fn(async (url) => jsonResponse(apiPayload(url))));

    render(<App />);
    await waitFor(() => expect(document.title).toBe(title));
    expect(document.head.querySelector('meta[name="description"]')?.content).toBeTruthy();
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute("href", `https://aerogp.cn${path}`);
    expect(document.head.querySelector('meta[property="og:title"]')).toHaveAttribute("content", title);
    expect(document.head.querySelector('meta[property="og:description"]')?.content).toBeTruthy();
    expect(document.head.querySelector('meta[property="og:url"]')).toHaveAttribute("content", `https://aerogp.cn${path}`);
  });

  it("omits canonical and absolute Open Graph URLs when no public origin is configured", async () => {
    vi.stubEnv("VITE_PUBLIC_SITE_URL", "");
    window.history.replaceState({}, "", "/news");
    vi.stubGlobal("fetch", vi.fn(async (url) => jsonResponse(apiPayload(url))));

    render(<App />);
    await waitFor(() => expect(document.title).toBe("新闻动态"));
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.head.querySelector('meta[property="og:url"]')).toBeNull();
  });

  it("keeps useful home metadata when the bootstrap request fails", async () => {
    vi.stubEnv("VITE_PUBLIC_SITE_URL", "https://aerogp.cn");
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));

    render(<App />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(document.title).toBe("温州市青少年航空航天创新比赛");
    expect(document.head.querySelector('meta[name="description"]')?.content).toContain("航空航天");
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute("href", "https://aerogp.cn/");
  });

  it.each([
    [
      "/events/summer-cup",
      "/api/public/events/summer-cup",
      { event: { id: "E1", slug: "summer-cup", name: "暑期航空挑战赛", summary: "赛事详情摘要", hero: { url: "/event-share.webp" }, registrationWindow: { open: false } }, projects: [], groups: [], resources: [], content: [] },
      "暑期航空挑战赛",
      "赛事详情摘要",
      "website",
      "https://aerogp.cn/event-share.webp"
    ],
    [
      "/content/opening-notice",
      "/api/public/content/opening-notice",
      { row: { id: "C1", slug: "opening-notice", title: "报名开放公告", summary: "公告详情摘要", cover: { url: "/notice-share.webp" }, bodyHtml: "", attachments: [] } },
      "报名开放公告",
      "公告详情摘要",
      "article",
      "https://aerogp.cn/notice-share.webp"
    ]
  ])("sets dynamic detail metadata for %s", async (path, apiPath, detailPayload, title, description, type, image) => {
    vi.stubEnv("VITE_PUBLIC_SITE_URL", "https://aerogp.cn");
    window.history.replaceState({}, "", path);
    vi.stubGlobal("fetch", vi.fn(async (url) => jsonResponse(url === "/api/public/home" ? homePayload : url === apiPath ? detailPayload : emptyPage)));

    render(<App />);
    await waitFor(() => expect(document.title).toBe(title));
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute("content", description);
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute("href", `https://aerogp.cn${path}`);
    expect(document.head.querySelector('meta[property="og:title"]')).toHaveAttribute("content", title);
    expect(document.head.querySelector('meta[property="og:description"]')).toHaveAttribute("content", description);
    expect(document.head.querySelector('meta[property="og:type"]')).toHaveAttribute("content", type);
    expect(document.head.querySelector('meta[property="og:url"]')).toHaveAttribute("content", `https://aerogp.cn${path}`);
    expect(document.head.querySelector('meta[property="og:image"]')).toHaveAttribute("content", image);
  });

  it.each([
    [
      "/events/foo/",
      "/api/public/events/foo",
      { event: { id: "E1", slug: "foo", name: "尾斜杠赛事", registrationWindow: { open: false } }, projects: [], groups: [], resources: [], content: [] },
      "尾斜杠赛事",
      "https://aerogp.cn/events/foo"
    ],
    [
      "/content/foo/",
      "/api/public/content/foo",
      { row: { id: "C1", slug: "foo", title: "尾斜杠内容", bodyHtml: "", attachments: [] } },
      "尾斜杠内容",
      "https://aerogp.cn/content/foo"
    ]
  ])("normalizes the detail canonical for %s from the stable slug", async (path, apiPath, payload, title, canonical) => {
    vi.stubEnv("VITE_PUBLIC_SITE_URL", "https://aerogp.cn");
    window.history.replaceState({}, "", path);
    vi.stubGlobal("fetch", vi.fn(async (url) => jsonResponse(
      url === "/api/public/home" ? homePayload : url === apiPath ? payload : emptyPage
    )));

    render(<App />);

    await waitFor(() => expect(document.title).toBe(title));
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute("href", canonical);
    expect(document.head.querySelector('meta[property="og:url"]')).toHaveAttribute("content", canonical);
  });

  it.each([
    ["/missing", null, 200, "页面未找到", "您访问的页面不存在。"],
    ["/events/missing", "/api/public/events/missing", 404, "赛事不存在", "该赛事可能尚未公开或已经停止展示。"],
    ["/content/missing", "/api/public/content/missing", 404, "内容不存在", "该内容可能尚未发布或已经停止展示。"],
    ["/events/broken", "/api/public/events/broken", 500, "赛事详情", "查看赛事介绍、时间地点、赛项组别和报名信息。"],
    ["/content/broken", "/api/public/content/broken", 500, "内容详情", "查看通知公告与新闻动态详情。"]
  ])("keeps complete non-stale metadata for error route %s", async (path, apiPath, status, title, description) => {
    vi.stubEnv("VITE_PUBLIC_SITE_URL", "https://aerogp.cn");
    window.history.replaceState({}, "", path);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/api/public/home") return jsonResponse(homePayload);
      if (url === apiPath) return jsonResponse({ message: "不可用" }, { status });
      return jsonResponse(emptyPage);
    }));

    render(<App />);
    await waitFor(() => expect(document.title).toBe(title));
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute("content", description);
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute("href", `https://aerogp.cn${path}`);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[property="og:description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[property="og:url"]')).toHaveLength(1);
  });

  it("removes the previous route metadata after History API navigation", async () => {
    vi.stubEnv("VITE_PUBLIC_SITE_URL", "https://aerogp.cn");
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn(async (url) => jsonResponse(apiPayload(url))));

    render(<App />);
    await waitFor(() => expect(document.title).toBe("温州青少年航空航天赛事平台"));
    fireEvent.click(screen.getByRole("button", { name: "打开赛事导航" }));
    const mobileNavigation = screen.getByRole("navigation", { name: "移动端主导航" });
    fireEvent.click(within(mobileNavigation).getByRole("button", { name: "赛事资讯" }));
    fireEvent.click(within(mobileNavigation).getByRole("link", { name: "通知公告" }));
    await waitFor(() => expect(document.title).toBe("通知公告"));

    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute("content", "查看平台及赛事最新通知。");
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute("href", "https://aerogp.cn/announcements");
    expect(document.head.querySelectorAll('meta[property^="og:"]')).toHaveLength(4);
    expect(document.head.querySelector('meta[property="og:title"]')).toHaveAttribute("content", "通知公告");
    expect(document.head.querySelector('meta[property="og:image"]')).toBeNull();
  });
});
