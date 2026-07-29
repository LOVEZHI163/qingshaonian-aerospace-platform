import { readFileSync } from "node:fs";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import SiteContentPage from "../SiteContentPage.vue";
import EventPublicProfilePanel from "../../components/EventPublicProfilePanel.vue";
import SiteSettingsPanel from "../../components/SiteSettingsPanel.vue";

const settings = {
  id: "default",
  platformName: "温州市青少年航空航天创新比赛",
  platformIntro: "原平台简介",
  organizers: ["主办单位"],
  contact: "0577-12345678",
  icp: "浙ICP备00000000号",
  seoTitle: "航空比赛",
  seoDescription: "赛事资讯",
  featuredEventId: "E1",
  defaultHeroMediaId: null,
  shareMediaId: null,
  version: 3
};

const events = [
  { id: "E1", name: "2026赛事", dateLabel: "2026年11月", venue: "温州", status: "published", archivedAt: null },
  { id: "E2", name: "未公开赛事", dateLabel: "2027年5月", venue: "温州", status: "draft", archivedAt: null },
  { id: "E3", name: "已归档赛事", dateLabel: "2025年11月", venue: "温州", status: "archived", archivedAt: "2025-12-01T00:00:00.000Z" }
];

const profiles = [
  { eventId: "E1", slug: "event-2026", slogan: "逐梦蓝天", summary: "原摘要", isVisible: true, displayOrder: 1, heroMediaId: null, version: 2, event: events[0] },
  { eventId: "E2", slug: "event-2027", slogan: "", summary: "", isVisible: false, displayOrder: 2, heroMediaId: null, version: 1, event: events[1] }
];

const contentRow = {
  slug: "content", eventId: "E1", type: "news", title: "内容", summary: "摘要",
  bodyHtml: "<p>正文</p>", publishAt: null, pinned: false, sortOrder: 0,
  coverMediaId: null, attachments: [], version: 1, previewHtml: "<p>正文</p>"
};

function installSuccessfulApi() {
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path === "/api/admin/site-settings" && options.method === "PATCH") {
      return { row: { ...settings, ...JSON.parse(options.body), version: settings.version + 1 } };
    }
    if (path === "/api/admin/site-settings") return { row: { ...settings } };
    if (path === "/api/admin/event-public-profiles") return { rows: profiles.map((row) => ({ ...row })) };
    if (path === "/api/admin/events") return { rows: events.map((row) => ({ ...row })), projects: [] };
    if (path === "/api/admin/event-public-profiles/E1" && options.method === "PUT") {
      return { row: { ...profiles[0], ...JSON.parse(options.body), version: 3 } };
    }
    if (path === "/api/admin/site-media" && options.method === "POST") {
      return { row: { id: "MEDIA-1", mimeType: "image/png" } };
    }
    return { rows: [] };
  });
}

async function mountLoaded(options = {}) {
  const wrapper = mount(SiteContentPage, options);
  await flushPromises();
  return wrapper;
}

async function activateTab(wrapper, name) {
  await wrapper.get(`[data-site-tab="${name}"]`).trigger("click");
  await flushPromises();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("SiteContentPage", () => {
  it("defines the desktop sticky workflow and 360px single-column CSS contract", () => {
    const css = readFileSync("src/styles/admin.css", "utf8");
    expect(css).toMatch(/\.content-editor-sticky-actions\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s);
    expect(css).toMatch(/\.content-editor-sticky-actions button:focus-visible\s*\{[^}]*outline:\s*3px solid #0b63ce;/s);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.content-editor-section \.site-form-grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.content-editor-sticky-actions\s*\{[^}]*flex-direction:\s*column;/);
  });

  beforeEach(() => {
    apiMock.mockReset();
    installSuccessfulApi();
    localStorage.clear();
  });

  it("loads homepage settings and exposes only configurable featured events", async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.get('[data-site-tab="homepage"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[data-field="platformName"]').attributes("readonly")).toBeDefined();
    expect(wrapper.get('[data-field="platformIntro"]').element.value).toBe("原平台简介");
    expect(wrapper.get('[data-field="featuredEventId"]').findAll("option").map((option) => option.text())).toEqual([
      "自动选择", "2026赛事"
    ]);
  });

  it("exposes the current homepage and event profile drafts without saving", async () => {
    const wrapper = await mountLoaded();
    await wrapper.get('[data-field="platformIntro"]').setValue("尚未保存的简介");

    expect(wrapper.getComponent(SiteSettingsPanel).vm.getPreviewDraft()).toEqual({
      kind: "homepage",
      body: expect.objectContaining({ platformIntro: "尚未保存的简介" }),
      context: {}
    });
    expect(wrapper.getComponent(SiteSettingsPanel).vm.getSavedPreviewPath()).toBe("/");

    await wrapper.get('[data-site-tab="events"]').trigger("click");
    await wrapper.get('[data-profile-field="slogan"]').setValue("尚未保存");
    await wrapper.get('[data-profile-field="slug"]').setValue("unsaved-event-route");

    expect(wrapper.getComponent(EventPublicProfilePanel).vm.getPreviewDraft()).toEqual({
      kind: "event",
      body: expect.objectContaining({ eventId: "E1", slug: "unsaved-event-route", slogan: "尚未保存" }),
      context: { eventId: "E1" }
    });
    expect(wrapper.getComponent(EventPublicProfilePanel).vm.getSavedPreviewPath()).toBe("/events/event-2026");
    expect(wrapper.getComponent(EventPublicProfilePanel).vm.getSavedPreviewState()).toEqual({
      path: "/events/event-2026",
      reason: ""
    });
  });

  it("opens the active saved page and creates a draft preview without saving", async () => {
    const popups = [];
    const open = vi.spyOn(window, "open").mockImplementation((url, _target, features) => {
      if (String(features || "").split(",").includes("noopener")) return null;
      const popup = { opener: window, location: { href: url }, close: vi.fn() };
      popups.push(popup);
      return popup;
    });
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/site-preview/homepage" && options.method === "POST") {
        return { preview: { payload: { platformName: settings.platformName }, context: {} } };
      }
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    await wrapper.get('[data-action="preview-saved-site"]').trigger("click");
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popups[0].opener).toBeNull();
    expect(popups[0].location.href).toBe("/");
    expect(wrapper.find("[data-preview-fallback]").exists()).toBe(false);

    await wrapper.get('[data-action="preview-site-draft"]').trigger("click");
    expect(open).toHaveBeenLastCalledWith("about:blank", "_blank");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/site-preview/homepage", expect.objectContaining({ method: "POST" }));
    expect(popups[1].opener).toBeNull();
    expect(popups[1].location.href).toMatch(/^\/preview\?token=/);
    expect(apiMock).not.toHaveBeenCalledWith("/api/admin/site-settings", expect.objectContaining({ method: "PATCH" }));
  });

  it("severs the draft popup opener before awaiting validation and navigates it only after success", async () => {
    const validation = deferred();
    const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/site-preview/homepage" && options.method === "POST") return validation.promise;
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    await wrapper.get('[data-action="preview-site-draft"]').trigger("click");

    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe("about:blank");

    validation.resolve({ preview: { payload: {}, context: {} } });
    await flushPromises();
    expect(popup.location.href).toMatch(/^\/preview\?token=/);
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("disables contextual preview until an event or content is selected", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: [] };
      if (path === "/api/admin/events") return { rows: [] };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    await activateTab(wrapper, "events");
    expect(wrapper.get('[data-action="preview-site-draft"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-preview-help]").text()).toContain("请先选择赛事");

    await activateTab(wrapper, "content");
    expect(wrapper.get('[data-action="preview-site-draft"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-preview-help]").text()).toContain("请先选择或新建内容");
  });

  it("keeps content preview disabled and explains that a selected content item is loading", async () => {
    let resolveContent;
    const contentLoad = new Promise((resolve) => { resolveContent = resolve; });
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [{ ...contentRow, id: "P1", title: "正在加载的内容" }] };
      if (path === "/api/admin/content/P1") return contentLoad;
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    await activateTab(wrapper, "content");
    await wrapper.get('[data-content-row="P1"]').trigger("click");

    expect(wrapper.get('[data-action="preview-site-draft"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-preview-help]").text()).toContain("内容加载中，请稍候");

    resolveContent({ row: { ...contentRow, id: "P1", slug: "loaded-content" } });
    await flushPromises();
    expect(wrapper.get('[data-action="preview-site-draft"]').attributes("disabled")).toBeUndefined();
  });

  it("keeps content preview disabled and reports a selected content load failure", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [{ ...contentRow, id: "P1", title: "加载失败的内容" }] };
      if (path === "/api/admin/content/P1") throw new Error("内容加载失败");
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    await activateTab(wrapper, "content");
    await wrapper.get('[data-content-row="P1"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-action="preview-site-draft"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-preview-help]").text()).toContain("内容加载失败，请重试");
    expect(wrapper.get("[data-preview-help]").text()).not.toContain("内容加载中");
  });

  it("distinguishes no content from a new unsaved draft and enables only draft preview", async () => {
    const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup);
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [] };
      if (path === "/api/admin/site-preview/content" && options.method === "POST") {
        return { preview: { payload: { row: { title: "未保存内容", bodyHtml: "<p>正文</p>" } }, context: { contentId: null } } };
      }
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await activateTab(wrapper, "content");

    const panel = wrapper.get('[data-site-panel="content"]');
    expect(panel.attributes("data-content-context")).toBe("none");
    expect(wrapper.get('[data-action="preview-site-draft"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-action="new-content"]').trigger("click");
    await flushPromises();

    expect(panel.attributes("data-content-context")).toBe("new");
    expect(wrapper.get('[data-action="preview-site-draft"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-action="preview-saved-site"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-content-field="title"]').setValue("未保存内容");
    await wrapper.get('[data-content-field="slug"]').setValue("unsaved-content");
    await wrapper.get('[data-action="preview-site-draft"]').trigger("click");
    await flushPromises();

    const preview = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/site-preview/content" && options?.method === "POST");
    expect(JSON.parse(preview[1].body)).toMatchObject({ title: "未保存内容", slug: "unsaved-content" });
    expect(JSON.parse(preview[1].body)).not.toHaveProperty("id");
    expect(apiMock.mock.calls.some(([path, options]) => path === "/api/admin/content" && options?.method === "POST")).toBe(false);
  });

  it.each(["published", "offline"])("previews an existing %s content draft from the page action without persisting it", async (status) => {
    const persisted = {
      ...contentRow,
      id: "P1",
      slug: `${status}-content`,
      title: `${status} 内容`,
      bodyHtml: `<p>${status} 正文</p>`,
      status,
      publishAt: "2026-01-01T00:00:00.000Z",
      pinned: true,
      sortOrder: 4,
      version: 7
    };
    const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup);
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [persisted] };
      if (path === "/api/admin/content/P1") return { row: persisted };
      if (path === "/api/admin/site-preview/content" && options.method === "POST") {
        return {
          preview: {
            payload: { row: { ...persisted, bodyHtml: `<p>服务端 ${status} 预览</p>` } },
            context: { eventId: "E1", contentId: "P1" }
          }
        };
      }
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await activateTab(wrapper, "content");
    await wrapper.get('[data-content-row="P1"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-action="preview-site-draft"]').trigger("click");
    await flushPromises();

    const preview = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/site-preview/content" && options?.method === "POST");
    expect(JSON.parse(preview[1].body)).toEqual({
      slug: `${status}-content`,
      eventId: "E1",
      type: "news",
      title: `${status} 内容`,
      summary: "摘要",
      bodyHtml: `<p>${status} 正文</p>`,
      status,
      publishAt: "2026-01-01T00:00:00.000Z",
      pinned: true,
      sortOrder: 4,
      coverMediaId: null,
      attachments: [],
      id: "P1",
      version: 7
    });
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toMatch(/^\/preview\?token=/);
    expect(popup.close).not.toHaveBeenCalled();
    expect(apiMock.mock.calls
      .filter(([, options]) => options?.method)
      .map(([path, options]) => [options.method, path]))
      .toEqual([["POST", "/api/admin/site-preview/content"]]);
  });

  it.each([
    ["hidden", { ...events[0] }, { ...profiles[0], isVisible: false }, "已保存赛事未在官网公开，官网不可访问。"],
    ["unpublished", { ...events[0], status: "draft" }, { ...profiles[0], isVisible: true }, "赛事尚未发布，官网不可访问。"]
  ])("disables a %s event saved preview with an explicit reason", async (_case, event, profile, reason) => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: [profile] };
      if (path === "/api/admin/events") return { rows: [event], projects: [] };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await activateTab(wrapper, "events");

    expect(wrapper.get('[data-action="preview-saved-site"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-saved-preview-help]").text()).toContain(reason);
  });

  it.each([
    ["draft", false, "当前赛事仍是草稿", true],
    ["published", false, "业务赛事已发布，但官网尚未公开", false],
    ["published", true, "官网已公开", false],
    ["archived", true, "将在历届赛事中展示", false],
    ["archived", false, "已归档且未在历届赛事展示", false]
  ])("explains %s event website state", async (status, isVisible, message, disabled) => {
    const originalStatus = events[0].status;
    const originalVisibility = profiles[0].isVisible;
    try {
      events[0].status = status;
      profiles[0].isVisible = isVisible;
      const wrapper = await mountLoaded();
      await activateTab(wrapper, "events");

      expect(wrapper.get("[data-event-publication-state]").text()).toContain(message);
      expect(wrapper.get('[data-profile-field="isVisible"]').element.disabled).toBe(disabled);
    } finally {
      events[0].status = originalStatus;
      profiles[0].isVisible = originalVisibility;
    }
  });

  it("forces a draft event profile save body to remain hidden when visibility is spoofed", async () => {
    const originalStatus = events[0].status;
    const originalVisibility = profiles[0].isVisible;
    try {
      events[0].status = "draft";
      profiles[0].isVisible = false;
      const wrapper = await mountLoaded();
      await activateTab(wrapper, "events");
      const visibility = wrapper.get('[data-profile-field="isVisible"]');
      visibility.element.disabled = false;
      await visibility.setValue(true);

      await wrapper.get('[data-action="save-profile"]').trigger("click");
      const request = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/event-public-profiles/E1" && options?.method === "PUT");

      expect(JSON.parse(request[1].body).isVisible).toBe(false);
    } finally {
      events[0].status = originalStatus;
      profiles[0].isVisible = originalVisibility;
    }
  });

  it.each([
    ["draft", null, "已保存内容仍是草稿，尚未公开。"],
    ["scheduled", "2099-01-01T00:00:00.000Z", "已保存内容为定时发布，尚未公开。"],
    ["offline", "2026-01-01T00:00:00.000Z", "已保存内容已下线，官网不可访问。"]
  ])("disables a saved %s content preview with an explicit reason", async (status, publishAt, reason) => {
    const persisted = {
      ...contentRow,
      id: "P1",
      slug: `${status}-content`,
      status,
      publishAt
    };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [persisted] };
      if (path === "/api/admin/content/P1") return { row: persisted };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await activateTab(wrapper, "content");
    await wrapper.get('[data-content-row="P1"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-site-panel="content"]').attributes("data-content-context")).toBe("existing");
    expect(wrapper.get('[data-action="preview-saved-site"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-saved-preview-help]").text()).toContain(reason);
  });

  it("opens only a truly public persisted content route and ignores an unsaved slug", async () => {
    const persisted = {
      ...contentRow,
      id: "P1",
      slug: "persisted-public-content",
      status: "published",
      publishAt: "2026-01-01T00:00:00.000Z"
    };
    const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup);
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [persisted] };
      if (path === "/api/admin/content/P1") return { row: persisted };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await activateTab(wrapper, "content");
    await wrapper.get('[data-content-row="P1"]').trigger("click");
    await flushPromises();

    const slug = wrapper.get('[data-content-field="slug"]');
    slug.element.disabled = false;
    await slug.setValue("unsaved-route");
    expect(wrapper.get('[data-action="preview-saved-site"]').attributes("disabled")).toBeUndefined();

    await wrapper.get('[data-action="preview-saved-site"]').trigger("click");
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe("/content/persisted-public-content");
    expect(wrapper.find("[data-preview-fallback]").exists()).toBe(false);
  });

  it("stacks preview actions into a full-width mobile action row", () => {
    const css = readFileSync("src/styles/admin.css", "utf8");

    expect(css).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.site-content-page \.page-title-row \{[\s\S]*?flex-direction:\s*column;/);
    expect(css).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.site-preview-actions \{[\s\S]*?width:\s*100%;[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.site-preview-actions button \{[\s\S]*?width:\s*100%;/);
  });

  it("shows API validation errors and closes the pre-opened preview", async () => {
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup);
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/site-preview/homepage" && options.method === "POST") throw new Error("平台简介超过长度限制");
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    await wrapper.get('[data-action="preview-site-draft"]').trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-preview-error]").text()).toContain("平台简介超过长度限制");
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it("reports snapshot storage errors without saving or publishing", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("浏览器存储不可用");
    });
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup);
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/site-preview/homepage" && options.method === "POST") return { preview: { payload: {}, context: {} } };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    await wrapper.get('[data-action="preview-site-draft"]').trigger("click");
    await flushPromises();

    expect(setItem).toHaveBeenCalled();
    expect(wrapper.get("[data-preview-error]").text()).toContain("浏览器存储不可用");
    expect(popup.close).toHaveBeenCalledOnce();
    expect(apiMock.mock.calls.some(([path, options]) => options?.method === "PATCH" || path.includes("/publish"))).toBe(false);
  });

  it("shows a fallback preview link when the browser blocks the popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/site-preview/homepage" && options.method === "POST") return { preview: { payload: {}, context: {} } };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    await wrapper.get('[data-action="preview-site-draft"]').trigger("click");
    await flushPromises();

    const fallback = wrapper.get("[data-preview-fallback]");
    expect(fallback.attributes("href")).toMatch(/^\/preview\?token=/);
    expect(fallback.attributes("target")).toBe("_blank");
  });

  it("falls back to automatic selection when the stored featured event is no longer configurable", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings, featuredEventId: "E2" } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();

    expect(wrapper.get('[data-field="featuredEventId"]').element.value).toBe("");
  });

  it("saves only whitelisted homepage fields with the current version", async () => {
    const wrapper = await mountLoaded();
    await wrapper.get('[data-field="platformIntro"]').setValue("新平台简介");
    await wrapper.get('[data-field="organizers"]').setValue("主办单位\n协办单位");
    await wrapper.get('[data-action="save-settings"]').trigger("click");
    await flushPromises();

    const call = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/site-settings" && options?.method === "PATCH");
    expect(JSON.parse(call[1].body)).toEqual({
      version: 3,
      featuredEventId: "E1",
      platformIntro: "新平台简介",
      organizers: ["主办单位", "协办单位"],
      contact: "0577-12345678",
      icp: "浙ICP备00000000号",
      seoTitle: "航空比赛",
      seoDescription: "赛事资讯",
      defaultHeroMediaId: null,
      shareMediaId: null
    });
    expect(wrapper.text()).toContain("首页设置已保存");
  });

  it("keeps homepage edits and explains a version conflict", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings" && options.method === "PATCH") {
        throw Object.assign(new Error("版本冲突"), { status: 409 });
      }
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await wrapper.get('[data-field="platformIntro"]').setValue("未保存简介");
    await wrapper.get('[data-action="save-settings"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("配置已被其他管理员更新，请刷新后重试");
    expect(wrapper.get('[data-field="platformIntro"]').element.value).toBe("未保存简介");
  });

  it("offers a retry when initial loading fails", async () => {
    apiMock.mockRejectedValueOnce(new Error("网络暂时不可用"));
    const wrapper = mount(SiteContentPage);
    await flushPromises();

    expect(wrapper.text()).toContain("网络暂时不可用");
    expect(wrapper.find('[data-action="retry-load"]').exists()).toBe(true);

    installSuccessfulApi();
    await wrapper.get('[data-action="retry-load"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-field="platformIntro"]').element.value).toBe("原平台简介");
  });

  it("switches accessible tabs without reloading or losing homepage edits", async () => {
    const wrapper = await mountLoaded();
    const initialLoads = apiMock.mock.calls.length;
    await wrapper.get('[data-field="platformIntro"]').setValue("暂存在本页");

    await wrapper.get('[data-site-tab="content"]').trigger("click");
    expect(wrapper.get('[data-site-panel="content"]').text()).toContain("内容列表");
    await wrapper.get('[data-site-tab="homepage"]').trigger("click");

    expect(wrapper.get('[data-field="platformIntro"]').element.value).toBe("暂存在本页");
    expect(apiMock.mock.calls).toHaveLength(initialLoads);
  });

  it("uses roving tabindex and moves focus with horizontal arrow keys", async () => {
    const wrapper = await mountLoaded({ attachTo: document.body });
    const homepage = wrapper.get('[data-site-tab="homepage"]');
    const eventsTab = wrapper.get('[data-site-tab="events"]');
    const content = wrapper.get('[data-site-tab="content"]');

    expect(homepage.attributes("tabindex")).toBe("0");
    expect(eventsTab.attributes("tabindex")).toBe("-1");
    expect(content.attributes("tabindex")).toBe("-1");

    await homepage.trigger("keydown", { key: "ArrowRight" });
    expect(eventsTab.attributes("aria-selected")).toBe("true");
    expect(eventsTab.attributes("tabindex")).toBe("0");
    expect(document.activeElement).toBe(eventsTab.element);
    expect(wrapper.get('[data-site-panel="events"]').isVisible()).toBe(true);

    await eventsTab.trigger("keydown", { key: "ArrowLeft" });
    expect(homepage.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(homepage.element);

    await homepage.trigger("keydown", { key: "ArrowLeft" });
    expect(content.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(content.element);
    wrapper.unmount();
  });

  it("moves to the first and last tab with Home and End", async () => {
    const wrapper = await mountLoaded({ attachTo: document.body });
    const homepage = wrapper.get('[data-site-tab="homepage"]');
    const eventsTab = wrapper.get('[data-site-tab="events"]');
    const content = wrapper.get('[data-site-tab="content"]');

    await homepage.trigger("keydown", { key: "End" });
    expect(content.attributes("aria-selected")).toBe("true");
    expect(content.attributes("tabindex")).toBe("0");
    expect(document.activeElement).toBe(content.element);
    expect(wrapper.get('[data-site-panel="content"]').isVisible()).toBe(true);

    await content.trigger("keydown", { key: "Home" });
    expect(homepage.attributes("aria-selected")).toBe("true");
    expect(homepage.attributes("tabindex")).toBe("0");
    expect(eventsTab.attributes("tabindex")).toBe("-1");
    expect(content.attributes("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(homepage.element);
    expect(wrapper.get('[data-site-panel="homepage"]').isVisible()).toBe(true);
    wrapper.unmount();
  });

  it("edits only public profile fields while showing event facts as read only", async () => {
    const wrapper = await mountLoaded();
    await wrapper.get('[data-site-tab="events"]').trigger("click");

    expect(wrapper.get('[data-event-facts="E1"]').text()).toContain("2026年11月");
    expect(wrapper.get('[data-event-facts="E1"]').text()).toContain("温州");
    await wrapper.get('[data-profile-field="slogan"]').setValue("飞向未来");
    await wrapper.get('[data-action="save-profile"]').trigger("click");
    await flushPromises();

    const call = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/event-public-profiles/E1" && options?.method === "PUT");
    expect(JSON.parse(call[1].body)).toEqual({
      version: 2,
      slug: "event-2026",
      slogan: "飞向未来",
      summary: "原摘要",
      isVisible: true,
      displayOrder: 1,
      heroMediaId: null
    });
    expect(wrapper.text()).toContain("赛事视觉设置已保存");
  });

  it("does not overwrite an unsaved event profile when another event is selected", async () => {
    const wrapper = await mountLoaded();
    await wrapper.get('[data-site-tab="events"]').trigger("click");
    await wrapper.get('[data-profile-field="slogan"]').setValue("未保存宣传语");

    await wrapper.get('[data-event-select="E2"]').trigger("click");

    expect(wrapper.text()).toContain("请先保存或放弃当前修改");
    expect(wrapper.get('[data-event-editor]').attributes("data-event-editor")).toBe("E1");
    expect(wrapper.get('[data-profile-field="slogan"]').element.value).toBe("未保存宣传语");
  });

  it("uploads an image before saving its media id and keeps it when the profile save fails", async () => {
    let saveAttempts = 0;
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/site-media" && options.method === "POST") return { row: { id: "MEDIA-UPLOADED" } };
      if (path === "/api/admin/event-public-profiles/E1") {
        saveAttempts += 1;
        if (saveAttempts === 1) throw Object.assign(new Error("slug已存在"), { status: 409 });
        return { row: { ...profiles[0], ...JSON.parse(options.body), version: 3 } };
      }
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await wrapper.get('[data-site-tab="events"]').trigger("click");
    const file = new File(["png"], "cover.png", { type: "image/png" });
    Object.defineProperty(wrapper.get('[data-action="upload-profile-cover"]').element, "files", { value: [file] });
    await wrapper.get('[data-action="upload-profile-cover"]').trigger("change");
    await flushPromises();

    expect(wrapper.text()).toContain("slug已存在");
    expect(wrapper.get('[data-profile-media-id]').text()).toContain("MEDIA-UPLOADED");

    await wrapper.get('[data-action="save-profile"]').trigger("click");
    await flushPromises();
    const requests = apiMock.mock.calls.filter(([path]) => path === "/api/admin/event-public-profiles/E1");
    expect(JSON.parse(requests[1][1].body).heroMediaId).toBe("MEDIA-UPLOADED");
  });

  it("does not save a media id when upload fails and removing an image only clears the reference", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-settings" && options.method === "PATCH") return { row: { ...settings, ...JSON.parse(options.body), version: 4 } };
      if (path === "/api/admin/site-settings") return { row: { ...settings, defaultHeroMediaId: "MEDIA-OLD" } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/site-media") throw new Error("图片上传失败");
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    const file = new File(["bad"], "bad.svg", { type: "image/svg+xml" });
    Object.defineProperty(wrapper.get('[data-action="upload-default-hero"]').element, "files", { value: [file] });
    await wrapper.get('[data-action="upload-default-hero"]').trigger("change");
    await flushPromises();
    expect(wrapper.text()).toContain("图片上传失败");

    await wrapper.get('[data-action="remove-default-hero"]').trigger("click");
    await wrapper.get('[data-action="save-settings"]').trigger("click");
    await flushPromises();
    const save = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/site-settings" && options?.method === "PATCH");
    expect(JSON.parse(save[1].body).defaultHeroMediaId).toBeNull();
    expect(apiMock.mock.calls.some(([path, options]) => path.includes("MEDIA-OLD") && options?.method === "DELETE")).toBe(false);
  });

  it("loads content management with type, event, status and keyword filters", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [
        { ...contentRow, id: "P1", title: "公开新闻", type: "news", status: "published", eventId: "E1", slug: "news-1" },
        { ...contentRow, id: "P2", title: "草稿公告", type: "announcement", status: "draft", eventId: null, slug: "notice-1" }
      ] };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await wrapper.get('[data-site-tab="content"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-content-filter="type"]').exists()).toBe(true);
    expect(wrapper.get('[data-content-filter="eventId"]').exists()).toBe(true);
    expect(wrapper.get('[data-content-filter="status"]').exists()).toBe(true);
    await wrapper.get('[data-content-filter="keyword"]').setValue("新闻");
    expect(wrapper.findAll('[data-content-row]')).toHaveLength(1);
    expect(wrapper.text()).toContain("已发布");
  });

  it("shows only the list until the administrator chooses new or edit", async () => {
    const wrapper = await mountLoaded();
    await activateTab(wrapper, "content");
    await flushPromises();

    expect(wrapper.find(".content-list-panel").exists()).toBe(true);
    expect(wrapper.find(".content-editor-panel").exists()).toBe(false);

    await wrapper.get('[data-action="new-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".content-list-panel").exists()).toBe(false);
    expect(wrapper.find(".content-editor-panel").exists()).toBe(true);
    expect(wrapper.get('[data-action="back-to-content-list"]').exists()).toBe(true);
  });

  it("returns focus to the content-list control after leaving publication review", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [{ ...contentRow, id: "P1", status: "draft" }] };
      if (path === "/api/admin/content/P1") return { row: { ...contentRow, id: "P1", status: "draft" } };
      return { rows: [] };
    });
    const wrapper = await mountLoaded({ attachTo: document.body });
    await activateTab(wrapper, "content");
    await wrapper.get('[data-content-row="P1"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await wrapper.get('[data-action="back-to-editor"]').trigger("click");
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('[data-action="back-to-content-list"]').element);
    wrapper.unmount();
  });

  it("returns to the list only after unsaved edits are explicitly discarded", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/site-settings") return { row: { ...settings } };
      if (path === "/api/admin/event-public-profiles") return { rows: profiles };
      if (path === "/api/admin/events") return { rows: events, projects: [] };
      if (path === "/api/admin/content") return { rows: [
        { ...contentRow, id: "P1", title: "第一篇", type: "news", status: "draft", slug: "first" },
        { ...contentRow, id: "P2", title: "第二篇", type: "news", status: "draft", slug: "second" }
      ] };
      if (path === "/api/admin/content/P1") return { row: { ...contentRow, id: "P1", title: "第一篇", status: "draft", slug: "first" } };
      if (path === "/api/admin/content/P2") return { row: { ...contentRow, id: "P2", title: "第二篇", status: "draft", slug: "second" } };
      return { rows: [] };
    });
    const wrapper = await mountLoaded();
    await wrapper.get('[data-site-tab="content"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-content-row="P1"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-content-field="title"]').setValue("尚未保存");
    await wrapper.get('[data-action="back-to-content-list"]').trigger("click");
    expect(wrapper.get('[role="dialog"]').text()).toContain("放弃未保存修改");
    expect(wrapper.get('[data-content-field="title"]').element.value).toBe("尚未保存");
    await wrapper.get('[data-action="confirm-discard-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".content-editor-panel").exists()).toBe(false);
    expect(wrapper.find(".content-list-panel").exists()).toBe(true);
  });
});
