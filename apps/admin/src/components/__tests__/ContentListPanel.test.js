import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import ContentListPanel from "../ContentListPanel.vue";

const events = [
  { id: "E1", name: "第一场赛事", status: "published" },
  { id: "E2", name: "第二场赛事", status: "published" }
];
const rows = [
  {
    id: "P1", title: "首篇新闻", slug: "first", summary: "赛事报道", type: "news",
    status: "published", eventId: "E1", publishAt: "2026-01-02T00:00:00.000Z",
    pinned: true, sortOrder: 2, updatedAt: "2026-07-20T08:30:00.000Z"
  },
  {
    id: "P2", title: "活动预告", slug: "second", summary: "参赛须知", type: "announcement",
    status: "draft", eventId: null, publishAt: null, pinned: false, sortOrder: 0,
    updatedAt: "2026-07-21T09:45:00.000Z"
  }
];

async function mountLoaded(options = {}) {
  const wrapper = mount(ContentListPanel, { props: { events, ...options.props }, ...options });
  await flushPromises();
  return wrapper;
}

describe("ContentListPanel", () => {
  beforeEach(() => apiMock.mockReset());

  it("offers content repost next to new content and emits import", async () => {
    apiMock.mockResolvedValue({ rows });
    const wrapper = await mountLoaded();
    const actions = wrapper.get(".panel-title .form-actions").findAll("button");

    expect(actions.map((button) => button.text())).toEqual(["刷新", "转载内容", "新建内容"]);
    await wrapper.get('[data-action="import-content"]').trigger("click");
    expect(wrapper.emitted("import")).toEqual([[]]);
  });

  it("matches an event name in keyword search and clears filters", async () => {
    apiMock.mockResolvedValue({ rows });
    const wrapper = await mountLoaded();

    expect(wrapper.get("[data-content-list-count]").text()).toContain("2 条");
    await wrapper.get('[data-content-filter="keyword"]').setValue("第一场赛事");
    expect(wrapper.findAll("[data-content-row]")).toHaveLength(1);
    await wrapper.get('[data-action="clear-content-filters"]').trigger("click");
    expect(wrapper.findAll("[data-content-row]")).toHaveLength(2);
  });

  it("guides administrators when no website content has been created", async () => {
    apiMock.mockResolvedValue({ rows: [] });
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain("尚未创建官网内容");
    expect(wrapper.text()).toContain("创建新闻动态、通知公告或赛事资料");
    await wrapper.get('[data-action="create-first-content"]').trigger("click");
    expect(wrapper.emitted("new")).toEqual([[]]);
  });

  it("uses the approved content names in the filter and rendered rows", async () => {
    apiMock.mockResolvedValue({ rows: [
      { ...rows[0], id: "NEWS", type: "news" },
      { ...rows[1], id: "NOTICE", type: "announcement" },
      { ...rows[1], id: "RECAP", type: "recap", title: "赛后报道" }
    ] });
    const wrapper = await mountLoaded();

    const options = wrapper.get('[data-content-filter="type"]').findAll("option");
    expect(options.map((option) => [option.attributes("value"), option.text()])).toEqual([
      ["", "全部类型"],
      ["announcement", "通知公告"],
      ["news", "新闻动态"],
      ["work", "优秀作品"],
      ["recap", "赛事回顾"],
      ["guide", "参赛指南"]
    ]);
    expect(wrapper.get('[data-content-row="NEWS"]').text()).toContain("新闻动态");
    expect(wrapper.get('[data-content-row="NOTICE"]').text()).toContain("通知公告");
    expect(wrapper.get('[data-content-row="RECAP"]').text()).toContain("赛事回顾");
  });

  it("keeps the no-content guidance when an empty list has active filters", async () => {
    apiMock.mockResolvedValue({ rows: [] });
    const wrapper = await mountLoaded();
    await wrapper.get('[data-content-filter="keyword"]').setValue("赛事");

    expect(wrapper.text()).toContain("尚未创建官网内容");
    expect(wrapper.text()).not.toContain("没有符合条件的内容");
  });

  it("explains when active filters have no matching content", async () => {
    apiMock.mockResolvedValue({ rows });
    const wrapper = await mountLoaded();
    await wrapper.get('[data-content-filter="keyword"]').setValue("不存在的内容");

    expect(wrapper.text()).toContain("没有符合条件的内容");
    await wrapper.get('[data-action="clear-empty-content-filters"]').trigger("click");
    expect(wrapper.findAll("[data-content-row]")).toHaveLength(2);
  });

  it("filters platform-wide content explicitly", async () => {
    apiMock.mockResolvedValue({ rows });
    const wrapper = await mountLoaded();

    expect(wrapper.get('[data-content-filter="eventId"]').findAll("option").map((option) => option.text()))
      .toContain("平台通用");
    await wrapper.get('[data-content-filter="eventId"]').setValue("__platform__");

    expect(wrapper.findAll("[data-content-row]")).toHaveLength(1);
    expect(wrapper.get('[data-content-row="P2"]').text()).toContain("平台通用");
  });

  it("shows complete row facts and exposes separate edit and public-preview actions", async () => {
    apiMock.mockResolvedValue({ rows });
    const wrapper = await mountLoaded();

    const published = wrapper.get('[data-content-row="P1"]');
    expect(published.text()).toContain("第一场赛事");
    expect(published.text()).toContain("置顶");
    expect(published.text()).toContain("排序 2");
    expect(published.text()).toContain("2026");
    expect(published.get('[data-action="preview-public-content"]').attributes("href")).toBe("/content/first");
    expect(published.get('[data-action="preview-public-content"]').attributes("target")).toBe("_blank");

    const platformDraft = wrapper.get('[data-content-row="P2"]');
    expect(platformDraft.text()).toContain("平台通用");
    expect(platformDraft.find('[data-action="preview-public-content"]').exists()).toBe(false);
    await platformDraft.get('[data-action="edit-content"]').trigger("click");
    expect(wrapper.emitted("select")).toEqual([["P2"]]);
  });

  it("shows schedule details but never offers public preview before content is actually public", async () => {
    apiMock.mockResolvedValue({ rows: [
      {
        ...rows[0],
        id: "S1",
        slug: "scheduled",
        status: "scheduled",
        publishAt: "2099-01-02T04:30:00.000Z",
        pinned: false
      },
      {
        ...rows[0],
        id: "F1",
        slug: "future-published",
        status: "published",
        publishAt: "2099-01-02T04:30:00.000Z"
      }
    ] });
    const wrapper = await mountLoaded();

    expect(wrapper.get('[data-content-row="S1"]').text()).toContain("定时至");
    expect(wrapper.get('[data-content-row="S1"]').text()).toContain("2099");
    expect(wrapper.get('[data-content-row="S1"]').find('[data-action="preview-public-content"]').exists()).toBe(false);
    expect(wrapper.get('[data-content-row="F1"]').find('[data-action="preview-public-content"]').exists()).toBe(false);
  });

  it("clamps the current page after refresh reduces the number of pages", async () => {
    const elevenRows = Array.from({ length: 11 }, (_, index) => ({
      ...rows[0], id: `P${index + 1}`, title: `内容 ${index + 1}`
    }));
    apiMock.mockResolvedValueOnce({ rows: elevenRows }).mockResolvedValueOnce({ rows: elevenRows.slice(0, 10) });
    const wrapper = await mountLoaded();
    const nextPage = wrapper.findAll("button").find((button) => button.text() === "下一页");
    await nextPage.trigger("click");
    expect(wrapper.findAll("[data-content-row]")).toHaveLength(1);

    const refresh = wrapper.findAll("button").find((button) => button.text() === "刷新");
    await refresh.trigger("click");
    await flushPromises();

    expect(wrapper.findAll("[data-content-row]")).toHaveLength(10);
    expect(wrapper.findAll("button").some((button) => button.text() === "下一页")).toBe(false);
  });
});
