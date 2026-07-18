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
    restoring: ref(false),
    restore: vi.fn(async () => {}),
    login: vi.fn(),
    logout: vi.fn(),
    setUser: vi.fn((user) => { sessionUser.value = user; }),
    clear: vi.fn(() => { sessionUser.value = null; })
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
    apiMock.mockReset();
    sessionUser.value = null;
    restoring.value = false;
    session.restore.mockClear();
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

    expect(wrapper.get(".certificate-filter-grid select").element.value).toBe("E0");
    expect(wrapper.get(".registration-summary").text()).toContain("R-HISTORICAL");
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
      if (path === "/api/me/registrations") return { rows: [] };
      if (path === "/api/me/certificates") return { rows: [{
        id: "C1", userId: "U1", title: "飞行之星", status: "published", fileName: "star.pdf",
        downloadUrl: "/returned/user-certificate", athlete: { name: "用户" }
      }] };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    const certificateNav = wrapper.findAll("aside button").find((button) => button.text() === "证书查询");
    await certificateNav.trigger("click");
    await wrapper.get('[data-action="download-user-certificate"]').trigger("click");
    await flushPromises();

    expect(apiBlobMock).toHaveBeenCalledWith("/returned/user-certificate");
    expect(wrapper.text()).not.toContain("证书编号");
  });

  it("uses the current event group and project in duplicate checks", async () => {
    sessionUser.value = { id: "U1", type: "ordinary", name: "用户" };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return {
        event: { name: "测试赛事" },
        grades: ["小学低段", "小学高段", "中学组", "职高/高中组"],
        projects: [{ id: "P1", name: "纸飞机", type: "individual" }]
      };
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/organizations") return { rows: [] };
      if (path === "/api/me/U1") return { memberships: [] };
      if (path === "/api/me/registrations" || path === "/api/me/certificates") return { rows: [] };
      if (path === "/api/registrations/check") return { duplicate: false };
      return { rows: [] };
    });
    const wrapper = mount(App);
    await flushPromises();
    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("温州市实验小学");
    await inputs[2].setValue("三年级");
    await inputs[3].setValue("13800000001");
    await flushPromises();

    const call = apiMock.mock.calls.find(([path]) => path === "/api/registrations/check");
    expect(JSON.parse(call[1].body)).toMatchObject({ projectId: "P1", group: "小学低段" });
  });
});
