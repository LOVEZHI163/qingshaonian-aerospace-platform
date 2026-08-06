import { flushPromises, mount as vueMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));

import DashboardPage from "../DashboardPage.vue";
const mount = (component, options = {}) => vueMount(component, { ...options, props: { eventId: "E1", ...(options.props || {}) } });

const dashboard = {
  event: { id: "E1", name: "2026航空航天创新比赛", status: "published", isCurrent: true },
  registrationWindow: { open: false, reason: "管理员临时关闭" },
  counts: { registrations: 12, pendingRegistrations: 3, pendingOrganizations: 2, draftCertificates: 4 },
  serverStorage: { available: true, level: "normal", thresholds: { warningPercent: 80, criticalPercent: 90 }, disk: { totalBytes: 1000, usedBytes: 350, availableBytes: 650, usedPercent: 35 } },
  submissionStorage: { totalFiles: 2, totalBytes: 300, artworkImages: { count: 1, bytes: 100 }, creationVideos: { count: 1, bytes: 200 } },
  recentImports: [{ id: "B1", originalName: "证书名单.xlsx", status: "committed", validCount: 8, createdAt: "2026-07-18T08:00:00.000Z" }],
  recentAuditLogs: [{ id: "A1", actorName: "赛事管理员", action: "certificate.publish", summary: "发布 4 张证书", createdAt: "2026-07-18T09:00:00.000Z" }]
};

describe("DashboardPage", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/admin/?view=overview&eventId=E1");
    apiMock.mockReset();
    apiMock.mockImplementation((path) => Promise.resolve(path.includes("submission-assets") ? { rows: [] } : dashboard));
    apiBlobMock.mockReset();
  });

  it("shows operational status and separates detailed information into quick-switch modules", async () => {
    const wrapper = mount(DashboardPage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/dashboard?eventId=E1");
    expect(wrapper.text()).toContain("2026航空航天创新比赛");
    expect(wrapper.text()).toContain("管理员临时关闭");
    expect(wrapper.get('[data-count="pending-registrations"]').text()).toContain("3");
    expect(wrapper.get('[data-count="pending-organizations"]').text()).toContain("2");
    expect(wrapper.get('[data-count="draft-certificates"]').text()).toContain("4");

    await wrapper.get('[data-dashboard-module="certificates"]').trigger("click");
    expect(wrapper.text()).toContain("证书名单.xlsx");

    await wrapper.get('[data-dashboard-module="activity"]').trigger("click");
    expect(wrapper.text()).toContain("发布 4 张证书");

    await wrapper.get('[data-dashboard-module="storage"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("服务器存储");
    expect(wrapper.text()).toContain("35.0%");
    expect(wrapper.text()).toContain("图片 1 个");
    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/submission-assets");
    expect(new URLSearchParams(window.location.search).get("panel")).toBe("storage");
  });

  it("restores a valid module from the URL and ignores an unknown module", async () => {
    window.history.replaceState({}, "", "/admin/?view=overview&eventId=E1&panel=certificates");
    const certificateWrapper = mount(DashboardPage);
    await flushPromises();
    expect(certificateWrapper.get('[data-active-module="certificates"]').exists()).toBe(true);
    certificateWrapper.unmount();

    window.history.replaceState({}, "", "/admin/?view=overview&eventId=E1&panel=unknown");
    const fallbackWrapper = mount(DashboardPage);
    await flushPromises();
    expect(fallbackWrapper.get('[data-active-module="operations"]').exists()).toBe(true);
  });

  it("emits navigation targets from review shortcuts", async () => {
    const wrapper = mount(DashboardPage);
    await flushPromises();

    await wrapper.get('[data-dashboard-target="organizations"]').trigger("click");
    await wrapper.get('[data-dashboard-target="registrations"]').trigger("click");
    await wrapper.get('[data-dashboard-target="certificates"]').trigger("click");
    await wrapper.get('[data-action="dashboard-certificate-import"]').trigger("click");

    expect(wrapper.emitted("navigate")).toEqual([["organizations"], ["registrations"], ["certificates"], ["certificates", "import"]]);
  });
});
