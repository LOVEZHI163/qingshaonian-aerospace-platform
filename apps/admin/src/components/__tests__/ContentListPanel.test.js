import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import ContentListPanel from "../ContentListPanel.vue";

const events = [
  { id: "E1", name: "第一场赛事" },
  { id: "E2", name: "第二场赛事" }
];
const rows = [
  { id: "P1", title: "首篇新闻", slug: "first", summary: "赛事报道", type: "news", status: "published", eventId: "E1" },
  { id: "P2", title: "活动预告", slug: "second", summary: "参赛须知", type: "announcement", status: "draft", eventId: "E2" }
];

async function mountLoaded(options = {}) {
  const wrapper = mount(ContentListPanel, { props: { events, ...options.props }, ...options });
  await flushPromises();
  return wrapper;
}

describe("ContentListPanel", () => {
  beforeEach(() => apiMock.mockReset());

  it("matches an event name in keyword search and clears filters", async () => {
    apiMock.mockResolvedValue({ rows });
    const wrapper = await mountLoaded();

    expect(wrapper.get("[data-content-list-count]").text()).toContain("2 条");
    await wrapper.get('[data-content-filter="keyword"]').setValue("第二场赛事");
    expect(wrapper.findAll("[data-content-row]")).toHaveLength(1);
    await wrapper.get('[data-action="clear-content-filters"]').trigger("click");
    expect(wrapper.findAll("[data-content-row]")).toHaveLength(2);
  });

  it("guides administrators when no website content has been created", async () => {
    apiMock.mockResolvedValue({ rows: [] });
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain("尚未创建官网内容");
  });

  it("explains when active filters have no matching content", async () => {
    apiMock.mockResolvedValue({ rows });
    const wrapper = await mountLoaded();
    await wrapper.get('[data-content-filter="keyword"]').setValue("不存在的内容");

    expect(wrapper.text()).toContain("没有符合条件的内容");
  });
});
