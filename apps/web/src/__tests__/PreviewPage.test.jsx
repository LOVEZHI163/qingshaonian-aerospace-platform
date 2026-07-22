import React from "react";
import { render, screen } from "@testing-library/react";
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

afterEach(() => window.localStorage.clear());

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
    ["event", { event: { name: "草稿赛事" } }, "草稿赛事"],
    ["content", { row: { title: "草稿内容", summary: "内容摘要" } }, "草稿内容"]
  ])("dispatches the %s snapshot", (kind, payload, heading) => {
    storeSnapshot(validSnapshot({ kind, payload }));
    render(<PreviewPage location={`/preview?token=${token}`} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
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

  it("renders preview directly without requesting the normal home bootstrap", () => {
    storeSnapshot(validSnapshot());
    window.history.replaceState({}, "", `/preview?token=${token}`);
    vi.stubGlobal("fetch", vi.fn());
    render(<App />);
    expect(screen.getByText("草稿航空平台")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
