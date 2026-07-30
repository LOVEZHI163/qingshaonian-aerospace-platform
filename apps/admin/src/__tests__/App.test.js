import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, apiUrl: (path) => path }));
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

function publicData() {
  return { event: { name: "测试赛事" }, projects: [], grades: [] };
}

describe("App session integration", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    apiMock.mockReset();
    sessionUser.value = null;
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

  it.each(["ordinary", "organization"])("opens the event center by default for %s accounts", async (type) => {
    sessionUser.value = { id: `${type}-1`, type, name: "账户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-testid="event-center-page"]').exists()).toBe(true);
  });

  it("keeps ordinary registration actions behind an explicit event context and clears it on return", async () => {
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户", mustChangePassword: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/me/events") return { rows: [{ event: { id: "E2", name: "春季赛" }, registrationState: "open", registrationCount: 0, organizations: [] }] };
      if (path === "/api/me/registration-context?eventId=E2") return { event: { id: "E2", name: "春季赛" }, organizations: [], projects: [], grades: [] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('[data-user-nav="registration"]').exists()).toBe(false);
    expect(wrapper.find('[data-user-nav="registrationRecords"]').exists()).toBe(false);

    await wrapper.get('[data-event-card="E2"] [data-action="open"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-user-nav="registration"]').exists()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E2");

    await wrapper.get('[data-user-nav="eventCenter"]').trigger("click");
    await flushPromises();
    expect(new URLSearchParams(window.location.search).has("eventId")).toBe(false);
    expect(wrapper.find('[data-user-nav="registration"]').exists()).toBe(false);
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

    expect(wrapper.get(".admin-overview").text()).toContain("管理概览");
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
    expect(wrapper.text()).toContain("Excel 导入证书");
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
      if (path === "/api/admin/certificates") return { rows: [] };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      if (path.includes("/api/admin/registrations?") && path.includes("eventId=E0")) {
        return { rows: [historicalRegistration], total: 1, page: 1, pageSize: path.includes("pageSize=25") ? 25 : 100, refreshedAt: "2026-07-17T08:00:00.000Z" };
      }
      if (path.includes("/api/admin/registrations?")) return { rows: [], total: 0, page: 1, pageSize: path.includes("pageSize=25") ? 25 : 100 };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="registrations"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-filter="eventId"]').setValue("E0");
    await flushPromises();
    await wrapper.get('[data-action="manage-certificates"]').trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-list-event]").element.value).toBe("E0");
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

  it("rejects an invalid administrator temporary password before calling the API", async () => {
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
      return { rows: [] };
    });
    vi.spyOn(window, "prompt").mockReturnValue("short1");
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="users"]').trigger("click");
    await flushPromises();

    const resetButton = wrapper.findAll("button").find((button) => button.text() === "重置临时密码");
    await resetButton.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("至少 8 位且必须同时包含字母和数字");
    expect(apiMock.mock.calls.some(([path]) => path === "/api/admin/users/U1/reset-password")).toBe(false);
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
      if (path === "/api/me/events/E1/certificates") return { rows: [{
        id: "C1", userId: "U1", title: "飞行之星", status: "published", fileName: "star.pdf",
        downloadUrl: "/returned/user-certificate", athlete: { name: "用户" }
      }] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-event-card="E1"] [data-action="open"]').trigger("click");
    await flushPromises();
    const certificateNav = wrapper.findAll("aside button").find((button) => button.text() === "证书查询");
    await certificateNav.trigger("click");
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
        event: { id: "E1", name: "测试赛事" }, organizations: [],
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
