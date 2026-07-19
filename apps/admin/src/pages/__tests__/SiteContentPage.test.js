import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import SiteContentPage from "../SiteContentPage.vue";

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

async function mountLoaded() {
  const wrapper = mount(SiteContentPage);
  await flushPromises();
  return wrapper;
}

describe("SiteContentPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    installSuccessfulApi();
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
    expect(wrapper.get('[data-site-panel="content"]').text()).toContain("内容管理将在下一步接入");
    await wrapper.get('[data-site-tab="homepage"]').trigger("click");

    expect(wrapper.get('[data-field="platformIntro"]').element.value).toBe("暂存在本页");
    expect(apiMock.mock.calls).toHaveLength(initialLoads);
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
});
