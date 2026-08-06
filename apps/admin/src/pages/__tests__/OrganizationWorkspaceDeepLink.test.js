import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
const apiBlobMock = vi.fn();
const user = ref(null);
const organizations = ref([]);
const accountEvents = ref([]);
const session = {
  user, organizations, accountEvents, restoring: ref(false),
  restore: vi.fn(async () => user.value), login: vi.fn(), logout: vi.fn(), clear: vi.fn(), setUser: vi.fn(),
  loadAccountEvents: vi.fn(async () => { accountEvents.value = (await apiMock("/api/me/events")).rows || []; })
};

const archivedEvent = { id: "E-ARCHIVED", name: "历史赛事", status: "archived", archivedAt: "2026-01-01" };
const archivedRegistration = { id: "R1", athlete: { name: "张三", school: "航空学校", grade: "五年级" }, projectName: "无人机", status: "approved", awardName: "一等奖", rank: "1", score: "95" };

async function mountAt(url) {
  window.history.replaceState({}, "", url);
  const { default: App } = await import("../../App.vue");
  const wrapper = mount(App);
  await flushPromises();
  return wrapper;
}

describe("organization workspace historical deep links", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));
    vi.doMock("../../state/session.js", () => ({ useSession: () => session }));
    apiMock.mockReset();
    apiBlobMock.mockReset();
    session.user.value = { id: "U1", type: "organization", name: "负责人", phone: "13800000000", mustChangePassword: false };
    session.organizations.value = [{ id: "O1", ownerUserId: "U1", name: "航空少年宫", status: "active", reviewStatus: "approved" }];
    session.accountEvents.value = [];
    session.restore.mockClear();
    session.loadAccountEvents.mockClear();
  });

  it("opens an archived joined event read-only through workspace authorization", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "当前赛事" }, projects: [], grades: [] };
      if (path === "/api/me/events") return { rows: [] };
      if (path === "/api/organization/events/E-ARCHIVED/workspace") return { event: archivedEvent, summary: {}, projects: [], registrations: [archivedRegistration] };
      if (path === "/api/organization/registrations?page=1&pageSize=25") return { rows: [{ ...archivedRegistration, eventId: "E-ARCHIVED", eventName: "历史赛事" }], total: 1, page: 1, pageSize: 25, filterOptions: { events: [archivedEvent], projects: [] } };
      return { rows: [] };
    });
    const wrapper = await mountAt("/admin/?view=organizationWorkspace&eventId=E-ARCHIVED");

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E-ARCHIVED/workspace");
    expect(wrapper.get('[data-testid="organization-event-workspace"]').exists()).toBe(true);
    expect(wrapper.get(".topbar").text()).toContain("历史赛事");
    expect(wrapper.findAll(".organization-event-summary-card")).toHaveLength(1);
    expect(wrapper.findAll(".organization-registration-guide")).toHaveLength(1);
    expect(wrapper.findAll(".organization-registration-card")).toHaveLength(1);
    expect(wrapper.find('[data-testid="organization-registration-form"]').exists()).toBe(false);
    expect(wrapper.findAll("[data-workspace-tab]")).toHaveLength(0);
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E-ARCHIVED");

    await wrapper.get('[data-user-nav="organizationRecords"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="organization-registration-records-page"]').exists()).toBe(true);
    expect(apiMock).toHaveBeenCalledWith("/api/organization/registrations?page=1&pageSize=25");
    expect(new URLSearchParams(window.location.search).get("eventId")).toBeNull();
  });

  it("returns an unauthorized organization workspace deep link to the event center", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "当前赛事" }, projects: [], grades: [] };
      if (path === "/api/me/events") return { rows: [] };
      if (path === "/api/organization/events/E-ARCHIVED/workspace") throw Object.assign(new Error("无权访问该赛事"), { status: 403 });
      return { rows: [] };
    });
    const wrapper = await mountAt("/admin/?view=organizationWorkspace&eventId=E-ARCHIVED");

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("eventId")).toBeNull();
  });

  it("does not let an ordinary account open an organization workspace deep link", async () => {
    session.user.value = { id: "U2", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false };
    session.organizations.value = [];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "当前赛事" }, projects: [], grades: [] };
      if (path === "/api/me/events") return { rows: [] };
      if (path === "/api/organization/events/E-ARCHIVED/workspace") throw new Error("ordinary account must not request organization workspace");
      return { rows: [] };
    });
    const wrapper = await mountAt("/admin/?view=organizationWorkspace&eventId=E-ARCHIVED");

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(apiMock.mock.calls.some(([path]) => path === "/api/organization/events/E-ARCHIVED/workspace")).toBe(false);
  });
});
