import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: vi.fn(), apiUrl: (path) => path }));
vi.mock("../../state/session.js", async () => {
  const { ref } = await import("vue");
  const sessionUser = ref(null);
  const sessionOrganizations = ref([]);
  const session = {
    user: sessionUser,
    organizations: sessionOrganizations,
    restoring: ref(false),
    restore: vi.fn(async () => sessionUser.value),
    login: vi.fn(),
    logout: vi.fn(async () => { sessionUser.value = null; }),
    setUser: vi.fn((user, organizations = []) => {
      sessionUser.value = user;
      sessionOrganizations.value = organizations;
    })
  };
  return { useSession: () => session, testSession: session };
});

import App from "../../App.vue";
import appSource from "../../App.vue?raw";
import MyCertificatesPage from "../MyCertificatesPage.vue";
import UserManagementPage from "../UserManagementPage.vue";
import { testSession as session } from "../../state/session.js";

function installApi({ organization } = {}) {
  apiMock.mockImplementation(async (path) => {
    if (path === "/api/public/event") return { event: { name: "测试赛事" }, projects: [], grades: [] };
    if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
    if (path === "/api/organizations" || path === "/api/me/organizations") return { rows: organization ? [organization] : [] };
    if (path.startsWith("/api/me/")) return { memberships: [] };
    if (path === "/api/users") return { rows: [] };
    if (path === "/api/admin/registrations?pageSize=100") return { rows: [] };
    if (path === "/api/admin/certificates") return { rows: [] };
    if (path === "/api/me/registrations" || path === "/api/me/certificates") return { rows: [] };
    if (path === "/api/me/registration-context") return { organizations: [], projects: [], grades: [] };
    return { rows: [] };
  });
}

async function mountFor(user, organization) {
  session.user.value = user;
  session.organizations.value = organization ? [organization] : [];
  installApi({ organization });
  const wrapper = mount(App);
  await flushPromises();
  return wrapper;
}

let mounted = [];

describe("role based application navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    installApi();
    apiMock.mockReset();
    session.user.value = null;
    session.organizations.value = [];
    session.restore.mockClear();
    session.logout.mockClear();
  });

  afterEach(() => {
    mounted.forEach((wrapper) => wrapper.unmount());
    mounted = [];
  });

  it("shows the website module to administrators and opens it from navigation", async () => {
    const wrapper = await mountFor({ id: "A1", type: "admin", name: "管理员", mustChangePassword: false }); mounted.push(wrapper);
    const labels = wrapper.findAll("[data-nav]").map((item) => item.text());
    expect(labels).toEqual(["概览", "赛事设置", "报名管理", "证书管理", "官网内容", "组织用户", "普通用户管理"]);
    expect(wrapper.find('[data-user-nav="myOrganization"]').exists()).toBe(false);

    await wrapper.get('[data-nav="siteContent"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="site-content-page"]').exists()).toBe(true);
  });

  it("opens event settings from a draft event website state", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "测试赛事" }, projects: [], grades: [] };
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/admin/site-settings") return { row: { id: "default", version: 1 } };
      if (path === "/api/admin/event-public-profiles") return { rows: [{ eventId: "E1", slug: "draft-event", isVisible: false, displayOrder: 1, version: 1 }] };
      if (path === "/api/admin/events") return { rows: [{ id: "E1", name: "草稿赛事", status: "draft", archivedAt: null }], projects: [] };
      return { rows: [] };
    });
    session.user.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    await wrapper.get('[data-nav="siteContent"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-site-tab="events"]').trigger("click");
    await wrapper.get('[data-action="go-event-settings"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-nav="events"]').classes()).toContain("active");
  });

  it("allows only administrators to restore the website content deep link", async () => {
    window.history.replaceState({}, "", "/admin/?view=siteContent");
    const ordinary = await mountFor({ id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false }); mounted.push(ordinary);
    expect(ordinary.find('[data-testid="site-content-page"]').exists()).toBe(false);
    expect(ordinary.find('[data-nav="siteContent"]').exists()).toBe(false);
    expect(apiMock.mock.calls.some(([path]) => path === "/api/admin/site-settings" || path === "/api/admin/event-public-profiles")).toBe(false);
    ordinary.unmount();
    mounted = mounted.filter((item) => item !== ordinary);
    window.history.replaceState({}, "", "/admin/?view=siteContent");

    const admin = await mountFor({ id: "A1", type: "admin", name: "管理员", mustChangePassword: false }); mounted.push(admin);
    expect(admin.find('[data-testid="site-content-page"]').exists()).toBe(true);
  });

  it("restores a valid contentId deep link and keeps the selected editor synchronized in the URL", async () => {
    window.history.replaceState({}, "", "/admin/?view=siteContent&contentId=P1");
    session.user.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "测试赛事" }, projects: [], grades: [] };
      if (path === "/api/admin/site-settings") return { row: { id: "default", version: 1 } };
      if (path === "/api/admin/event-public-profiles") return { rows: [] };
      if (path === "/api/admin/events") return { rows: [], projects: [] };
      if (path === "/api/admin/content/P1") return { row: {
        id: "P1", slug: "restored-content", eventId: null, type: "news", title: "恢复编辑目标",
        summary: "", bodyHtml: "<p>正文</p>", status: "draft", publishAt: null, pinned: false,
        sortOrder: 0, coverMediaId: null, attachments: [], version: 1
      } };
      if (path === "/api/admin/content") return { rows: [] };
      return { rows: [] };
    });

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.get('[data-site-tab="content"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[data-content-field="title"]').element.value).toBe("恢复编辑目标");
    expect(new URLSearchParams(window.location.search).get("contentId")).toBe("P1");

    await wrapper.get('[data-action="back-to-content-list"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".content-list-panel").exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("view")).toBe("siteContent");
    expect(new URLSearchParams(window.location.search).has("contentId")).toBe(false);
  });

  it("falls back to the content list for a missing restored contentId and clears it from the URL", async () => {
    window.history.replaceState({}, "", "/admin/?view=siteContent&contentId=MISSING");
    session.user.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "测试赛事" }, projects: [], grades: [] };
      if (path === "/api/admin/site-settings") return { row: { id: "default", version: 1 } };
      if (path === "/api/admin/event-public-profiles") return { rows: [] };
      if (path === "/api/admin/events") return { rows: [], projects: [] };
      if (path === "/api/admin/content/MISSING") throw Object.assign(new Error("内容不存在"), { status: 404 });
      if (path === "/api/admin/content") return { rows: [] };
      return { rows: [] };
    });

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find(".content-list-panel").exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).has("contentId")).toBe(false);
  });

  it("guards administrator navigation and logout while website content has unsaved edits", async () => {
    window.history.replaceState({}, "", "/admin/?view=siteContent&contentId=P1");
    session.user.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "测试赛事" }, projects: [], grades: [] };
      if (path === "/api/admin/site-settings") return { row: { id: "default", version: 1 } };
      if (path === "/api/admin/event-public-profiles") return { rows: [] };
      if (path === "/api/admin/events") return { rows: [], projects: [] };
      if (path === "/api/admin/content/P1") return { row: {
        id: "P1", slug: "guarded-content", eventId: null, type: "news", title: "守护内容",
        summary: "", bodyHtml: "<p>正文</p>", status: "draft", publishAt: null, pinned: false,
        sortOrder: 0, coverMediaId: null, attachments: [], version: 1
      } };
      return { rows: [] };
    });
    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-content-field="title"]').setValue("未保存修改");

    await wrapper.get('[data-nav="events"]').trigger("click");
    expect(wrapper.get('[data-nav="siteContent"]').classes()).toContain("active");
    expect(wrapper.get('[role="dialog"]').text()).toContain("放弃未保存修改");
    await wrapper.findAll('[role="dialog"] button').at(-1).trigger("click");

    await wrapper.get('[data-action="logout"]').trigger("click");
    expect(session.logout).not.toHaveBeenCalled();
    expect(wrapper.get('[role="dialog"]').text()).toContain("放弃未保存修改");
    await wrapper.get('[data-action="confirm-discard-content"]').trigger("click");
    await flushPromises();
    expect(session.logout).toHaveBeenCalledTimes(1);
  });

  it("blocks organization users from the website content deep link and its admin APIs", async () => {
    window.history.replaceState({}, "", "/admin/?view=siteContent");
    const organization = { id: "O1", ownerUserId: "O1U", name: "实验学校", reviewStatus: "approved", status: "active", membershipRole: "owner" };
    const wrapper = await mountFor({ id: "O1U", type: "organization", name: "负责人", phone: "13800000002", mustChangePassword: false }, organization); mounted.push(wrapper);

    expect(wrapper.find('[data-testid="site-content-page"]').exists()).toBe(false);
    expect(wrapper.find('[data-nav="siteContent"]').exists()).toBe(false);
    expect(apiMock.mock.calls.some(([path]) => [
      "/api/admin/site-settings",
      "/api/admin/event-public-profiles",
      "/api/admin/site-media",
      "/api/admin/events"
    ].includes(path))).toBe(false);
  });

  it("shows the personal organization page without changing event context", async () => {
    const wrapper = await mountFor({ id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false }); mounted.push(wrapper);
    const labels = wrapper.findAll("[data-user-nav]").map((item) => item.text());
    expect(labels).toEqual(["赛事中心", "我的组织", "报名记录", "证书查询"]);
    expect(wrapper.text()).not.toContain("普通用户管理");
    expect(apiMock.mock.calls.some(([path]) => path === "/api/users" || path.startsWith("/api/admin/"))).toBe(false);

    await wrapper.get('[data-user-nav="myOrganization"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="my-organization-page"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("view")).toBe("myOrganization");
  });

  it("restores the personal organization deep link without requesting registration context", async () => {
    window.history.replaceState({}, "", "/admin/?view=myOrganization&eventId=E2");
    session.user.value = { id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false };
    installApi();

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find('[data-testid="my-organization-page"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("view")).toBe("myOrganization");
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
    expect(apiMock.mock.calls.some(([path]) => path.includes("registration-context"))).toBe(false);
  });

  it("does not reload registration context when leaving event registration for the personal organization page", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E2");
    session.user.value = { id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { id: "E1", name: "当前赛事" }, projects: [], grades: [] };
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/me/registration-context?eventId=E2") return { event: { id: "E2", name: "目标赛事" }, organizations: [], projects: [], grades: [] };
      if (path === "/api/me/organization-relations") return { active: [], requests: [], invitations: [] };
      return { rows: [] };
    });

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/me/registration-context?eventId=E2")).toHaveLength(1);

    await wrapper.get('[data-user-nav="myOrganization"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="my-organization-page"]').exists()).toBe(true);
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/me/registration-context?eventId=E2")).toHaveLength(1);
  });

  it("opens registration history directly when no event is selected", async () => {
    const wrapper = await mountFor({ id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false }); mounted.push(wrapper);

    await wrapper.get('[data-user-nav="registrationRecords"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="registration-records-page"]').exists()).toBe(true);
    expect(apiMock).toHaveBeenCalledWith("/api/me/registrations");
    expect(wrapper.text()).not.toContain("请先在赛事中心选择赛事");
  });

  it("restores a whitelisted registration deep link with its event id", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E2");
    session.user.value = { id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return {
        event: { id: "E1", name: "当前赛事 E1", date: "2026-01-01", venue: "E1 场地", registrationDeadline: "2025-12-01" },
        projects: [], grades: []
      };
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/me/registration-context?eventId=E2") return {
        event: { id: "E2", name: "目标赛事 E2", dateLabel: "2027-02-02", venue: "E2 场地", registrationEndAt: "2027-01-20T15:59:59.000Z" },
        organizations: [], projects: [], grades: []
      };
      return { rows: [] };
    });
    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find(".registration-page").exists()).toBe(true);
    expect(apiMock.mock.calls.some(([path]) => path === "/api/me/registration-context?eventId=E2")).toBe(true);
    expect(wrapper.get(".topbar").text()).toContain("目标赛事 E2");
    expect(wrapper.get(".topbar").text()).toContain("E2 场地");
    expect(wrapper.get(".topbar").text()).not.toContain("当前赛事 E1");
  });

  it.each([
    ["records", "registration-records-page", "/api/me/events/E2/registrations"],
    ["certificates", "my-certificates-page", "/api/me/events/E2/certificates"]
  ])("restores the public %s deep link and keeps its validated event filter", async (view, testId, expectedPath) => {
    window.history.replaceState({}, "", `/admin/?view=${view}&eventId=E2`);
    session.user.value = { id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { id: "E1", name: "当前赛事 E1" }, projects: [], grades: [] };
      if (path === expectedPath) return { rows: [] };
      return { rows: [] };
    });

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(true);
    expect(apiMock).toHaveBeenCalledWith(expectedPath);
    expect(apiMock.mock.calls.some(([path]) => path.includes("<script>"))).toBe(false);
  });

  it("routes an administrator records deep link to event-filtered registration management", async () => {
    window.history.replaceState({}, "", "/admin/?view=records&eventId=E2");
    session.user.value = { id: "A1", type: "admin", name: "管理员", phone: "13900000000", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { id: "E1", name: "当前赛事 E1" }, projects: [], grades: [] };
      if (path === "/api/admin/events") return {
        rows: [{ id: "E1", name: "当前赛事", isCurrent: true }, { id: "E2", name: "目标赛事", isCurrent: false }],
        projects: []
      };
      if (path === "/api/admin/organizations") return { rows: [] };
      if (path.startsWith("/api/admin/events/E2/registrations?")) return { rows: [], total: 0, page: 1, pageSize: 25 };
      return { rows: [] };
    });

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find(".registration-management").exists()).toBe(true);
    expect(wrapper.find('[data-testid="registration-records-page"]').exists()).toBe(false);
    const request = apiMock.mock.calls.map(([path]) => path).find((path) => path.startsWith("/api/admin/events/E2/registrations?"));
    expect(request).toContain("/api/admin/events/E2/registrations?");
  });

  it("reloads administrator registration management without the records deep-link filter when its current navigation item is clicked", async () => {
    window.history.replaceState({}, "", "/admin/?view=records&eventId=E2");
    session.user.value = { id: "A1", type: "admin", name: "Admin", phone: "13900000000", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { id: "E1", name: "Current event" }, projects: [], grades: [] };
      if (path === "/api/admin/events") return {
        rows: [{ id: "E1", name: "Current event", isCurrent: true }, { id: "E2", name: "Target event", isCurrent: false }],
        projects: []
      };
      if (path === "/api/admin/organizations") return { rows: [] };
      if (path.startsWith("/api/admin/events/E2/registrations?")) return { rows: [], total: 0, page: 1, pageSize: 25 };
      return { rows: [] };
    });

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    const registrationRequests = () => apiMock.mock.calls
      .map(([path]) => path)
      .filter((path) => path.startsWith("/api/admin/events/E2/registrations?"));
    expect(registrationRequests().at(-1)).toContain("/api/admin/events/E2/registrations?");

    await wrapper.get('[data-nav="registrations"]').trigger("click");
    await flushPromises();

    expect(registrationRequests()).toHaveLength(1);
    expect(registrationRequests().at(-1)).toContain("/api/admin/events/E2/registrations?");
  });

  it("reloads administrator certificate management without the event deep-link filter when its current navigation item is clicked", async () => {
    window.history.replaceState({}, "", "/admin/?view=certificates&eventId=E2");
    session.user.value = { id: "A1", type: "admin", name: "Admin", phone: "13900000000", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { id: "E1", name: "Current event" }, projects: [], grades: [] };
      if (path === "/api/admin/events") return {
        rows: [{ id: "E1", name: "Current event", isCurrent: true }, { id: "E2", name: "Target event", isCurrent: false }],
        projects: []
      };
      if (path.startsWith("/api/admin/events/E2/certificates?")) return { rows: [], total: 0, page: 1, pageSize: 50 };
      return { rows: [] };
    });

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();

    const certificateRequests = () => apiMock.mock.calls
      .map(([path]) => path)
      .filter((path) => path.startsWith("/api/admin/events/E2/certificates?"));
    expect(certificateRequests().at(-1)).toContain("/api/admin/events/E2/certificates?");

    await wrapper.get('[data-nav="certificates"]').trigger("click");
    await flushPromises();

    expect(certificateRequests()).toHaveLength(1);
    expect(certificateRequests().at(-1)).toContain("/api/admin/events/E2/certificates?");
  });

  it.each([
    ["records", "registrationRecords", "/api/me/events/E2/registrations", "/api/me/registrations"],
    ["certificates", "certificates", "/api/me/events/E2/certificates", "/api/me/certificates"]
  ])("opens all-event history when navigating to %s from an event deep link", async (view, navigation, eventPath, historyPath) => {
    window.history.replaceState({}, "", `/admin/?view=${view}&eventId=E2`);
    session.user.value = { id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { id: "E1", name: "当前赛事 E1" }, projects: [], grades: [] };
      if (path === eventPath) return { rows: [] };
      if (path === historyPath) return { rows: [] };
      return { rows: [] };
    });

    const wrapper = mount(App); mounted.push(wrapper);
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith(eventPath);

    await wrapper.get(`[data-user-nav="${navigation}"]`).trigger("click");
    await flushPromises();
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe(null);
    expect(apiMock.mock.calls.filter(([path]) => path === eventPath)).toHaveLength(1);
    expect(apiMock).toHaveBeenCalledWith(historyPath);
  });

  it("does not expose the organization console to a pending organization from a registration deep link", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E2");
    const organization = { id: "O1", ownerUserId: "O1U", name: "待审核学校", reviewStatus: "pending", status: "active", membershipRole: "owner" };
    const wrapper = await mountFor({ id: "O1U", type: "organization", name: "负责人", phone: "13800000002", mustChangePassword: false }, organization); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find('[data-testid="organization-console-page"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("邀请成员");
  });

  it("does not pass an invalid view or event query into application components", async () => {
    window.history.replaceState({}, "", "/admin/?view=constructor&eventId=%3Cscript%3E");
    const wrapper = await mountFor({ id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false }); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(apiMock.mock.calls.some(([path]) => path.includes("%3Cscript%3E") || path.includes("<script>"))).toBe(false);
  });

  it("shows an event center and review navigation to a pending organization", async () => {
    const organization = { id: "O1", ownerUserId: "O1U", name: "待审核学校", reviewStatus: "pending", status: "active", membershipRole: "owner" };
    const wrapper = await mountFor({ id: "O1U", type: "organization", name: "负责人", phone: "13800000002", mustChangePassword: false }, organization); mounted.push(wrapper);
    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("邀请成员");
    expect(wrapper.findAll("[data-user-nav]").map((item) => item.text())).toEqual(["赛事工作台", "审核进度"]);
    expect(wrapper.find('[data-user-nav="myOrganization"]').exists()).toBe(false);
    expect(apiMock.mock.calls.some(([path]) => path.includes("/registrations") || path.includes("/certificates"))).toBe(false);
  });

  it("opens the organization console for an approved owner", async () => {
    const organization = { id: "O1", ownerUserId: "O1U", name: "实验学校", reviewStatus: "approved", status: "active", membershipRole: "owner" };
    const wrapper = await mountFor({ id: "O1U", type: "organization", name: "负责人", phone: "13800000002", mustChangePassword: false }, organization); mounted.push(wrapper);
    expect(wrapper.findAll("[data-user-nav]").map((item) => item.text())).toEqual(["赛事工作台", "组织与成员", "证书查询"]);
    expect(wrapper.find('[data-user-nav="myOrganization"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
  });

  it("keeps only orchestration in App and delegates the four business views", () => {
    expect(appSource).toContain("UserManagementPage");
    expect(appSource).toContain("RegistrationRecordsPage");
    expect(appSource).toContain("MyCertificatesPage");
    expect(appSource).toContain("OrganizationConsolePage");
    expect(appSource).not.toContain("certificate-table");
    expect(appSource).not.toContain("用户列表");
  });

  it("provides user status filters and organization plus registration history", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/users") return { rows: [
        { id: "U1", name: "张三", phone: "13800000001", type: "ordinary", status: "active" },
        { id: "U2", name: "李四", phone: "13800000002", type: "ordinary", status: "disabled" }
      ] };
      if (path === "/api/admin/organizations") return { rows: [{ id: "O1", name: "实验学校", ownerUserId: "U1" }] };
      if (path === "/api/me/U1") return { memberships: [{ id: "M1", organizationId: "O1", role: "member", status: "active" }], registrations: [{ id: "R1", eventId: "E1", projectName: "纸飞机", athlete: { name: "张三" }, status: "approved" }] };
      return { rows: [] };
    });
    const wrapper = mount(UserManagementPage); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find('[data-filter="user-status"]').exists()).toBe(true);
    await wrapper.get('[data-filter="user-status"]').setValue("disabled");
    expect(wrapper.text()).toContain("李四");
    expect(wrapper.text()).not.toContain("张三");
    await wrapper.get('[data-filter="user-status"]').setValue("all");
    await wrapper.findAll('[data-action="user-details"]')[0].trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="user-details"]').text()).toContain("实验学校");
    expect(wrapper.get('[data-testid="user-details"]').text()).toContain("纸飞机");
  });

  it("shows cleaned certificate history without a broken download action", async () => {
    session.user.value = { id: "U1", type: "ordinary", name: "张三" };
    apiMock.mockImplementation(async (path) => path === "/api/me/events/E2/certificates" ? { rows: [{
      id: "C1", title: "一等奖", status: "published", cleanedAt: "2026-07-18T00:00:00.000Z",
      athlete: { name: "张三", school: "实验学校", grade: "三年级" }, projectName: "纸飞机"
    }] } : { rows: [] });
    const wrapper = mount(MyCertificatesPage, { props: { eventId: "E2" } }); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.text()).toContain("原文件已清理");
    expect(wrapper.find('[data-action="download-user-certificate"]').exists()).toBe(false);
    expect(apiMock.mock.calls.some(([path]) => path.startsWith("/api/admin/"))).toBe(false);
  });
});
