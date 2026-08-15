import React from "react";
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("public event page", () => {
  beforeEach(() => window.history.replaceState({}, "", "/events/wenzhou-2026"));

  it("continues to fetch the public event detail API", async () => {
    const request = installApi({
      "/api/public/events/wenzhou-2026": {
        event: event(), projects: [], groups: [], resources: [], content: []
      }
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "2026温州市青少年航空航天创新比赛" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "/api/public/events/wenzhou-2026",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

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
          content("WORK", "work"),
          content("RECAP", "recap"),
          content("SPECIAL", "special"),
          content("TOSTRING", "toString"),
          content("CONSTRUCTOR", "constructor")
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
    const eventContent = screen.getByRole("heading", { name: "赛事内容" }).closest("section");
    for (const label of ["通知公告", "新闻动态", "赛事回顾"]) {
      expect(within(eventContent).getByText(label)).toBeInTheDocument();
    }
    expect(within(eventContent).queryByText("优秀作品")).not.toBeInTheDocument();
    expect(within(eventContent).queryByText("work-WORK 标题")).not.toBeInTheDocument();
    expect(within(eventContent).getByText("special")).toBeInTheDocument();
    expect(within(eventContent).getByText("toString")).toBeInTheDocument();
    expect(within(eventContent).getByText("constructor")).toBeInTheDocument();
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

  it("trusts an open public registration window without re-deriving event status", async () => {
    installApi({
      "/api/public/events/wenzhou-2026": {
        event: event({ status: "offline", registrationWindow: { open: true, reason: "管理员临时开放" } }),
        projects: [], groups: [], resources: [], content: []
      }
    });

    render(<App />);
    expect(await screen.findByRole("link", { name: "立即报名" })).toHaveAttribute(
      "href",
      "/admin/?view=registration&eventId=E-2026"
    );
    expect(screen.getByText("管理员临时开放")).toBeInTheDocument();
  });

  it("never creates registration, result or certificate links without a real event id", async () => {
    installApi({
      "/api/public/events/wenzhou-2026": {
        event: event({ id: null, registrationWindow: { open: true, reason: "报名开放中" } }),
        projects: [], groups: [], resources: [], content: []
      }
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "2026温州市青少年航空航天创新比赛" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "立即报名" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查询成绩" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查询证书" })).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("eventId=undefined");
    expect(document.body.innerHTML).not.toContain("eventId=null");
  });

  it("never creates deep links from an invalid event id", async () => {
    installApi({
      "/api/public/events/wenzhou-2026": {
        event: event({ id: "<script>", registrationWindow: { open: true, reason: "报名开放中" } }),
        projects: [], groups: [], resources: [], content: []
      }
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "2026温州市青少年航空航天创新比赛" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "立即报名" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查询成绩" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查询证书" })).not.toBeInTheDocument();
  });
});

describe("public event information page", () => {
  beforeEach(() => window.history.replaceState({}, "", "/projects"));

  it("uses the selected event poster as a decorative information-page hero", async () => {
    window.history.replaceState({}, "", "/about?event=wenzhou-2026");
    const selectedEvent = event();
    installApi({
      "/api/public/events/wenzhou-2026": {
        event: selectedEvent, projects: [], groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: selectedEvent }));

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "大赛简介" })).toBeInTheDocument();
    const media = document.querySelector(".event-information-hero-media");
    expect(media).toHaveAttribute("aria-hidden", "true");
    expect(media.querySelector("img")).toHaveAttribute("src", selectedEvent.hero.url);
    expect(media.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("places the illustrated registration HTML directly below the event poster", async () => {
    window.history.replaceState({}, "", "/registration-guide?event=wz-aerospace-2026");
    const selectedEvent = event({ id: "WZ-2026", slug: "wz-aerospace-2026" });
    installApi({
      "/api/public/events/wz-aerospace-2026": {
        event: selectedEvent, projects: [], groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: selectedEvent }));

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "报名流程" })).toBeInTheDocument();
    const hero = document.querySelector(".event-information-hero");
    const guide = screen.getByTitle("报名操作详细流程");
    const facts = document.querySelector(".event-information-facts");

    expect(guide).toHaveAttribute("src", "/registration-flow/?embed=1");
    expect(hero.compareDocumentPosition(guide)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(guide.compareDocumentPosition(facts)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("resizes the embedded guide in both directions and releases its observer", async () => {
    window.history.replaceState({}, "", "/registration-guide?event=wz-aerospace-2026");
    const selectedEvent = event({ id: "WZ-2026", slug: "wz-aerospace-2026" });
    installApi({
      "/api/public/events/wz-aerospace-2026": {
        event: selectedEvent, projects: [], groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: selectedEvent }));
    let resizeCallback;
    const disconnect = vi.fn();
    const observe = vi.fn();
    class ResizeObserverStub {
      constructor(callback) {
        resizeCallback = callback;
      }

      observe(target) {
        observe(target);
      }

      disconnect() {
        disconnect();
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const { unmount } = render(<App />);
    const guide = await screen.findByTitle("报名操作详细流程");
    const guideMain = { scrollHeight: 1280 };
    Object.defineProperty(guide, "contentDocument", {
      configurable: true,
      value: { querySelector: vi.fn(() => guideMain) }
    });

    fireEvent.load(guide);
    expect(guide.style.height).toBe("1280px");
    expect(observe).toHaveBeenCalledWith(guideMain);

    guideMain.scrollHeight = 720;
    resizeCallback();
    expect(guide.style.height).toBe("720px");

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("renders the approved introduction and organization as full-width cards", async () => {
    window.history.replaceState({}, "", "/about?event=wz-aerospace-2026");
    const selectedEvent = event({ id: "WZ-2026", slug: "wz-aerospace-2026" });
    installApi({
      "/api/public/events/wz-aerospace-2026": {
        event: selectedEvent, projects: [], groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: selectedEvent }));

    render(<App />);

    const introduction = await screen.findByRole("heading", { level: 2, name: "大赛介绍" });
    const organization = screen.getByRole("heading", { level: 2, name: "组织机构" });
    expect(introduction.closest("article")).toHaveClass("event-information-section-wide");
    expect(organization.closest("article")).toHaveClass("event-information-section-wide");
    expect(screen.getByText(/大赛坚持公益性、规范性、普惠性原则/)).toBeInTheDocument();
    expect(screen.getByText(/2026年由文成县关心下一代工作委员会/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "赛事主题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "举办宗旨" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "参赛对象" })).not.toBeInTheDocument();
  });

  it("keeps the branded information hero fallback when the event has no poster", async () => {
    window.history.replaceState({}, "", "/rules?event=wenzhou-2026");
    const selectedEvent = event({ hero: null });
    installApi({
      "/api/public/events/wenzhou-2026": {
        event: selectedEvent, projects: [], groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: selectedEvent }));

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "大赛章程" })).toBeInTheDocument();
    expect(document.querySelector(".event-information-hero")).toBeInTheDocument();
    expect(document.querySelector(".event-information-hero-media")).toBeNull();
  });

  it("renders the complete current-event rules inline with only the original DOC download", async () => {
    window.history.replaceState({}, "", "/rules?event=wz-aerospace-2026");
    const selectedEvent = event({ id: "WZ-2026", slug: "wz-aerospace-2026" });
    installApi({
      "/api/public/events/wz-aerospace-2026": {
        event: selectedEvent, projects: [], groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: selectedEvent }));

    render(<App />);

    expect(await screen.findByRole("heading", { level: 2, name: "章程原文" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "在线查看章程" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载章程原文件" })).toHaveAttribute(
      "download",
      "2026年温州市青少年航空航天创新比赛大赛章程.doc"
    );
    expect(screen.getByRole("link", { name: "下载章程原文件" })).toHaveAttribute(
      "href",
      "/documents/wz-aerospace-2026-rules.doc"
    );
    [
      "第一章 总则",
      "第二章 组织架构",
      "第三章 参赛对象",
      "第四章 报名条件",
      "第五章 报名流程",
      "第六章 赛事内容",
      "第七章 赛制规则",
      "第八章 申诉制度",
      "第九章 附则"
    ].forEach((heading) => {
      expect(screen.getByRole("heading", { level: 3, name: heading })).toBeInTheDocument();
    });
    expect(screen.getByText(/为深入贯彻党的二十大关于加快建设航天强国的战略部署/)).toBeInTheDocument();
    expect(screen.getByText(/主办单位：温州市关心下一代工作委员会/)).toBeInTheDocument();
    expect(screen.getByText(/青少年航空航天创意创作比赛/)).toBeInTheDocument();
    expect(screen.getByText("温州市青少年航空航天创新比赛组委会")).toBeInTheDocument();
    const finalCompetitionItem = screen.getByText("（五）多轴无人机足球比赛");
    const groupDescription = screen.getByText(/比赛设小学低年级组/);
    expect(finalCompetitionItem.compareDocumentPosition(groupDescription)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole("heading", { level: 2, name: "竞赛组织" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "竞赛办法" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "奖项设置" })).not.toBeInTheDocument();

    const hero = document.querySelector(".event-information-hero");
    const facts = document.querySelector(".event-information-facts");
    const documentCard = document.querySelector(".event-information-document");

    expect(hero.compareDocumentPosition(facts)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(facts.compareDocumentPosition(documentCard)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("does not reuse the Wenzhou rules document for another event", async () => {
    window.history.replaceState({}, "", "/rules?event=summer-cup");
    const selectedEvent = event({ id: "SUMMER", slug: "summer-cup", name: "暑期航空挑战赛" });
    installApi({
      "/api/public/events/summer-cup": {
        event: selectedEvent, projects: [], groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: selectedEvent }));

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "大赛章程" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "章程文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "在线查看章程" })).not.toBeInTheDocument();
  });

  it("renders only the projects returned for the featured public event", async () => {
    const summerCup = event({ id: "SUMMER", slug: "summer-cup", name: "暑期航空挑战赛" });
    const request = installApi({
      "/api/public/events/summer-cup": {
        event: summerCup,
        projects: [{ id: "RETURNED", name: "公开接口赛项" }],
        groups: [],
        resources: [],
        content: []
      }
    }, home({
      featuredEvent: summerCup,
      services: [{ id: "STALE", name: "首页陈旧赛项" }]
    }));

    render(<App />);

    expect(await screen.findByText("公开接口赛项")).toBeInTheDocument();
    expect(screen.queryByText("首页陈旧赛项")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "/api/public/events/summer-cup",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("switches from event A to event B through the projects switcher and removes A projects", async () => {
    const eventA = event({ id: "EVENT-A", slug: "event-a", name: "赛事 A" });
    const eventB = event({ id: "EVENT-B", slug: "event-b", name: "赛事 B" });
    const request = installApi({
      "/api/public/events/event-a": {
        event: eventA,
        projects: [{ id: "PROJECT-A", name: "A 专属赛项" }],
        groups: [], resources: [], content: []
      },
      "/api/public/events/event-b": {
        event: eventB,
        projects: [{ id: "PROJECT-B", name: "B 专属赛项" }],
        groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: eventA, concurrentEvents: [eventB] }));

    render(<App />);
    expect(await screen.findByText("A 专属赛项")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation", { name: "切换公开赛事" })).getByRole("link", { name: "赛事 B" }));

    expect(await screen.findByText("B 专属赛项")).toBeInTheDocument();
    expect(screen.queryByText("A 专属赛项")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/projects");
    expect(window.location.search).toBe("?event=event-b");
    expect(request).toHaveBeenCalledWith(
      "/api/public/events/event-b",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("ignores an event A response that arrives after event B has rendered", async () => {
    const eventA = event({ id: "EVENT-A", slug: "event-a", name: "赛事 A" });
    const eventB = event({ id: "EVENT-B", slug: "event-b", name: "赛事 B" });
    const eventAResponse = deferred();
    const eventBResponse = deferred();
    const request = vi.fn(async (url) => {
      if (url === "/api/public/home") {
        return jsonResponse(home({ featuredEvent: eventA, concurrentEvents: [eventB] }));
      }
      if (url === "/api/public/events/event-a") return eventAResponse.promise;
      if (url === "/api/public/events/event-b") return eventBResponse.promise;
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", request);

    render(<App />);
    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "/api/public/events/event-a",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));
    fireEvent.click(within(screen.getByRole("navigation", { name: "切换公开赛事" })).getByRole("link", { name: "赛事 B" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "/api/public/events/event-b",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));

    await act(async () => {
      eventBResponse.resolve(jsonResponse({
        event: eventB,
        projects: [{ id: "PROJECT-B", name: "B 乱序赛项" }],
        groups: [], resources: [], content: []
      }));
    });
    expect(await screen.findByText("B 乱序赛项")).toBeInTheDocument();

    await act(async () => {
      eventAResponse.resolve(jsonResponse({
        event: eventA,
        projects: [{ id: "PROJECT-A", name: "A 迟到赛项" }],
        groups: [], resources: [], content: []
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("B 乱序赛项")).toBeInTheDocument();
    expect(screen.queryByText("A 迟到赛项")).not.toBeInTheDocument();
  });

  it("shows a friendly retry state for detail failures without empty project cards", async () => {
    const summerCup = event({ id: "SUMMER", slug: "summer-cup", name: "暑期航空挑战赛" });
    let detailAttempts = 0;
    const request = installApi({
      "/api/public/events/summer-cup": () => {
        detailAttempts += 1;
        if (detailAttempts === 1) return jsonResponse({ message: "SQL connection refused" }, 500);
        return jsonResponse({
          event: summerCup,
          projects: [{ id: "RETRY-PROJECT", name: "重试后赛项" }],
          groups: [], resources: [], content: []
        });
      }
    }, home({ featuredEvent: summerCup }));

    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("暂时无法加载赛事详情，请稍后重试。");
    expect(alert).not.toHaveTextContent("SQL");
    expect(screen.queryByRole("heading", { name: "赛事项目" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "参赛组别" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("重试后赛项")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(detailAttempts).toBe(2);
    expect(request).toHaveBeenCalledWith(
      "/api/public/events/summer-cup",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("renders generic event phone numbers as dial links while preserving the contact name", async () => {
    window.history.replaceState({}, "", "/contact");
    const summerCup = event({
      id: "SUMMER",
      slug: "summer-cup",
      name: "暑期航空挑战赛",
      contact: "赛事组委会 0577-12345678 / 138 0013 8000"
    });
    installApi({
      "/api/public/events/summer-cup": {
        event: summerCup, projects: [], groups: [], resources: [], content: []
      }
    }, home({ featuredEvent: summerCup }));

    render(<App />);

    expect(await screen.findByText("联系人：赛事组委会")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "0577-12345678" })).toHaveAttribute("href", "tel:057712345678");
    expect(screen.getByRole("link", { name: "138 0013 8000" })).toHaveAttribute("href", "tel:13800138000");
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

  it("renders announcements as ordinary content without tab-only ARIA relationships", async () => {
    window.history.replaceState({}, "", "/announcements");
    installApi({
      "/api/public/content?type=announcement&page=1&pageSize=10": page([content("A1", "announcement")])
    });

    render(<App />);
    expect(await screen.findByText("announcement-A1 标题")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-labelledby='content-tab-announcement']")).toBeNull();
  });

  it("shows only news publicly and never requests work content", async () => {
    window.history.replaceState({}, "", "/news");
    const request = installApi({
      "/api/public/content?type=news&page=1&pageSize=10": page([content("N1", "news")])
    });

    render(<App />);
    expect(await screen.findByRole("link", { name: "news-N1 标题" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "新闻动态" })).toBeInTheDocument();
    expect(screen.queryByText("优秀作品")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "/api/public/content?type=news&page=1&pageSize=10",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(request.mock.calls.some(([url]) => url.includes("type=work"))).toBe(false);
  });

  it("keeps one legal event filter on announcements and pagination requests", async () => {
    window.history.replaceState({}, "", "/announcements?event=E1&page=1");
    const request = installApi({
      "/api/public/content?type=announcement&page=1&pageSize=10&event=E1": page([content("A1", "announcement")], {
        pagination: { page: 1, pageSize: 10, total: 11, totalPages: 2 }
      }),
      "/api/public/content?type=announcement&page=2&pageSize=10&event=E1": page([content("A2", "announcement")], {
        pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 }
      })
    });

    render(<App />);
    expect(await screen.findByText("announcement-A1 标题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("announcement-A2 标题")).toBeInTheDocument();
    expect(window.location.search).toContain("event=E1");
    expect(window.location.search).toContain("page=2");
    expect(request).toHaveBeenCalledWith(
      "/api/public/content?type=announcement&page=2&pageSize=10&event=E1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("keeps one legal event filter on the news request", async () => {
    window.history.replaceState({}, "", "/news?event=E1");
    const request = installApi({
      "/api/public/content?type=news&page=1&pageSize=10&event=E1": page([content("N1", "news")])
    });

    render(<App />);
    expect(await screen.findByText("news-N1 标题")).toBeInTheDocument();
    expect(request.mock.calls.filter(([url]) => url.endsWith("&event=E1"))).toHaveLength(1);
    expect(window.location.search).toContain("event=E1");
    expect(request.mock.calls.some(([url]) => url.includes("type=work"))).toBe(false);
  });

  it("normalizes a legacy work URL to news while preserving event and pagination", async () => {
    window.history.replaceState({}, "", "/news?type=work&page=1&event=E1");
    const request = installApi({
      "/api/public/content?type=news&page=1&pageSize=10&event=E1": page([content("N1", "news")], {
        pagination: { page: 1, pageSize: 10, total: 11, totalPages: 2 }
      }),
      "/api/public/content?type=news&page=2&pageSize=10&event=E1": page([content("N2", "news")], {
        pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 }
      })
    });

    render(<App />);
    expect(await screen.findByText("news-N1 标题")).toBeInTheDocument();
    expect(screen.queryByText("优秀作品")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("news-N2 标题")).toBeInTheDocument();
    expect(window.location.search).toContain("type=news");
    expect(window.location.search).toContain("page=2");
    expect(window.location.search).toContain("event=E1");
    expect(request).toHaveBeenCalledWith(
      "/api/public/content?type=news&page=2&pageSize=10&event=E1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(request.mock.calls.some(([url]) => url.includes("type=work"))).toBe(false);
  });

  it.each(["?type=", "?type=news&type=work", "?type=invalid", "?type=work"])(
    "defaults an empty, duplicate or invalid news type to news without forwarding it %s",
    async (query) => {
      window.history.replaceState({}, "", `/news${query}`);
      const request = installApi({
        "/api/public/content?type=news&page=1&pageSize=10": page([content("N1", "news")])
      });

      const { unmount } = render(<App />);
      expect(await screen.findByText("news-N1 标题")).toBeInTheDocument();
      expect(screen.queryByText("优秀作品")).not.toBeInTheDocument();
      expect(request.mock.calls.every(([url]) => !url.includes("type=invalid") && !url.includes("type=&"))).toBe(true);
      expect(request.mock.calls.some(([url]) => url.includes("type=work"))).toBe(false);
      unmount();
    }
  );

  it.each(["?event=", "?event=E1&event=E2", "?event=../secret", "?event=%20E1%20"])(
    "does not send an empty, duplicate or malformed event filter %s",
    async (query) => {
      window.history.replaceState({}, "", `/announcements${query}`);
      const request = installApi({
        "/api/public/content?type=announcement&page=1&pageSize=10": page([])
      });
      const { unmount } = render(<App />);
      expect(await screen.findByText("暂无公开内容")).toBeInTheDocument();
      expect(request.mock.calls.some(([url]) => url.includes("&event="))).toBe(false);
      unmount();
    }
  );

  it("merges public archived-event summaries with recap rows without linking a hidden relation", async () => {
    window.history.replaceState({}, "", "/history");
    installApi({
      "/api/public/events?page=1&pageSize=6": page([
        event({ id: "OLD", slug: "old-event", name: "2025航空航天创新赛", status: "archived", registrationWindow: { open: false, reason: "赛事已归档" } })
      ]),
      "/api/public/content?type=recap&page=1&pageSize=10": page([
        content("R1", "recap", { eventId: null, eventSlug: null }),
        content("R2", "recap", { eventId: "OLD", eventSlug: "old-event" })
      ])
    }, home());

    render(<App />);
    expect(await screen.findByRole("link", { name: "2025航空航天创新赛" })).toHaveAttribute("href", "/events/old-event");
    expect(screen.getByRole("link", { name: "recap-R1 标题" })).toHaveAttribute("href", "/content/recap-r1");
    expect(document.querySelector('a[href="/events/null"]')).toBeNull();
  });

  it("loads a paginated public history event list even while another event is active", async () => {
    window.history.replaceState({}, "", "/history");
    const request = installApi({
      "/api/public/events?page=1&pageSize=6": page([
        event({ id: "OLD", slug: "old-event", name: "2025航空航天创新赛", status: "archived", registrationWindow: { open: false, reason: "赛事已归档" } })
      ]),
      "/api/public/content?type=recap&page=1&pageSize=10": page([])
    }, home({
      mode: "active",
      featuredEvent: event({ id: "ACTIVE", slug: "active-event", name: "当前赛事" })
    }));

    render(<App />);
    expect(await screen.findByRole("link", { name: "2025航空航天创新赛" })).toHaveAttribute("href", "/events/old-event");
    expect(request).toHaveBeenCalledWith(
      "/api/public/events?page=1&pageSize=6",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("paginates historical events without changing the recap page", async () => {
    window.history.replaceState({}, "", "/history?eventsPage=1&page=1");
    const request = installApi({
      "/api/public/events?page=1&pageSize=6": page([event({ id: "OLD-1", slug: "old-1", name: "2025赛事" })], {
        pagination: { page: 1, pageSize: 6, total: 7, totalPages: 2 }
      }),
      "/api/public/events?page=2&pageSize=6": page([event({ id: "OLD-2", slug: "old-2", name: "2024赛事" })], {
        pagination: { page: 2, pageSize: 6, total: 7, totalPages: 2 }
      }),
      "/api/public/content?type=recap&page=1&pageSize=10": page([])
    });

    render(<App />);
    expect(await screen.findByText("2025赛事")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页历史赛事" }));
    expect(await screen.findByText("2024赛事")).toBeInTheDocument();
    expect(window.location.search).toContain("eventsPage=2");
    expect(window.location.search).toContain("page=1");
    expect(request).toHaveBeenCalledWith(
      "/api/public/events?page=2&pageSize=6",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("paginates recap rows without losing the history route", async () => {
    window.history.replaceState({}, "", "/history?event=E1&page=1");
    const request = installApi({
      "/api/public/events?page=1&pageSize=6": page([]),
      "/api/public/content?type=recap&page=1&pageSize=10&event=E1": page([content("R1", "recap")], {
        pagination: { page: 1, pageSize: 10, total: 11, totalPages: 2 }
      }),
      "/api/public/content?type=recap&page=2&pageSize=10&event=E1": page([content("R2", "recap")], {
        pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 }
      })
    });

    render(<App />);
    expect(await screen.findByText("recap-R1 标题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("recap-R2 标题")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/history");
    expect(window.location.search).toContain("event=E1");
    expect(window.location.search).toContain("page=2");
    expect(request).toHaveBeenCalledWith(
      "/api/public/content?type=recap&page=2&pageSize=10&event=E1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("public content detail and failures", () => {
  beforeEach(() => window.history.replaceState({}, "", "/content/safe-story"));

  it("hides a published work detail behind the public not-found view", async () => {
    installApi({
      "/api/public/content/safe-story": {
        row: {
          ...content("WORK", "work", { slug: "safe-story", title: "不应公开的优秀作品" }),
          bodyHtml: "<p>不应公开的作品正文</p>",
          attachments: []
        }
      }
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "内容不存在" })).toBeInTheDocument();
    expect(screen.queryByText("不应公开的优秀作品")).not.toBeInTheDocument();
    expect(screen.queryByText("不应公开的作品正文")).not.toBeInTheDocument();
  });

  it("shows original attribution only for reposted content", async () => {
    installApi({
      "/api/public/content/safe-story": {
        row: {
          ...content("SAFE", "news", { slug: "safe-story", title: "转载新闻" }),
          bodyHtml: "<p>正文</p>", attachments: [],
          source: { name: "温州发布", author: "作者甲", url: "https://news.example.com/a", publishedAt: "2026-08-10T08:00:00.000Z" }
        }
      }
    });
    const { unmount } = render(<App />);
    expect(await screen.findByText("来源：温州发布")).toBeInTheDocument();
    expect(screen.getByText("作者：作者甲")).toBeInTheDocument();
    expect(screen.getByText(/版权归原作者及原平台所有/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看原文" })).toHaveAttribute("href", "https://news.example.com/a");
    expect(screen.getByRole("link", { name: "查看原文" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "查看原文" })).toHaveAttribute("rel", "noopener noreferrer");
    unmount();

    installApi({
      "/api/public/content/safe-story": {
        row: { ...content("SAFE", "news", { slug: "safe-story", title: "原创新闻" }), bodyHtml: "", attachments: [], source: null }
      }
    });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "原创新闻" })).toBeInTheDocument();
    expect(screen.queryByText(/版权归原作者及原平台所有/)).not.toBeInTheDocument();
  });

  it("continues to fetch the public content detail API", async () => {
    const request = installApi({
      "/api/public/content/safe-story": {
        row: { ...content("SAFE", "news", { slug: "safe-story", title: "安全公开内容" }), bodyHtml: "", attachments: [] }
      }
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "安全公开内容" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "/api/public/content/safe-story",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

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

  it("renders a legacy repost image inline instead of in the attachment download list", async () => {
    installApi({
      "/api/public/content/safe-story": {
        row: {
          ...content("SAFE", "news", { slug: "safe-story", title: "转载图片正文" }),
          bodyHtml: "<p>正文</p>",
          attachments: [
            {
              id: "INLINE-IMAGE",
              label: "转载正文图片",
              displayOrder: 0,
              url: "/api/public/media/INLINE-IMAGE?variant=original",
              name: "inline.jpg",
              mimeType: "image/jpeg",
              sizeBytes: 128
            },
            {
              id: "REAL-ATTACHMENT",
              label: "赛事通知",
              displayOrder: 1,
              url: "/api/public/media/REAL-ATTACHMENT?variant=original",
              name: "notice.pdf",
              mimeType: "application/pdf",
              sizeBytes: 256
            }
          ]
        }
      }
    });

    render(<App />);

    expect(await screen.findByRole("img", { name: "转载正文图片" })).toHaveAttribute(
      "src",
      "/api/public/media/INLINE-IMAGE?variant=original"
    );
    expect(screen.queryByText("转载正文图片")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /赛事通知/ })).toBeInTheDocument();
  });

  it("renders API-cleaned B站 markers through the fixed public player", async () => {
    installApi({
      "/api/public/content/safe-story": {
        row: {
          ...content("SAFE", "news", { slug: "safe-story", title: "视频公开内容" }),
          bodyHtml: '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>比赛回顾</figcaption></figure>',
          attachments: []
        }
      }
    });

    render(<App />);

    const player = await screen.findByTitle("B站视频：比赛回顾");
    expect(player).toHaveAttribute(
      "src",
      "https://player.bilibili.com/player.html?bvid=BV1B7411m7LV&poster=1&autoplay=0&danmaku=0"
    );
    expect(screen.getByText("比赛回顾")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "在哔哩哔哩打开" })).toHaveAttribute(
      "href",
      "https://www.bilibili.com/video/BV1B7411m7LV"
    );
  });

  it("renders responsive figures and captions without horizontal overflow", async () => {
    const css = readFileSync("src/styles/content.css", "utf8");
    installApi({
      "/api/public/content/safe-story": {
        row: {
          ...content("SAFE", "news", { slug: "safe-story", title: "正文图片" }),
          bodyHtml: '<figure><img src="/api/public/media/M1" alt="现场"><figcaption>比赛现场</figcaption></figure>',
          attachments: []
        }
      }
    });

    render(<App />);
    expect(await screen.findByAltText("现场")).toHaveAttribute("src", "/api/public/media/M1");
    expect(screen.getByText("比赛现场")).toBeInTheDocument();
    expect(css).toMatch(/\.rich-content figure\s*\{[^}]*max-width:\s*100%/s);
    expect(css).toMatch(/\.rich-content figcaption\s*\{[^}]*text-align:\s*center/s);
  });

  it("keeps the B站 player responsive at 16:9 without a fixed pixel iframe width", () => {
    const css = readFileSync("src/styles/content.css", "utf8");
    const frameRule = css.match(/\.rich-content \.content-bilibili-frame\s*\{([^}]*)\}/s)?.[1] || "";
    const iframeRule = css.match(/\.rich-content \.content-bilibili-frame iframe\s*\{([^}]*)\}/s)?.[1] || "";

    expect(frameRule).toMatch(/width:\s*100%/);
    expect(frameRule).toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
    expect(iframeRule).toMatch(/width:\s*100%/);
    expect(iframeRule).not.toMatch(/width:\s*\d+(?:\.\d+)?px/);
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
