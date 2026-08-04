import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import OrganizationRegistrationRecordsPage from "../OrganizationRegistrationRecordsPage.vue";

const payload = {
  rows: [
    {
      id: "R1", eventId: "E1", eventName: "春季航空赛", projectId: "P1", projectName: "纸飞机",
      athlete: { name: "张三", school: "实验小学", grade: "五年级" }, status: "approved", score: "98", awardName: "一等奖"
    },
    {
      id: "R2", eventId: "E2", eventName: "夏季无人机赛", projectId: "P2", projectName: "无人机",
      athlete: { name: "李四", school: "航空学校", grade: "六年级" }, status: "pending", score: "", awardName: ""
    }
  ],
  total: 27,
  page: 1,
  pageSize: 25,
  refreshedAt: "2026-08-04T00:00:00.000Z",
  filterOptions: {
    events: [{ id: "E1", name: "春季航空赛" }, { id: "E2", name: "夏季无人机赛" }],
    projects: [{ id: "P1", name: "纸飞机" }, { id: "P2", name: "无人机" }]
  }
};

describe("OrganizationRegistrationRecordsPage", () => {
  beforeEach(() => apiMock.mockReset());

  it("loads cross-event records and sends encoded filters with pagination", async () => {
    apiMock.mockResolvedValue(payload);
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/registrations?page=1&pageSize=25");
    expect(wrapper.text()).toContain("春季航空赛");
    expect(wrapper.text()).toContain("张三");
    expect(wrapper.text()).toContain("成绩 98");
    expect(wrapper.text()).toContain("一等奖");

    await wrapper.get('[data-filter="organization-records-q"]').setValue("张 三");
    await wrapper.get('[data-filter="organization-records-event"]').setValue("E2");
    await wrapper.get('[data-filter="organization-records-project"]').setValue("P2");
    await wrapper.get('[data-filter="organization-records-status"]').setValue("approved");
    await flushPromises();

    expect(apiMock).toHaveBeenLastCalledWith("/api/organization/registrations?q=%E5%BC%A0+%E4%B8%89&eventId=E2&projectId=P2&status=approved&page=1&pageSize=25");
    expect(wrapper.get('[data-action="organization-records-next"]').attributes("disabled")).toBeUndefined();
  });

  it("shows an empty state when the organization has no matching registrations", async () => {
    apiMock.mockResolvedValue({ ...payload, rows: [], total: 0 });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.get(".empty-state").text()).toContain("暂无报名记录");
    expect(wrapper.get('[data-action="organization-records-previous"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-action="organization-records-next"]').attributes("disabled")).toBeDefined();
  });

  it("shows a safe loading error and retries without rendering server HTML", async () => {
    apiMock.mockRejectedValueOnce(new Error("<!DOCTYPE html><html>gateway failure</html>"));
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("报名记录加载失败，请重试");
    expect(wrapper.text()).not.toContain("<!DOCTYPE html>");

    apiMock.mockResolvedValueOnce(payload);
    await wrapper.get('[data-action="retry-organization-records"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("张三");
  });
});
