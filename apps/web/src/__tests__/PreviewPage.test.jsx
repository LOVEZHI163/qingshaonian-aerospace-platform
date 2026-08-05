import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App.jsx";
import PreviewPage from "../pages/PreviewPage.jsx";
import { PREVIEW_STORAGE_PREFIX, readPreviewSnapshot } from "../preview/storage.js";

const token = "a".repeat(48);

function memoryStorageWith(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function validSnapshot(overrides = {}) {
  return {
    version: 1,
    token,
    kind: "homepage",
    expiresAt: Date.now() + 60_000,
    adminReturnPath: "/admin/?view=site-content",
    payload: { site: { platformName: "草稿航空平台" } },
    ...overrides
  };
}

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function storeSnapshot(snapshot) {
  window.localStorage.setItem(`${PREVIEW_STORAGE_PREFIX}${token}`, JSON.stringify(snapshot));
}

describe("browser-local preview snapshots", () => {
  it("reads a valid same-browser snapshot and removes an expired one", () => {
    const storage = memoryStorageWith({
      [`${PREVIEW_STORAGE_PREFIX}${token}`]: JSON.stringify(validSnapshot({ expiresAt: 901_000 }))
    });

    expect(readPreviewSnapshot(token, { now: 900_000, storage }).ok).toBe(true);
    expect(readPreviewSnapshot(token, { now: 901_001, storage })).toEqual({ ok: false, reason: "expired" });
    expect(storage.getItem(`${PREVIEW_STORAGE_PREFIX}${token}`)).toBeNull();
  });

  it("cleans every expired preview record before reading while preserving fresh and unrelated storage", () => {
    const expiredToken = "b".repeat(48);
    const freshToken = "c".repeat(48);
    const storage = memoryStorageWith({
      [`${PREVIEW_STORAGE_PREFIX}${token}`]: JSON.stringify(validSnapshot({ expiresAt: 901_000 })),
      [`${PREVIEW_STORAGE_PREFIX}${expiredToken}`]: JSON.stringify(validSnapshot({
        token: expiredToken,
        expiresAt: 899_999
      })),
      [`${PREVIEW_STORAGE_PREFIX}${freshToken}`]: JSON.stringify(validSnapshot({
        token: freshToken,
        expiresAt: 901_000
      })),
      "unrelated-key": "keep"
    });

    expect(readPreviewSnapshot(token, { now: 900_000, storage }).ok).toBe(true);
    expect(storage.getItem(`${PREVIEW_STORAGE_PREFIX}${expiredToken}`)).toBeNull();
    expect(storage.getItem(`${PREVIEW_STORAGE_PREFIX}${freshToken}`)).not.toBeNull();
    expect(storage.getItem("unrelated-key")).toBe("keep");
  });

  it.each([
    ["malformed", token, "{not-json"],
    ["wrong version", token, JSON.stringify(validSnapshot({ version: 2 }))],
    ["wrong kind", token, JSON.stringify(validSnapshot({ kind: "unknown" }))],
    ["mismatched token", token, JSON.stringify(validSnapshot({ token: "b".repeat(48) }))],
    ["invalid token", "not-a-token", JSON.stringify(validSnapshot())]
  ])("rejects %s snapshots", (_label, requestedToken, value) => {
    const storage = memoryStorageWith({ [`${PREVIEW_STORAGE_PREFIX}${token}`]: value });
    expect(readPreviewSnapshot(requestedToken, { now: 900_000, storage })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("PreviewPage", () => {
  it("renders a valid snapshot with the draft status, noindex robots and a token-free return link", () => {
    storeSnapshot(validSnapshot());
    render(<PreviewPage location={`/preview?token=${token}`} />);

    expect(screen.getByText("草稿预览 · 未保存 · 仅当前浏览器可见")).toBeInTheDocument();
    expect(screen.getByText("草稿航空平台")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回管理后台" })).toHaveAttribute("href", "/admin/?view=site-content");
    expect(screen.getByRole("link", { name: "返回管理后台" })).toHaveAttribute("data-router-ignore", "true");
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  });

  it.each([
    ["a token-bearing fragment", "/admin/?view=site-content&token=leaked#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["an arbitrary fragment", "/admin/?view=site-content#section-to-not-preserve"]
  ])("removes %s from the return link", (_label, adminReturnPath) => {
    storeSnapshot(validSnapshot({ adminReturnPath }));
    render(<PreviewPage location={`/preview?token=${token}`} />);

    expect(screen.getByRole("link", { name: "返回管理后台" })).toHaveAttribute(
      "href",
      "/admin/?view=site-content"
    );
  });

  it.each([
    ["event", { event: { name: "草稿赛事" } }, "草稿赛事"],
    ["content", { row: { title: "草稿内容", summary: "内容摘要" } }, "草稿内容"]
  ])("dispatches the %s snapshot", (kind, payload, heading) => {
    storeSnapshot(validSnapshot({ kind, payload }));
    render(<PreviewPage location={`/preview?token=${token}`} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  });

  it.each([
    [
      "homepage",
      {
        site: { platformName: "草稿航空平台", platformIntro: "尚未保存的平台简介" },
        featuredEvent: null,
        concurrentEvents: [],
        services: [],
        announcements: [],
        news: [],
        works: [],
        history: []
      },
      "尚未保存的平台简介"
    ],
    [
      "event",
      {
        event: {
          id: "draft-event",
          slug: "draft-event",
          name: "赛事草稿",
          slogan: "尚未保存的赛事宣传语",
          registrationWindow: { open: false, reason: "赛事尚未发布" }
        },
        projects: [],
        groups: [],
        resources: [{
          id: "draft-event-rules",
          label: "尚未保存的赛事规程",
          url: "/api/admin/site-media/draft-event-rules/preview",
          name: "赛事规程.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048
        }, {
          id: "unsafe-event-rules",
          label: "不安全赛事资源",
          url: "https://attacker.example/rules.pdf"
        }],
        content: []
      },
      "尚未保存的赛事宣传语"
    ],
    [
      "content",
      {
        row: {
          id: "draft-content",
          slug: "draft-content",
          title: "内容草稿",
          bodyHtml: '<p>尚未保存的正文</p><a href="https://example.org/draft">草稿外链</a>',
          attachments: [{
            id: "draft-content-attachment",
            label: "尚未保存的内容附件",
            url: "/api/admin/site-media/draft-content-attachment/preview",
            name: "内容附件.png",
            mimeType: "image/png",
            sizeBytes: 1536
          }, {
            id: "unsafe-content-attachment",
            label: "不安全内容附件",
            url: "javascript:alert(1)"
          }]
        }
      },
      "尚未保存的正文"
    ]
  ])("renders %s snapshot through the public view", (kind, payload, expectedText) => {
    storeSnapshot(validSnapshot({ kind, payload }));
    window.history.replaceState({}, "", `/preview?token=${token}`);
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    render(<App />);

    expect(screen.getByText(expectedText)).toBeInTheDocument();
    expect(screen.getByText("草稿预览 · 未保存 · 仅当前浏览器可见")).toBeInTheDocument();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    if (kind === "homepage") {
      expect(within(screen.getByRole("contentinfo")).getByText(expectedText)).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    }

    if (kind === "content") {
      expect(screen.getByRole("link", { name: /尚未保存的内容附件/ })).toHaveAttribute(
        "href",
        "/api/admin/site-media/draft-content-attachment/preview"
      );
      expect(screen.getByText(/草稿附件需保持管理后台登录状态/)).toBeInTheDocument();
      expect(screen.queryByText("不安全内容附件")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "草稿外链" })).toHaveAttribute("target", "_blank");
      expect(screen.getByRole("link", { name: "草稿外链" })).toHaveAttribute("rel", "noopener noreferrer");
    }
    if (kind === "event") {
      expect(screen.getByRole("link", { name: /尚未保存的赛事规程/ })).toHaveAttribute(
        "href",
        "/api/admin/site-media/draft-event-rules/preview"
      );
      expect(screen.getAllByText("赛事尚未发布")).not.toHaveLength(0);
      expect(screen.queryByRole("link", { name: "立即报名" })).not.toBeInTheDocument();
      expect(screen.getByText(/草稿附件需保持管理后台登录状态/)).toBeInTheDocument();
      expect(screen.queryByText("不安全赛事资源")).not.toBeInTheDocument();
    }
  });

  it("renders a draft B站 marker through the same fixed content player", async () => {
    storeSnapshot(validSnapshot({
      kind: "content",
      payload: {
        row: {
          id: "draft-video",
          slug: "draft-video",
          title: "视频草稿",
          bodyHtml: '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>草稿比赛回顾</figcaption></figure>',
          attachments: []
        }
      }
    }));

    render(<PreviewPage location={`/preview?token=${token}`} />);

    expect(await screen.findByTitle("B站视频：草稿比赛回顾")).toHaveAttribute(
      "src",
      "https://player.bilibili.com/player.html?bvid=BV1B7411m7LV&poster=1&autoplay=0&danmaku=0"
    );
  });

  it("uses homepage site drafts for the shared footer and preview SEO without a duplicate footer", () => {
    vi.stubEnv("VITE_PUBLIC_SITE_URL", "https://aerogp.cn");
    storeSnapshot(validSnapshot({
      payload: {
        site: {
          platformName: "尚未保存的平台名称",
          platformIntro: "尚未保存的平台简介",
          organizers: ["尚未保存的主办单位甲", "尚未保存的主办单位乙"],
          icp: "浙ICP备草稿号",
          seoTitle: "尚未保存的 SEO 标题",
          seoDescription: "尚未保存的 SEO 摘要",
          shareImage: { url: "/api/admin/site-media/draft-share/preview" }
        }
      }
    }));
    window.history.replaceState({}, "", `/preview?token=${token}`);
    vi.stubGlobal("fetch", vi.fn());

    render(<App />);

    const footers = screen.getAllByRole("contentinfo");
    expect(footers).toHaveLength(1);
    const footer = within(footers[0]);
    expect(footer.getByText("尚未保存的平台名称")).toBeInTheDocument();
    expect(footer.getByText("尚未保存的平台简介")).toBeInTheDocument();
    expect(footer.getByText("尚未保存的主办单位甲、尚未保存的主办单位乙")).toBeInTheDocument();
    expect(footer.queryByText("0577-76543210")).not.toBeInTheDocument();
    expect(footer.getByText("浙ICP备草稿号")).toBeInTheDocument();
    expect(document.title).toBe("尚未保存的 SEO 标题");
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute("content", "尚未保存的 SEO 摘要");
    expect(document.head.querySelector('meta[property="og:image"]')).toHaveAttribute(
      "content",
      "https://aerogp.cn/api/admin/site-media/draft-share/preview"
    );
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects duplicate token parameters without reading a snapshot", () => {
    storeSnapshot(validSnapshot());
    render(<PreviewPage location={`/preview?token=${token}&token=${token}`} />);
    expect(screen.getByRole("heading", { name: "预览链接无效" })).toBeInTheDocument();
  });

  it("shows the expired guidance after clearing the expired snapshot", () => {
    window.localStorage.setItem(`${PREVIEW_STORAGE_PREFIX}${token}`, JSON.stringify(validSnapshot({ expiresAt: 0 })));
    render(<PreviewPage location={`/preview?token=${token}`} />);
    expect(screen.getByRole("heading", { name: "预览已过期" })).toBeInTheDocument();
    expect(window.localStorage.getItem(`${PREVIEW_STORAGE_PREFIX}${token}`)).toBeNull();
  });

  it("expires an already-open preview at expiresAt and removes its browser snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(900_000);
    storeSnapshot(validSnapshot({ expiresAt: 901_000 }));
    render(<PreviewPage location={`/preview?token=${token}`} />);
    expect(screen.getByText("草稿航空平台")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.getByRole("heading", { name: "预览已过期" })).toBeInTheDocument();
    expect(window.localStorage.getItem(`${PREVIEW_STORAGE_PREFIX}${token}`)).toBeNull();
  });

  it.each(["focus", "visibilitychange"])("re-checks preview expiry on %s", (eventName) => {
    vi.useFakeTimers();
    vi.setSystemTime(900_000);
    storeSnapshot(validSnapshot({ expiresAt: 901_000 }));
    render(<PreviewPage location={`/preview?token=${token}`} />);
    expect(screen.getByText("草稿航空平台")).toBeInTheDocument();

    vi.setSystemTime(901_001);
    act(() => (eventName === "focus" ? window : document).dispatchEvent(new Event(eventName)));

    expect(screen.getByRole("heading", { name: "预览已过期" })).toBeInTheDocument();
    expect(window.localStorage.getItem(`${PREVIEW_STORAGE_PREFIX}${token}`)).toBeNull();
  });

  it("renders preview directly without requesting the normal home bootstrap", () => {
    storeSnapshot(validSnapshot());
    window.history.replaceState({}, "", `/preview?token=${token}`);
    vi.stubGlobal("fetch", vi.fn());
    render(<App />);
    expect(within(screen.getByRole("contentinfo")).getByText("草稿航空平台")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
