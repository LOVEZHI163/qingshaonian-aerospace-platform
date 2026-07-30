import { flushPromises, mount as vueMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import DashboardPage from "../DashboardPage.vue";
const mount = (component, options = {}) => vueMount(component, { ...options, props: { eventId: "E1", ...(options.props || {}) } });

const dashboard = {
  event: { id: "E1", name: "2026航空航天创新比赛", status: "published", isCurrent: true },
  registrationWindow: { open: false, reason: "管理员临时关闭" },
  counts: { registrations: 12, pendingRegistrations: 3, pendingOrganizations: 2, draftCertificates: 4 },
  recentImports: [{ id: "B1", originalName: "证书名单.xlsx", status: "committed", validCount: 8, createdAt: "2026-07-18T08:00:00.000Z" }],
  recentAuditLogs: [{ id: "A1", actorName: "赛事管理员", action: "certificate.publish", summary: "发布 4 张证书", createdAt: "2026-07-18T09:00:00.000Z" }]
};

describe("DashboardPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue(dashboard);
  });

  it("shows operational status, counts, imports and audit logs", async () => {
    const wrapper = mount(DashboardPage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/dashboard?eventId=E1");
    expect(wrapper.text()).toContain("2026航空航天创新比赛");
    expect(wrapper.text()).toContain("管理员临时关闭");
    expect(wrapper.get('[data-count="pending-registrations"]').text()).toContain("3");
    expect(wrapper.get('[data-count="pending-organizations"]').text()).toContain("2");
    expect(wrapper.get('[data-count="draft-certificates"]').text()).toContain("4");
    expect(wrapper.text()).toContain("证书名单.xlsx");
    expect(wrapper.text()).toContain("发布 4 张证书");
  });

  it("emits navigation targets from review shortcuts", async () => {
    const wrapper = mount(DashboardPage);
    await flushPromises();

    await wrapper.get('[data-dashboard-target="organizations"]').trigger("click");
    await wrapper.get('[data-dashboard-target="registrations"]').trigger("click");
    await wrapper.get('[data-dashboard-target="certificates"]').trigger("click");

    expect(wrapper.emitted("navigate")).toEqual([["organizations"], ["registrations"], ["certificates"]]);
  });
});
