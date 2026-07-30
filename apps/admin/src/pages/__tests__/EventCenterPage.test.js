import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import EventCenterPage from "../EventCenterPage.vue";

describe("EventCenterPage", () => {
  beforeEach(() => apiMock.mockReset());

  it("renders one to three concurrent events and emits the selected event", async () => {
    apiMock.mockResolvedValue({
      rows: [
        { event: { id: "E1", name: "赛事一" }, registrationState: "open", registrationCount: 1 },
        { event: { id: "E2", name: "赛事二" }, registrationState: "not_started", registrationCount: 0 },
        { event: { id: "E3", name: "赛事三" }, registrationState: "closed", registrationCount: 2 }
      ]
    });
    const wrapper = mount(EventCenterPage, { props: { accountType: "ordinary" } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/me/events");
    expect(wrapper.findAll("[data-event-card]")).toHaveLength(3);
    expect(wrapper.text()).toContain("报名中");
    expect(wrapper.text()).toContain("未开始");
    expect(wrapper.text()).toContain("已截止");
    await wrapper.get('[data-event-card="E2"] [data-action="open"]').trigger("click");
    expect(wrapper.emitted("open-event")[0][0]).toEqual({ eventId: "E2", mode: "registration" });
  });

  it("shows an empty state when the account cannot access an event", async () => {
    apiMock.mockResolvedValue({ rows: [] });
    const wrapper = mount(EventCenterPage, { props: { accountType: "organization" } });
    await flushPromises();

    expect(wrapper.text()).toContain("暂无可访问赛事");
  });

  it("shows organization participation availability without performing a join", async () => {
    apiMock.mockResolvedValue({ rows: [
      { event: { id: "E1", name: "赛事一" }, registrationState: "open", participationState: "available" },
      { event: { id: "E2", name: "赛事二" }, registrationState: "open", participationState: "joined" },
      { event: { id: "E3", name: "赛事三" }, registrationState: "closed", participationState: "blocked" }
    ] });
    const wrapper = mount(EventCenterPage, { props: { accountType: "organization" } });
    await flushPromises();

    expect(wrapper.text()).toContain("可加入");
    expect(wrapper.text()).toContain("已加入");
    expect(wrapper.text()).toContain("资质不可用");
  });
});
