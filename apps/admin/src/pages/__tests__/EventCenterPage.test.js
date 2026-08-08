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
    expect(wrapper.text()).not.toContain("当前报名");
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

  it("shows a retry action when loading the event center fails", async () => {
    apiMock
      .mockRejectedValueOnce(new Error("赛事服务暂不可用"))
      .mockResolvedValueOnce({ rows: [{ event: { id: "E1", name: "赛事一" }, registrationState: "open" }] });
    const wrapper = mount(EventCenterPage, { props: { accountType: "ordinary" } });
    await flushPromises();

    expect(wrapper.text()).toContain("赛事服务暂不可用");
    await wrapper.get('[data-action="retry-event-center"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll("[data-event-card]")).toHaveLength(1);
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

  it("lets an organization click a dated available event to join and open its workspace", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/events") return { rows: [{
        event: { id: "E-DATED", name: "绘画比赛", date: "2026年9月1日" },
        registrationState: "open",
        participationState: "available",
        summary: { registrationCount: 0, pendingRegistrationCount: 0, certificateCount: 0 }
      }] };
      if (path === "/api/organization/events/E-DATED/join" && options?.method === "POST") {
        return { row: { organizationId: "O1", eventId: "E-DATED" } };
      }
      return { rows: [] };
    });
    const wrapper = mount(EventCenterPage, { props: { accountType: "organization" } });
    await flushPromises();

    expect(wrapper.text()).toContain("可加入");
    expect(wrapper.find('[data-action="join-event"]').exists()).toBe(true);
    await wrapper.get('[data-event-card="E-DATED"]').trigger("click");
    await flushPromises();

    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/me/events",
      "/api/organization/events/E-DATED/join"
    ]);
    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E-DATED/join", { method: "POST" });
    expect(wrapper.emitted("open-event")[0][0]).toEqual({ eventId: "E-DATED", mode: "organizationWorkspace" });
  });

  it("translates stable organization access codes instead of exposing server wording", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/events") return { rows: [{
        event: { id: "E-BLOCKED", name: "受限赛事" },
        registrationState: "open",
        participationState: "available"
      }] };
      if (path === "/api/organization/events/E-BLOCKED/join") {
        throw Object.assign(new Error("raw server wording"), { code: "ORGANIZATION_REVIEW_PENDING" });
      }
      return { rows: [] };
    });
    const wrapper = mount(EventCenterPage, { props: { accountType: "organization" } });
    await flushPromises();
    await wrapper.get('[data-event-card="E-BLOCKED"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("组织资质正在审核中");
    expect(wrapper.text()).not.toContain("raw server wording");
    expect(wrapper.emitted("access-denied")?.[0]?.[0]).toMatchObject({ code: "ORGANIZATION_REVIEW_PENDING" });
  });

  it("reports a stable organization restriction while loading events", async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("stale list"), { code: "ORGANIZATION_DISABLED" }));
    const wrapper = mount(EventCenterPage, { props: { accountType: "organization" } });
    await flushPromises();

    expect(wrapper.emitted("access-denied")?.[0]?.[0]).toMatchObject({ code: "ORGANIZATION_DISABLED" });
  });

  it("opens a joined organization event when the card itself is clicked", async () => {
    apiMock.mockResolvedValue({ rows: [{
      event: { id: "E-JOINED", name: "已加入赛事", date: "2026年10月1日" },
      registrationState: "open",
      participationState: "joined",
      summary: { registrationCount: 2, pendingRegistrationCount: 1, certificateCount: 0 }
    }] });
    const wrapper = mount(EventCenterPage, { props: { accountType: "organization" } });
    await flushPromises();

    await wrapper.get('[data-event-card="E-JOINED"]').trigger("click");

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("open-event")[0][0]).toEqual({ eventId: "E-JOINED", mode: "organizationWorkspace" });
  });
});
