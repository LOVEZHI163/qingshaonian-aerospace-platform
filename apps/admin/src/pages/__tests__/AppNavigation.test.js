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
  });

  afterEach(() => {
    mounted.forEach((wrapper) => wrapper.unmount());
    mounted = [];
  });

  it("shows all six administrator modules", async () => {
    const wrapper = await mountFor({ id: "A1", type: "admin", name: "管理员", mustChangePassword: false }); mounted.push(wrapper);
    const labels = wrapper.findAll("[data-nav]").map((item) => item.text());
    expect(labels).toEqual(["概览", "赛事设置", "组织用户", "报名管理", "证书管理", "普通用户管理"]);
  });

  it("limits ordinary users to registration, records and certificates", async () => {
    const wrapper = await mountFor({ id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false }); mounted.push(wrapper);
    const labels = wrapper.findAll("[data-user-nav]").map((item) => item.text());
    expect(labels).toEqual(["报名", "报名记录", "证书查询"]);
    expect(wrapper.text()).not.toContain("普通用户管理");
    expect(apiMock.mock.calls.some(([path]) => path === "/api/users" || path.startsWith("/api/admin/"))).toBe(false);
  });

  it("restores a whitelisted registration deep link with its event id", async () => {
    window.history.replaceState({}, "", "/admin/?view=registration&eventId=E2");
    const wrapper = await mountFor({ id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false }); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find(".registration-page").exists()).toBe(true);
    expect(apiMock.mock.calls.some(([path]) => path === "/api/me/registration-context?eventId=E2")).toBe(true);
  });

  it("does not pass an invalid view or event query into application components", async () => {
    window.history.replaceState({}, "", "/admin/?view=constructor&eventId=%3Cscript%3E");
    const wrapper = await mountFor({ id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false }); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.find(".registration-page").exists()).toBe(true);
    expect(apiMock.mock.calls.some(([path]) => path.includes("%3Cscript%3E") || path.includes("<script>"))).toBe(false);
  });

  it("shows only review progress to a pending organization", async () => {
    const organization = { id: "O1", ownerUserId: "O1U", name: "待审核学校", reviewStatus: "pending", status: "active", membershipRole: "owner" };
    const wrapper = await mountFor({ id: "O1U", type: "organization", name: "负责人", phone: "13800000002", mustChangePassword: false }, organization); mounted.push(wrapper);
    expect(wrapper.text()).toContain("组织资料正在审核");
    expect(wrapper.text()).not.toContain("邀请成员");
    expect(wrapper.findAll("[data-user-nav]").map((item) => item.text())).toEqual(["审核进度"]);
    expect(apiMock.mock.calls.some(([path]) => path.includes("/registrations") || path.includes("/certificates"))).toBe(false);
  });

  it("opens the organization console for an approved owner", async () => {
    const organization = { id: "O1", ownerUserId: "O1U", name: "实验学校", reviewStatus: "approved", status: "active", membershipRole: "owner" };
    const wrapper = await mountFor({ id: "O1U", type: "organization", name: "负责人", phone: "13800000002", mustChangePassword: false }, organization); mounted.push(wrapper);
    expect(wrapper.findAll("[data-user-nav]").map((item) => item.text())).toEqual(["报名", "报名记录", "证书查询", "组织控制台"]);
    expect(wrapper.text()).toContain("邀请成员");
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
    apiMock.mockImplementation(async (path) => path === "/api/me/certificates" ? { rows: [{
      id: "C1", title: "一等奖", status: "published", cleanedAt: "2026-07-18T00:00:00.000Z",
      athlete: { name: "张三", school: "实验学校", grade: "三年级" }, projectName: "纸飞机"
    }] } : { rows: [] });
    const wrapper = mount(MyCertificatesPage); mounted.push(wrapper);
    await flushPromises();

    expect(wrapper.text()).toContain("原文件已清理");
    expect(wrapper.find('[data-action="download-user-certificate"]').exists()).toBe(false);
    expect(apiMock.mock.calls.some(([path]) => path.startsWith("/api/admin/"))).toBe(false);
  });
});
