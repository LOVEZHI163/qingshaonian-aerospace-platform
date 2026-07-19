import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App.jsx";
import HomePage from "../pages/HomePage.jsx";

const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" }
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

  it("disables motion and transforms for reduced-motion users", () => {
    const styles = readFileSync(
      resolve(process.cwd(), "src/styles.css"),
      "utf8"
    );
    const reducedMotion = styles.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/)?.[1] || "";

    expect(reducedMotion).toMatch(/scroll-behavior:\s*auto\s*!important/);
    expect(reducedMotion).toMatch(/animation:\s*none\s*!important/);
    expect(reducedMotion).toMatch(/transition:\s*none\s*!important/);
    expect(reducedMotion).toMatch(/transform:\s*none\s*!important/);
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
});
