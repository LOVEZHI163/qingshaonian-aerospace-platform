import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App.jsx";
import HomePage from "../pages/HomePage.jsx";

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
    expect(screen.getByRole("link", { name: "动态与作品" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "首页" })).not.toHaveAttribute("aria-current");
    expect(await screen.findByRole("heading", { name: "动态与优秀作品" })).toBeInTheDocument();
  });

  it("moves focus into the opened mobile menu and returns it after Escape", () => {
    render(<App />);
    const trigger = screen.getByRole("button", { name: "打开导航菜单" });

    fireEvent.click(trigger);
    expect(screen.getByRole("link", { name: "首页" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
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
    ["/announcements", "赛事公告"],
    ["/news", "动态与优秀作品"],
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
    await waitFor(() => expect(document.title).toBe("动态与优秀作品"));
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
    ["/missing", null, 200, "页面未找到", "您访问的页面不存在。"],
    ["/events/missing", "/api/public/events/missing", 404, "赛事不存在", "该赛事可能尚未公开或已经停止展示。"],
    ["/content/missing", "/api/public/content/missing", 404, "内容不存在", "该内容可能尚未发布或已经停止展示。"],
    ["/events/broken", "/api/public/events/broken", 500, "赛事详情", "查看赛事介绍、时间地点、赛项组别和报名信息。"],
    ["/content/broken", "/api/public/content/broken", 500, "内容详情", "查看赛事公告、动态与优秀作品详情。"]
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
    fireEvent.click(screen.getByRole("link", { name: "公告" }));
    await waitFor(() => expect(document.title).toBe("赛事公告"));

    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute("content", "查看平台及赛事最新通知。");
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute("href", "https://aerogp.cn/announcements");
    expect(document.head.querySelectorAll('meta[property^="og:"]')).toHaveLength(4);
    expect(document.head.querySelector('meta[property="og:title"]')).toHaveAttribute("content", "赛事公告");
    expect(document.head.querySelector('meta[property="og:image"]')).toBeNull();
  });
});
