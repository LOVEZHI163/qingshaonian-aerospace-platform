import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App.jsx";
import ServiceGrid from "../components/ServiceGrid.jsx";
import HomePage from "../pages/HomePage.jsx";

const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" }
});

const site = {
  platformName: "测试航空创新平台",
  platformIntro: "来自聚合接口的平台简介",
  organizers: ["测试主办单位"],
  contact: "0577-10000000",
  icp: "浙ICP备测试号",
  seoTitle: "测试航空创新平台",
  seoDescription: "测试描述",
  defaultHero: null,
  shareImage: null
};

function event(id, overrides = {}) {
  return {
    id,
    slug: `event-${id.toLowerCase()}`,
    name: `${id} 动态赛事名称`,
    theme: `${id} 动态赛事主题`,
    slogan: `${id} 动态宣传语`,
    summary: `${id} 动态赛事摘要`,
    dateLabel: `${id} 动态比赛日期`,
    venue: `${id} 动态比赛地点`,
    contact: `${id} 联系方式`,
    registrationStartAt: "2026-01-01T00:00:00.000Z",
    registrationEndAt: "2026-12-31T00:00:00.000Z",
    registrationMode: "force_open",
    status: "published",
    archivedAt: null,
    registrationWindow: { open: true },
    hero: {
      id: `hero-${id}`,
      url: `/api/public/media/hero-${id}?variant=original`,
      mobileUrl: `/api/public/media/hero-${id}?variant=mobile`,
      desktopUrl: `/api/public/media/hero-${id}?variant=desktop`,
      name: `${id} 封面.png`,
      mimeType: "image/png",
      width: 1600,
      height: 900
    },
    ...overrides
  };
}

function content(id, type, overrides = {}) {
  return {
    id,
    slug: `content-${id.toLowerCase()}`,
    eventId: "E1",
    eventSlug: "event-e1",
    type,
    title: `${id} 动态内容标题`,
    summary: `${id} 动态内容摘要`,
    publishAt: "2026-07-19T08:00:00.000Z",
    pinned: false,
    cover: null,
    ...overrides
  };
}

function services(eventId = "E1", overrides = {}) {
  const defaults = [
    ["registration", "报名中心", eventId ? `/admin/?view=registration&eventId=${eventId}` : "/history"],
    ["guide", "参赛指南", eventId ? `/events/event-${eventId.toLowerCase()}` : "/history"],
    ["results", "成绩查询", eventId ? `/admin/?view=records&eventId=${eventId}` : "/history"],
    ["certificates", "证书中心", eventId ? `/admin/?view=certificates&eventId=${eventId}` : "/history"]
  ];
  return defaults.map(([key, label, href]) => ({
    key,
    label,
    eventId,
    available: true,
    href,
    ...(overrides[key] || {})
  }));
}

function home(overrides = {}) {
  return {
    site,
    mode: "active",
    featuredEvent: event("E1"),
    concurrentEvents: [],
    services: services(),
    announcements: [content("公告一", "announcement")],
    news: [content("新闻一", "news")],
    works: [content("作品一", "work")],
    history: [content("回顾一", "recap", { publishAt: "2025-06-01T08:00:00.000Z" })],
    ...overrides
  };
}

describe("adaptive public home", () => {
  beforeEach(() => window.history.replaceState({}, "", "/"));

  it("uses a safe platform history state when zero events are available", () => {
    render(<HomePage data={home({
      mode: "history",
      featuredEvent: null,
      concurrentEvents: [],
      services: services(null, {
        registration: { eventId: null, available: false, href: "/history" },
        guide: { eventId: null, available: false, href: "/history" },
        results: { eventId: null, available: false, href: "/history" },
        certificates: { eventId: null, available: false, href: "/history" }
      })
    })} />);

    expect(screen.queryByText("报名中")).not.toBeInTheDocument();
    expect(screen.getByText("暂无开放报名")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看历届赛事" })).toHaveAttribute("href", "/history");
    expect(screen.queryByRole("link", { name: "立即报名" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/admin/?view=registration"]')).toBeNull();
    expect(screen.getByText("回顾一 动态内容标题")).toBeInTheDocument();
  });

  it("renders one featured event without an empty concurrent section and follows the media contract", () => {
    render(<HomePage data={home()} />);

    expect(screen.getByRole("heading", { name: "E1 动态赛事名称" })).toBeInTheDocument();
    expect(screen.getByText("E1 动态赛事主题")).toBeInTheDocument();
    expect(screen.getByText("E1 动态比赛日期")).toBeInTheDocument();
    expect(screen.getByText("E1 动态比赛地点")).toBeInTheDocument();
    expect(screen.getByText("报名中")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "立即报名" })).toHaveAttribute(
      "href",
      "/admin/?view=registration&eventId=E1"
    );
    expect(screen.queryByRole("heading", { name: "同期赛事" })).not.toBeInTheDocument();

    const picture = screen.getByRole("img", { name: "E1 动态赛事名称赛事封面" }).closest("picture");
    expect(picture).not.toBeNull();
    expect(picture.querySelector('source[media="(max-width: 767px)"]')).toHaveAttribute(
      "srcset",
      "/api/public/media/hero-E1?variant=mobile"
    );
    expect(picture.querySelector("source:not([media])")).toHaveAttribute(
      "srcset",
      "/api/public/media/hero-E1?variant=desktop"
    );
  });

  it.each([
    [2, 1],
    [3, 2]
  ])("renders %i active events as one feature plus %i unique concurrent cards", (total, concurrentCount) => {
    const featured = event("E1");
    const concurrent = Array.from({ length: total - 1 }, (_, index) => event(`E${index + 2}`));
    render(<HomePage data={home({
      featuredEvent: featured,
      concurrentEvents: [...concurrent, featured]
    })} />);

    const region = screen.getByRole("region", { name: "同期赛事" });
    expect(within(region).getAllByRole("article")).toHaveLength(concurrentCount);
    expect(within(region).queryByText("E1 动态赛事名称")).not.toBeInTheDocument();
    for (const row of concurrent) {
      expect(within(region).getByRole("heading", { name: row.name })).toBeInTheDocument();
    }
  });

  it("uses service availability and href from the API instead of recomputing registration state", () => {
    render(<HomePage data={home({
      services: services("E1", {
        registration: { available: false, href: "/history" }
      })
    })} />);

    const registration = screen.getByRole("article", { name: "报名中心" });
    expect(within(registration).getByText("暂无开放报名")).toBeInTheDocument();
    expect(within(registration).getByRole("link", { name: "查看历史赛事" })).toHaveAttribute("href", "/history");
    expect(within(registration).queryByRole("link", { name: "进入报名中心" })).not.toBeInTheDocument();
  });

  it.each([
    ["Admin URL without eventId", "/admin?view=registration", true],
    ["Admin URL with a different eventId", "/admin?view=registration&eventId=E2", true],
    ["slash Admin URL with a different eventId", "/admin/?view=registration&eventId=E2", true],
    ["protocol-relative external URL", "//attacker.example/admin?eventId=E1", true],
    ["absolute external URL", "https://attacker.example/admin?eventId=E1", true],
    ["javascript URL", "javascript:alert(1)", true],
    ["data URL", "data:text/html,unsafe", true],
    ["same-origin blob URL", `blob:${window.location.origin}/unsafe`, true],
    ["unavailable Admin URL", "/admin/?view=registration&eventId=E1", false]
  ])("falls back to history for an unsafe %s", (_label, href, available) => {
    render(<ServiceGrid services={[{
      key: "registration",
      label: "报名中心",
      eventId: "E1",
      available,
      href
    }]} />);

    const registration = screen.getByRole("article", { name: "报名中心" });
    const fallback = within(registration).getByRole("link", { name: "查看历史赛事" });
    expect(fallback).toHaveAttribute("href", "/history");
    expect(fallback).not.toHaveAttribute("data-router-ignore");
    expect(within(registration).queryByRole("link", { name: "进入报名中心" })).not.toBeInTheDocument();
  });

  it.each([
    "/admin?view=registration&eventId=E1",
    "/admin/?view=registration&eventId=E1"
  ])("accepts a same-origin event-scoped Admin target %s", (href) => {
    render(<ServiceGrid services={[{
      key: "registration",
      label: "报名中心",
      eventId: "E1",
      available: true,
      href
    }]} />);

    const link = screen.getByRole("link", { name: "进入报名中心" });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("data-router-ignore", "true");
  });

  it.each([
    "/events/event-e1",
    "/history",
    "/content/guide-e1"
  ])("keeps a legal same-origin public target %s inside the public router", (href) => {
    render(<ServiceGrid services={[{
      key: "guide",
      label: "参赛指南",
      eventId: "E1",
      available: true,
      href
    }]} />);

    const link = screen.getByRole("link", { name: "进入参赛指南" });
    expect(link).toHaveAttribute("href", href);
    expect(link).not.toHaveAttribute("data-router-ignore");
  });

  it("shows stable placeholders when hero and card images are missing or fail", () => {
    const brokenNews = content("新闻图片", "news", {
      cover: {
        id: "broken-cover",
        url: "/api/public/media/broken-cover?variant=original",
        name: "动态封面.png",
        mimeType: "image/png",
        width: 1200,
        height: 675
      }
    });
    render(<HomePage data={home({
      featuredEvent: event("E1", { hero: null }),
      news: [brokenNews]
    })} />);

    expect(screen.getByLabelText("E1 动态赛事名称暂无封面")).toBeInTheDocument();
    const image = screen.getByRole("img", { name: "新闻图片 动态内容标题封面" });
    fireEvent.error(image);
    expect(screen.getByLabelText("新闻图片 动态内容标题暂无封面")).toBeInTheDocument();
  });

  it("renders all sections and footer from the single home response", async () => {
    const payload = home();
    const request = vi.fn(async () => jsonResponse(payload));
    vi.stubGlobal("fetch", request);

    render(<App />);

    expect(await screen.findByText("公告一 动态内容标题")).toBeInTheDocument();
    expect(screen.getByText("新闻一 动态内容标题")).toBeInTheDocument();
    expect(screen.getByText("作品一 动态内容标题")).toBeInTheDocument();
    expect(screen.getByText("回顾一 动态内容标题")).toBeInTheDocument();
    expect(screen.getByText("来自聚合接口的平台简介")).toBeInTheDocument();
    expect(screen.getByText("测试主办单位")).toBeInTheDocument();
    expect(screen.getByText("0577-10000000")).toBeInTheDocument();
    expect(screen.getByText("浙ICP备测试号")).toBeInTheDocument();
    expect(request.mock.calls.filter(([url]) => url === "/api/public/home")).toHaveLength(1);
  });
});
