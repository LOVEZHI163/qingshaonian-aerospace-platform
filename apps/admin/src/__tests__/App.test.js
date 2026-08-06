import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiMock, apiBlobMock, MockApiError } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  apiBlobMock: vi.fn(),
  MockApiError: class ApiError extends Error {}
}));
vi.mock("../lib/api.js", () => ({ ApiError: MockApiError, api: apiMock, apiBlob: apiBlobMock, apiUrl: (path) => path }));
vi.mock("../state/session.js", async () => {
  const { ref } = await import("vue");
  const sessionUser = ref(null);
  const session = {
    user: sessionUser,
    organizations: ref([]),
    accountEvents: ref([]),
    restoring: ref(false),
    restore: vi.fn(async () => {}),
    login: vi.fn(),
    logout: vi.fn(),
    setUser: vi.fn((user) => { sessionUser.value = user; }),
    clear: vi.fn(() => { sessionUser.value = null; }),
    loadAccountEvents: vi.fn(async () => {
      const payload = await apiMock("/api/me/events");
      session.accountEvents.value = payload.rows || [];
      return session.accountEvents.value;
    })
  };
  return { useSession: () => session, testSession: session };
});

import App from "../App.vue";
import appSource from "../App.vue?raw";
import { testSession as session } from "../state/session.js";

const sessionUser = session.user;
const restoring = session.restoring;

enableAutoUnmount(afterEach);

function publicData() {
  return { event: { name: "测试赛事" }, projects: [], grades: [] };
}

describe("App session integration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/");
    apiMock.mockReset();
    sessionUser.value = null;
    session.organizations.value = [];
    restoring.value = false;
    session.restore.mockClear();
    session.loadAccountEvents.mockClear();
    session.accountEvents.value = [];
    session.login.mockReset();
    session.logout.mockReset();
    session.setUser.mockClear();
    session.clear.mockClear();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/organizations") return { rows: [], memberships: [] };
      if (path === "/api/users") return { rows: [] };
      return { rows: [] };
    });
  });

  it("shows a non-skippable password change before application views", async () => {
    sessionUser.value = { id: "U1", type: "ordinary", mustChangePassword: true };
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain("首次登录请修改密码");
    expect(wrapper.text()).not.toContain("报名端");
    expect(wrapper.find('[data-action="password-logout"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="user-shell"]').exists()).toBe(false);
  });

  it("renders the admin shell only for administrators", async () => {
    sessionUser.value = { id: "A1", type: "admin", name: "管理员" };
    const admin = mount(App);
    await flushPromises();
    expect(admin.find('[data-testid="admin-shell"]').exists()).toBe(true);
    admin.unmount();

    sessionUser.value = { id: "U1", type: "ordinary", name: "用户" };
    const ordinary = mount(App);
    await flushPromises();
    expect(ordinary.find('[data-testid="admin-shell"]').exists()).toBe(false);
  });

  it("shows an invalid login message inside the login form", async () => {
    session.login.mockRejectedValueOnce(new Error("手机号或密码错误"));
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.get('[data-auth-form="login"]').trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-testid="login-error"]').text()).toContain("手机号或密码错误");
  });

  it("blocks the admin shell when production release identities differ", async () => {
    vi.stubEnv("VITE_RELEASE_SHA", "new-web");
    sessionUser.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/system/version") return { releaseSha: "old-api", apiVersion: 1 };
      return { rows: [] };
    });

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain("系统版本不一致，请刷新页面或联系管理员");
    expect(wrapper.find('[data-testid="admin-shell"]').exists()).toBe(false);
  });

  it("waits for release verification to resolve before restoring the session", async () => {
    let resolveVersion;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/system/version") {
        return new Promise((resolve) => { resolveVersion = resolve; });
      }
      if (path === "/api/public/event") return publicData();
      return { rows: [] };
    });

    mount(App);
    await Promise.resolve();

    expect(resolveVersion).toBeTypeOf("function");
    expect(session.restore).not.toHaveBeenCalled();

    resolveVersion({ releaseSha: "development", apiVersion: 1 });
    await flushPromises();

    expect(session.restore).toHaveBeenCalledTimes(1);
  });

  it("uses the normalized API error when the version check fails", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/system/version") throw new MockApiError("服务暂时不可用，请刷新后重试 (502)");
      return { rows: [] };
    });

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain("服务暂时不可用，请刷新后重试 (502)");
    expect(wrapper.text()).not.toContain("<html>");
    expect(wrapper.find('[data-testid="admin-shell"]').exists()).toBe(false);
  });

  it.each(["ordinary", "organization"])("opens the event center by default for %s accounts", async (type) => {
    sessionUser.value = { id: `${type}-1`, type, name: "账户", mustChangePassword: false };
    if (type === "organization") session.organizations.value = [{ id: "O1", name: "组织", status: "active", reviewStatus: "approved" }];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
  });

  it.each(["ordinary", "organization"])("uses the hover rail and mobile drawer for %s accounts", async (type) => {
    sessionUser.value = { id: `${type}-1`, type, name: "账户", phone: "13800000001", mustChangePassword: false };
    if (type === "organization") session.organizations.value = [{ id: "O1", name: "组织", status: "active", reviewStatus: "approved" }];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get(".user-sidebar").exists()).toBe(true);
    expect(wrapper.get(".user-brand-mark img").attributes("src")).toBe("/brand/mark.svg");
    await wrapper.get(".user-sidebar-mobile-trigger").trigger("click");
    expect(wrapper.get('[data-testid="user-shell"]').classes()).toContain("user-sidebar-mobile-open");
    await wrapper.get('[data-user-nav="eventCenter"]').trigger("click");
    expect(wrapper.get('[data-testid="user-shell"]').classes()).not.toContain("user-sidebar-mobile-open");
  });

  it.each([
    ["ordinary", ["赛", "组", "录", "证", "密"]],
    ["organization", ["赛", "录", "组", "证", "密"]]
  ])("keeps every %s sidebar label aligned behind an icon slot", async (type, expectedIcons) => {
    sessionUser.value = { id: `${type}-1`, type, name: "账户", phone: "13800000001", mustChangePassword: false };
    if (type === "organization") session.organizations.value = [{ id: "O1", name: "组织", status: "active", reviewStatus: "approved" }];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    const navigationItems = wrapper.findAll("[data-user-nav]");
    expect(navigationItems.map((item) => item.get(".user-nav-icon").text())).toEqual(expectedIcons);
    expect(wrapper.get(".user-logout-button .user-nav-icon").text()).toBe("退");
  });

  it("keeps ordinary history navigation available without an explicit event context", async () => {
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E2", name: "春季赛" }, registrationState: "open", registrationCount: 0, organizations: [] }] };
      if (path === "/api/me/registrations") return { rows: [] };
      if (path === "/api/me/registration-context?eventId=E2") return { event: { id: "E2", name: "春季赛" }, organizations: [], projects: [], grades: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-user-nav="registration"]').exists()).toBe(false);
    expect(wrapper.find('[data-user-nav="registrationRecords"]').exists()).toBe(true);
    expect(wrapper.get('[data-user-nav="registrationRecords"]').text()).toContain("报名记录");

    await wrapper.get('[data-user-nav="registrationRecords"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="registration-records-page"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("请先在赛事中心选择赛事");

    await wrapper.get('[data-user-nav="eventCenter"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-event-card="E2"] [data-action="open"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-user-nav="registration"]').exists()).toBe(false);
    expect(wrapper.get('[data-user-nav="eventCenter"]').classes()).toContain("active");
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E2");

    await wrapper.get('[data-user-nav="eventCenter"]').trigger("click");
    await flushPromises();
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
    expect(wrapper.find('[data-user-nav="registration"]').exists()).toBe(false);
    expect(wrapper.find('[data-user-nav="registrationRecords"]').exists()).toBe(true);
  });

  it("refreshes the session and account events after an organization relation changes", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E2");
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    let membershipActive = false;
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return {
        rows: [{
          event: { id: "E2", name: "春季赛" },
          registrationState: "open",
          organizations: [{ organization: { id: "O1", name: "实验学校" }, organizationJoined: membershipActive }]
        }]
      };
      if (path === "/api/me/registration-context?eventId=E2") return {
        event: { id: "E2", name: "春季赛" },
        organizations: [{ id: "O1", name: "实验学校" }],
        defaultOrganizationId: "O1",
        eligibility: membershipActive
          ? { eligible: true, code: "OK", organization: { id: "O1", name: "实验学校" } }
          : { eligible: false, code: "ACTIVE_ORGANIZATION_REQUIRED", organization: null },
        projects: [],
        grades: []
      };
      if (path === "/api/me/organization-relations") return membershipActive
        ? { active: [{ id: "M1", organization: { id: "O1", name: "实验学校" } }], requests: [], invitations: [] }
        : { active: [], requests: [], invitations: [{ id: "M1", organization: { id: "O1", name: "实验学校" } }] };
      if (path === "/api/me/organization-relations/M1" && options.method === "PATCH") {
        membershipActive = true;
        return { ok: true };
      }
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.get('[data-user-nav="myOrganization"]').trigger("click");
    await flushPromises();
    const registrationContextCalls = apiMock.mock.calls.filter(([path]) => path === "/api/me/registration-context?eventId=E2").length;

    await wrapper.get('[data-action="accept-organization-invitation-M1"]').trigger("click");
    await flushPromises();

    expect(session.restore).toHaveBeenCalledTimes(2);
    expect(session.loadAccountEvents).toHaveBeenCalledTimes(2);
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/me/registration-context?eventId=E2")).toHaveLength(registrationContextCalls);

    await wrapper.get('[data-user-nav="eventCenter"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-event-card="E2"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="eligible-organization"]').text()).toContain("实验学校");
    expect(wrapper.find('[data-field="organization-select"]').exists()).toBe(false);
  });

  it("restores an authorized event slug as its canonical event id", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventSlug=spring-cup");
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E2", slug: "spring-cup", name: "春季赛" } }] };
      if (path === "/api/me/registration-context?eventId=E2") return { event: { id: "E2", name: "春季赛" }, organizations: [], projects: [], grades: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find(".registration-page").exists()).toBe(true);
    expect(apiMock).toHaveBeenCalledWith("/api/me/registration-context?eventId=E2");
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E2");
    expect(new URLSearchParams(window.location.search).has("eventSlug")).toBe(false);
  });

  it("does not open a business page for an event outside the account context", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E2");
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "赛事一" } }] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(wrapper.find(".registration-page").exists()).toBe(false);
    expect(apiMock.mock.calls.some(([path]) => path.includes("registration-context"))).toBe(false);
  });

  it("keeps an archived certificate deep link outside active event rows", async () => {
    window.history.replaceState({}, "", "/admin/?view=certificates&eventId=E-ARCHIVED");
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "当前赛事" }, registrationState: "open" }] };
      if (path === "/api/me/events/E-ARCHIVED/certificates") return { rows: [{ id: "C1", title: "历史证书" }] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-testid="my-certificates-page"]').exists()).toBe(true);
    expect(apiMock).toHaveBeenCalledWith("/api/me/events/E-ARCHIVED/certificates");
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E-ARCHIVED");
  });

  it("clears a missing certificate deep link instead of leaving the account on a broken event", async () => {
    window.history.replaceState({}, "", "/admin/?view=certificates&panel=certificates&eventId=E-MISSING");
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "当前赛事" }, registrationState: "open" }] };
      if (path === "/api/me/events/E-MISSING/certificates") throw Object.assign(new Error("赛事不存在"), { status: 404 });
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-testid="my-certificates-page"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("已清除失效的赛事链接");
    expect(wrapper.text()).not.toContain("赛事不存在");
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("panel")).toBe(false);
  });

  it("does not reuse a consumed deep link after logout and another account login", async () => {
    window.history.replaceState({}, "", "/admin/?view=certificates&eventId=E-ARCHIVED");
    sessionUser.value = { id: "U1", type: "ordinary", name: "原账号", mustChangePassword: false };
    session.logout.mockImplementationOnce(async () => { sessionUser.value = null; });
    session.login.mockImplementationOnce(async () => {
      const user = { id: "U2", type: "ordinary", name: "新账号", mustChangePassword: false };
      sessionUser.value = user;
      return user;
    });
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "当前赛事" }, registrationState: "open" }] };
      if (path === "/api/me/events/E-ARCHIVED/certificates") return { rows: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/me/events/E-ARCHIVED/certificates")).toHaveLength(1);

    await wrapper.get(".user-logout-button").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-auth-form="login"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).has("view")).toBe(false);

    await wrapper.get('[data-auth-form="login"]').trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/me/events/E-ARCHIVED/certificates")).toHaveLength(1);
  });

  it("keeps approved organization navigation stable and scopes the selected event URL", async () => {
    sessionUser.value = { id: "O1U", type: "organization", name: "负责人", mustChangePassword: false };
    session.organizations.value = [{ id: "O1", ownerUserId: "O1U", name: "实验学校", status: "active", reviewStatus: "approved" }];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E2", name: "春季赛" }, participationState: "joined" }] };
      if (path === "/api/organization/events/E2/workspace") return { event: { id: "E2", name: "春季赛" }, summary: {}, projects: [], registrations: [] };
      if (path === "/api/organization/events/E2/registrations") return { rows: [] };
      if (path === "/api/me/organizations") return { rows: session.organizations.value };
      if (path === "/api/organizations/O1/members") return { rows: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.findAll("[data-user-nav]").map((item) => item.attributes("data-user-nav"))).toEqual(["eventCenter", "organizationRecords", "organization", "certificates", "password"]);
    expect(wrapper.find('[data-user-nav="organizationWorkspace"]').exists()).toBe(false);

    await wrapper.get('[data-event-card="E2"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="organization-event-workspace"]').exists()).toBe(true);
    expect(wrapper.get('[data-user-nav="eventCenter"]').classes()).toContain("active");
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E2");

    await wrapper.get('[data-action="back-to-events"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("eventId")).toBeNull();

    await wrapper.get('[data-user-nav="organization"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="organization-console-page"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
    expect(wrapper.find('[data-user-nav="organizationWorkspace"]').exists()).toBe(false);
  });

  it.each(["eventCenter", "organizationWorkspace", "organizationRecords", "certificates"])(
    "routes a pending organization owner away from %s to qualification review",
    async (view) => {
      window.history.replaceState({}, "", `/admin/?view=${view}&eventId=E2`);
      sessionUser.value = { id: "O-PENDING", type: "organization", name: "待审核负责人", mustChangePassword: false };
      session.organizations.value = [{ id: "O1", name: "待审核学校", status: "active", reviewStatus: "pending" }];
      apiMock.mockImplementation(async (path) => {
        if (path === "/api/public/event") return publicData();
        if (path === "/api/me/organizations") return { rows: session.organizations.value };
        if (path === "/api/me/events") throw new Error("restricted owners must not load event operations");
        return { rows: [] };
      });

      const wrapper = mount(App);
      await flushPromises();

      expect(wrapper.findAll("[data-user-nav]").map((item) => item.attributes("data-user-nav"))).toEqual(["organization", "passwordSettings"]);
      expect(wrapper.find('[data-testid="organization-review-progress"]').exists()).toBe(true);
      expect(wrapper.text()).toContain("组织资质正在审核中");
      expect(new URLSearchParams(window.location.search).get("view")).toBe("organization");
      expect(apiMock).not.toHaveBeenCalledWith("/api/me/events");
      wrapper.unmount();
    }
  );

  it("opens My Organization from the ineligible registration guidance", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E1");
    sessionUser.value = { id: "U1", type: "ordinary", name: "普通用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "测试赛事" }, registrationState: "open" }] };
      if (path === "/api/me/registration-context?eventId=E1") return {
        event: { id: "E1", name: "测试赛事" }, organizations: [], defaultOrganizationId: "",
        eligibility: { eligible: false, code: "ACTIVE_ORGANIZATION_REQUIRED", organization: null }, projects: [], grades: []
      };
      if (path === "/api/me/organization-relations") return { active: [], requests: [], invitations: [] };
      if (path === "/api/organizations/search") return { rows: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-action="open-my-organization"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="my-organization-page"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("view")).toBe("myOrganization");
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
  });

  it("filters all certificate history without retaining an active event context", async () => {
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "当前赛事" }, registrationState: "open", organizations: [] }] };
      if (path === "/api/me/registration-context?eventId=E1") return { event: { id: "E1", name: "当前赛事" }, organizations: [], projects: [], grades: [] };
      if (path === "/api/me/certificates") return { rows: [
        { id: "C0", eventId: "E1", eventName: "当前赛事", title: "当前证书" },
        { id: "C1", eventId: "E-ARCHIVED", eventName: "历史赛事", title: "历史证书" }
      ] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-event-card="E1"] [data-action="open"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-user-nav="certificates"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-field="certificate-history-event"]').setValue("E-ARCHIVED");
    await flushPromises();

    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
    expect(wrapper.get(".topbar").text()).toContain("我的证书");
    expect(wrapper.text()).toContain("历史证书");
    expect(wrapper.text()).not.toContain("当前证书");
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/me/certificates")).toHaveLength(1);

    await wrapper.get('[data-user-nav="eventCenter"]').trigger("click");
    await flushPromises();
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
    expect(wrapper.find('[data-user-nav="registration"]').exists()).toBe(false);
    expect(wrapper.find('[data-user-nav="registrationRecords"]').exists()).toBe(true);
  });

  it("continues to reject an archived registration deep link outside active event rows", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E-ARCHIVED");
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "当前赛事" }, registrationState: "open" }] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(wrapper.find('.registration-page').exists()).toBe(false);
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
  });

  it("keeps a logged-in account in the event center when account events cannot load", async () => {
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    session.loadAccountEvents.mockRejectedValueOnce(new Error("赛事列表暂不可用"));
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") throw new Error("赛事列表暂不可用");
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("赛事列表暂不可用");
    expect(wrapper.get('[data-action="retry-event-center"]').exists()).toBe(true);
  });

  it("clears an unavailable deep-link event context before later business navigation", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E2&eventSlug=old-event");
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", slug: "available-event", name: "赛事一" } }] };
      if (path === "/api/me/registration-context") return { organizations: [], projects: [], grades: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("view")).toBe("eventCenter");
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("eventSlug")).toBe(false);

    await wrapper.get('[data-event-card="E1"] [data-action="open"]').trigger("click");
    await flushPromises();
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E1");
    expect(apiMock.mock.calls.some(([path]) => path.includes("eventId=E2"))).toBe(false);
  });

  it("shows overview by default and exposes the event settings workflow", async () => {
    sessionUser.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get(".admin-overview").text()).toContain("赛事运营工作台");
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".event-management").exists()).toBe(true);
    expect(wrapper.find('[data-nav="projects"]').exists()).toBe(false);
    expect(appSource).not.toContain("['events', 'projects']");
  });

  it("opens the complete certificate management page from administrator navigation", async () => {
    sessionUser.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.get('[data-nav="certificates"]').trigger("click");
    await flushPromises();

    expect(wrapper.find(".certificate-management-page").exists()).toBe(true);
    expect(wrapper.text()).toContain("请先从顶部选择赛事");
    expect(wrapper.text()).not.toContain("证书编号");
    expect(wrapper.text()).not.toContain("ZIP");
  });

  it("opens a historical registration in its own event instead of the current event", async () => {
    const current = { id: "E1", name: "当前赛事", isCurrent: true };
    const historical = { id: "E0", name: "历史赛事", isCurrent: false };
    const historicalRegistration = {
      id: "R-HISTORICAL", eventId: "E0", status: "approved", group: "中学组", projectId: "P0", projectName: "历史赛项",
      athlete: { name: "历史选手", school: "历史学校", grade: "六年级" }
    };
    sessionUser.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/organizations" || path === "/api/admin/organizations") return { rows: [], memberships: [] };
      if (path === "/api/me/A1") return { memberships: [] };
      if (path === "/api/users") return { rows: [] };
      if (path === "/api/admin/events") return {
        rows: [current, historical],
        projects: [
          { id: "P1", eventId: "E1", name: "当前赛项", allowedGroups: ["中学组"] },
          { id: "P0", eventId: "E0", name: "历史赛项", allowedGroups: ["中学组"] }
        ]
      };
      if (path.startsWith("/api/admin/events/E0/certificates?")) return { rows: [], total: 0, page: 1, pageSize: 20 };
      if (path.startsWith("/api/admin/events/E0/registrations?")) {
        return { rows: [historicalRegistration], total: 1, page: 1, pageSize: path.includes("pageSize=25") ? 25 : 100, refreshedAt: "2026-07-17T08:00:00.000Z" };
      }
      if (path.includes("/api/admin/events/") && path.includes("/registrations?")) return { rows: [], total: 0, page: 1, pageSize: path.includes("pageSize=25") ? 25 : 100 };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("E0");
    await wrapper.get('[data-nav="registrations"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="manage-certificates"]').trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-event-switcher]").exists()).toBe(false);
    expect(wrapper.get("[data-manual-selected]").text()).toContain("R-HISTORICAL");
  });

  it("does not retain the unreachable legacy single-slot and batch certificate implementation", () => {
    expect(appSource).not.toMatch(/uploadCertificateBatch|batchUploadForm|certificateDraft|registrationEditForm/);
    expect(appSource.match(/<RegistrationManagementPage/g)).toHaveLength(1);
  });

  it("switches an active user to the non-skippable password screen", async () => {
    sessionUser.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    const wrapper = mount(App);
    await flushPromises();

    sessionUser.value = { ...sessionUser.value, mustChangePassword: true };
    await flushPromises();

    expect(wrapper.text()).toContain("首次登录请修改密码");
    expect(wrapper.find('[data-testid="admin-shell"]').exists()).toBe(false);
    expect(wrapper.find(".admin-overview").exists()).toBe(false);
  });

  it("maps organization navigation to the administrator organization review view", async () => {
    sessionUser.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.get('[data-nav="organizations"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("组织审核");
    expect(wrapper.find(".organization-management").exists()).toBe(true);
  });

  it("lets the system generate an ordinary user's temporary password", async () => {
    sessionUser.value = { id: "A1", type: "admin", name: "管理员", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/organizations") return { rows: [] };
      if (path === "/api/me/A1") return { memberships: [] };
      if (path === "/api/users") return { rows: [
        { id: "A1", name: "管理员", phone: "13900000000", type: "admin", status: "active" },
        { id: "U1", name: "张三", phone: "13800000001", type: "ordinary", status: "active" }
      ] };
      if (path === "/api/admin/registrations?pageSize=100" || path === "/api/admin/certificates") return { rows: [] };
      if (path === "/api/admin/users/U1/reset-password") return { user: { id: "U1", mustChangePassword: true }, temporaryPassword: "GeneratedPass2" };
      return { rows: [] };
    });
    const prompt = vi.spyOn(window, "prompt");
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="users"]').trigger("click");
    await flushPromises();

    const resetButton = wrapper.findAll("button").find((button) => button.text() === "重置密码");
    await resetButton.trigger("click");
    await flushPromises();

    expect(prompt).not.toHaveBeenCalled();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/users/U1/reset-password", { method: "POST", body: "{}" });
    expect(wrapper.get('[data-testid="temporary-password-dialog"]').text()).toContain("GeneratedPass2");
  });

  it("returns to login after registration instead of creating a fake session", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/auth/register/ordinary") return { user: { id: "U2" } };
      return { rows: [], memberships: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-auth-tab="register"]').trigger("click");
    await wrapper.get('[data-register="ordinary"]').trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("注册成功，请登录");
    expect(session.setUser).not.toHaveBeenCalled();
    expect(wrapper.get('[data-auth-form="login"]').exists()).toBe(true);
  });

  it("downloads a published user certificate through its returned download URL", async () => {
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiBlobMock.mockResolvedValue(new Blob(["certificate"]));
    URL.createObjectURL = vi.fn(() => "blob:certificate");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/organizations") return { rows: [], memberships: [] };
      if (path === "/api/me/U1") return { memberships: [] };
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "测试赛事" }, registrationState: "open", organizations: [] }] };
      if (path === "/api/me/certificates") return { rows: [{
        id: "C1", eventId: "E1", eventName: "测试赛事", userId: "U1", title: "飞行之星", status: "published", fileName: "star.pdf",
        downloadUrl: "/returned/user-certificate", athlete: { name: "用户" }
      }] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-event-card="E1"] [data-action="open"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-user-nav="certificates"]').trigger("click");
    await wrapper.get('[data-action="download-user-certificate"]').trigger("click");
    await flushPromises();

    expect(apiBlobMock).toHaveBeenCalledWith("/returned/user-certificate");
    expect(wrapper.text()).not.toContain("证书编号");
  });

  it("submits the current event group and project through the scoped endpoint", async () => {
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户" };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/me/events") return { rows: [{ event: { id: "E1", name: "测试赛事" }, registrationState: "open", organizations: [] }] };
      if (path === "/api/me/registration-context?eventId=E1") return {
        event: { id: "E1", name: "测试赛事" }, organizations: [{ id: "O1", name: "温州市实验小学" }],
        defaultOrganizationId: "O1",
        eligibility: { eligible: true, code: "OK", organization: { id: "O1", name: "温州市实验小学" } },
        grades: [{ id: "primary", name: "小学低段", grades: ["三年级"] }],
        projects: [{ id: "P1", eventId: "E1", name: "纸飞机", type: "individual", allowedGroups: ["小学低段"] }]
      };
      if (path === "/api/me/events/E1/registrations") return { row: { id: "R1" } };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-event-card="E1"] [data-action="open"]').trigger("click");
    await flushPromises();
    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("温州市实验小学");
    await inputs[2].setValue("三年级");
    await inputs[3].setValue("13800000001");
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();

    const call = apiMock.mock.calls.find(([path]) => path === "/api/me/events/E1/registrations");
    expect(JSON.parse(call[1].body)).toMatchObject({ projectId: "P1" });
  });
});
