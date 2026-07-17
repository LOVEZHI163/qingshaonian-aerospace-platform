import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api.js", () => ({ api: apiMock }));
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

  it("returns to login after registration instead of creating a fake session", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return publicData();
      if (path === "/api/public/features") return { smsPasswordResetEnabled: false };
      if (path === "/api/auth/register") return { user: { id: "U2" } };
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
