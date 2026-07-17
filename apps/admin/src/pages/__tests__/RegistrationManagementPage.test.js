import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));

import RegistrationManagementPage from "../RegistrationManagementPage.vue";

const event = { id: "E1", name: "2026 航空赛事", isCurrent: true };
const project = { id: "P1", eventId: "E1", name: "纸飞机", allowedGroups: ["小学低段"] };
const registration = {
  id: "R1", eventId: "E1", organizationId: "O1", organization: "实验小学", athlete: { name: "张三", school: "实验小学", grade: "三年级", phone: "13800000000" },
  group: "小学低段", projectId: "P1", projectName: "纸飞机", projectType: "individual", instructor: "林老师", status: "pending"
};

function mockLoads() {
  apiMock.mockImplementation(async (path) => {
    if (path === "/api/admin/events") return { rows: [event], projects: [project] };
    if (path === "/api/admin/organizations") return { rows: [{ id: "O1", name: "实验小学" }] };
    if (path.startsWith("/api/admin/registrations?")) return { rows: [registration], total: 1, page: 1, pageSize: 25, refreshedAt: "2026-07-17T08:00:00.000Z" };
    return { row: registration };
  });
}

describe("RegistrationManagementPage", () => {
  beforeEach(() => { apiMock.mockReset(); apiBlobMock.mockReset(); mockLoads(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("renders filters, instructor, refresh timestamp, pagination and management entries", async () => {
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("林老师");
    expect(wrapper.text()).toContain("最近刷新");
    expect(wrapper.text()).toContain("审核");
    expect(wrapper.text()).toContain("驳回");
    expect(wrapper.text()).toContain("编辑");
    expect(wrapper.text()).toContain("成绩");
    expect(wrapper.text()).toContain("证书");
    expect(wrapper.find('[data-filter="eventId"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="export-filtered"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="export-all"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="certificate-template"]').exists()).toBe(true);
  });

  it("refreshes the filtered page without rendering a certificate number", async () => {
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="refresh"]').trigger("click");
    await flushPromises();

    expect(apiMock.mock.calls.filter(([path]) => path.startsWith("/api/admin/registrations?")).length).toBeGreaterThan(1);
    expect(wrapper.text()).not.toContain("证书编号");
  });

  it("opens certificate management for the selected registration", async () => {
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();

    await wrapper.get('[data-action="manage-certificates"]').trigger("click");

    expect(wrapper.emitted("open-certificates")?.[0]).toEqual([registration]);
  });

  it("releases successful Blob downloads on unmount and does not create a URL for failures", async () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:download"); URL.revokeObjectURL = vi.fn();
    apiBlobMock.mockResolvedValueOnce({});
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="export-all"]').trigger("click");
    await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");

    apiBlobMock.mockRejectedValueOnce(new Error("denied"));
    const failed = mount(RegistrationManagementPage);
    await flushPromises();
    await failed.get('[data-action="export-all"]').trigger("click");
    await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});
