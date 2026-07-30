import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));

import EventCenterPage from "../EventCenterPage.vue";
import OrganizationAthleteRegistrationForm from "../../components/OrganizationAthleteRegistrationForm.vue";
import OrganizationEventWorkspacePage from "../OrganizationEventWorkspacePage.vue";

const event = { id: "E2", name: "赛事二", status: "published" };
const registration = {
  id: "R1", athlete: { name: "张三", school: "航空学校", grade: "五年级", phone: "13800000000" },
  projectId: "P1", projectName: "无人机", status: "approved", awardName: "一等奖", rank: "1", score: "95"
};

describe("OrganizationEventWorkspacePage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return {
        event,
        summary: { registrationCount: 1, pendingRegistrationCount: 0, certificateCount: 1 },
        projects: [{ id: "P1", name: "无人机" }],
        registrations: [registration]
      };
      if (path === "/api/organization/events/E2/registrations") return { rows: [registration] };
      if (path === "/api/organization/events/E2/certificates") return { rows: [] };
      return { rows: [] };
    });
  });

  it("loads the selected event workspace through its explicit event endpoint", async () => {
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/workspace");
    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations");
    expect(wrapper.text()).toContain("赛事二");
    await wrapper.get('[data-workspace-tab="records"]').trigger("click");
    expect(wrapper.text()).toContain("张三");
  });

  it("submits organization athletes only to the explicit event endpoint and reports a merge", async () => {
    apiMock.mockResolvedValueOnce({ merged: true, row: registration });
    const wrapper = mount(OrganizationAthleteRegistrationForm, {
      props: { eventId: "E2", projects: [{ id: "P1", name: "无人机" }] }
    });
    await wrapper.get('[data-field="athlete-name"]').setValue("张三");
    await wrapper.get('input[placeholder="输入或选择学校"]').setValue("航空学校");
    await wrapper.get('[data-field="athlete-grade"]').setValue("五年级");
    await wrapper.get('[data-field="athlete-phone"]').setValue("13800000000");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ athlete: { name: "张三", school: "航空学校", grade: "五年级", phone: "13800000000" }, projectId: "P1", instructor: "" })
    }));
    expect(wrapper.text()).toContain("已与现有个人报名合并，未重复创建");
    expect(wrapper.find("select[data-field=organization]").exists()).toBe(false);
  });

  it("joins an available event idempotently and opens its workspace", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/events") return { rows: [{ event, participationState: "available", registrationState: "open" }] };
      if (path === "/api/organization/events/E2/join" && options?.method === "POST") return { row: { organizationId: "O1", eventId: "E2" } };
      return { rows: [] };
    });
    const wrapper = mount(EventCenterPage, { props: { accountType: "organization" } });
    await flushPromises();
    await wrapper.get('[data-action="join-event"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/join", { method: "POST" });
    expect(wrapper.emitted("open-event")[0][0]).toEqual({ eventId: "E2", mode: "organizationWorkspace" });
  });

  it("keeps archived workspaces read-only while retaining results and certificates", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return { event: { ...event, archivedAt: "2026-01-01" }, summary: {}, registrations: [registration] };
      if (path === "/api/organization/events/E2/registrations") return { rows: [registration] };
      if (path === "/api/organization/events/E2/certificates") return { rows: [{ id: "C1", athlete: registration.athlete, projectName: "无人机", title: "获奖证书" }] };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    expect(wrapper.find('[data-testid="organization-registration-form"]').exists()).toBe(false);
    await wrapper.get('[data-workspace-tab="results"]').trigger("click");
    expect(wrapper.text()).toContain("一等奖");
    await wrapper.get('[data-workspace-tab="certificates"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("获奖证书");
  });
});
