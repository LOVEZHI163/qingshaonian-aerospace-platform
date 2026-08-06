import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: apiMock,
  apiBlob: vi.fn(),
  apiUrl: (path) => path,
  ApiError: class ApiError extends Error {}
}));
vi.mock("../../state/session.js", async () => {
  const { ref } = await import("vue");
  const sessionUser = ref({ id: "A1", name: "管理员", type: "admin", mustChangePassword: false });
  const session = {
    user: sessionUser,
    organizations: ref([]), accountEvents: ref([]), restoring: ref(false),
    restore: vi.fn(async () => sessionUser.value),
    login: vi.fn(async () => sessionUser.value),
    logout: vi.fn(async () => { sessionUser.value = null; }),
    setUser: vi.fn((user) => { sessionUser.value = user; }),
    clear: vi.fn(() => { sessionUser.value = null; }),
    loadAccountEvents: vi.fn(async () => [])
  };
  return { useSession: () => session, testSession: session };
});

import App from "../../App.vue";
import EventManagementPage from "../EventManagementPage.vue";
import { testSession as session } from "../../state/session.js";

enableAutoUnmount(afterEach);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("administrator event context", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/admin/");
    session.user.value = { id: "A1", name: "管理员一", type: "admin", mustChangePassword: false };
    session.login.mockReset();
    session.login.mockImplementation(async () => session.user.value);
    session.logout.mockReset();
    session.logout.mockImplementation(async () => { session.user.value = null; });
    session.restore.mockClear();
    session.loadAccountEvents.mockClear();
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "测试赛事" }, projects: [], grades: [] };
      if (path === "/api/admin/events") return { rows: [
        { id: "E1", name: "春季赛", isCurrent: true },
        { id: "E2", name: "秋季赛" }
      ], projects: [] };
      if (path === "/api/admin/organizations") return { rows: [] };
      if (path.startsWith("/api/admin/events/E2/registrations?")) return {
        rows: [{ id: "R2", eventId: "E2", athlete: { name: "选手", school: "学校" }, status: "approved", group: "小学组", projectName: "纸飞机" }],
        total: 1, page: 1, pageSize: 25
      };
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    });
  });

  it("does not load business data before selection and shares the chosen event with registrations and certificates", async () => {
    const wrapper = mount(App);
    await flushPromises();

    expect(apiMock.mock.calls.some(([path]) => /\/api\/admin\/(dashboard|events\/[^/]+\/(registrations|certificates))/.test(path))).toBe(false);

    await wrapper.get("[data-event-switcher]").setValue("E2");
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E2");
    await wrapper.get('[data-nav="registrations"]').trigger("click");
    await flushPromises();
    expect(apiMock.mock.calls.some(([path]) => path.startsWith("/api/admin/events/E2/registrations?"))).toBe(true);

    await wrapper.get('[data-action="manage-certificates"]').trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-event-switcher]").exists()).toBe(false);
    expect(new URLSearchParams(window.location.search).get("eventId")).toBe("E2");
  });

  it("removes a deleted event from the overview switcher and clears its selected URL context", async () => {
    let adminEventLoads = 0;
    let publicEventLoads = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        return { event: { name: "Public event" }, projects: [], grades: [] };
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        return adminEventLoads >= 2
          ? { rows: [{ id: "E1", name: "Event A", isCurrent: true }], projects: [] }
          : { rows: [{ id: "E1", name: "Event A", isCurrent: true }, { id: "E2", name: "Event B" }], projects: [] };
      }
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("E2");
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();

    const adminLoadsBeforeChange = adminEventLoads;
    const publicLoadsBeforeChange = publicEventLoads;
    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await flushPromises();

    expect(adminEventLoads - adminLoadsBeforeChange).toBe(1);
    expect(publicEventLoads - publicLoadsBeforeChange).toBe(1);

    await wrapper.get('[data-nav="overview"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('option[value="E2"]').exists()).toBe(false);
    expect(wrapper.get("[data-event-switcher]").element.value).toBe("");
    expect(new URL(window.location.href).searchParams.has("eventId")).toBe(false);
  });

  it("keeps the newest administrator event list when an older refresh resolves last", async () => {
    const oldRefresh = deferred();
    const newRefresh = deferred();
    let adminEventLoads = 0;
    apiMock.mockImplementation((path) => {
      if (path === "/api/public/event") return Promise.resolve({ event: { name: "Public event" }, projects: [], grades: [] });
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        if (adminEventLoads === 1) return Promise.resolve({ rows: [
          { id: "E1", name: "Event A", isCurrent: true },
          { id: "E2", name: "Event B" }
        ], projects: [] });
        return adminEventLoads === 2 ? oldRefresh.promise : newRefresh.promise;
      }
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    const eventPage = wrapper.findComponent(EventManagementPage);

    eventPage.vm.$emit("event-changed");
    await Promise.resolve();
    eventPage.vm.$emit("event-changed");
    await Promise.resolve();
    newRefresh.resolve({ rows: [{ id: "E1", name: "Event A", isCurrent: true }], projects: [] });
    await flushPromises();
    oldRefresh.resolve({ rows: [
      { id: "E1", name: "Event A", isCurrent: true },
      { id: "E2", name: "Event B" }
    ], projects: [] });
    await flushPromises();

    await wrapper.get('[data-nav="overview"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('option[value="E2"]').exists()).toBe(false);
  });

  it("keeps the newest public event when an older refresh resolves last", async () => {
    const oldRefresh = deferred();
    const newRefresh = deferred();
    let publicEventLoads = 0;
    apiMock.mockImplementation((path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        if (publicEventLoads === 1) return Promise.resolve({ event: { name: "Initial public event" }, projects: [], grades: [] });
        return publicEventLoads === 2 ? oldRefresh.promise : newRefresh.promise;
      }
      if (path === "/api/admin/events") return Promise.resolve({ rows: [{ id: "E1", name: "Event A", isCurrent: true }], projects: [] });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    const eventPage = wrapper.findComponent(EventManagementPage);

    eventPage.vm.$emit("event-changed");
    await Promise.resolve();
    eventPage.vm.$emit("event-changed");
    await Promise.resolve();
    newRefresh.resolve({ event: { name: "Newest public event" }, projects: [], grades: [] });
    await flushPromises();
    oldRefresh.resolve({ event: { name: "Stale public event" }, projects: [], grades: [] });
    await flushPromises();

    expect(wrapper.get(".admin-header").text()).toContain("Newest public event");
    expect(wrapper.get(".admin-header").text()).not.toContain("Stale public event");
  });

  it("preserves the selected event when the administrator directory refresh fails and recovers on the next success", async () => {
    let adminEventLoads = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") return { event: { name: "Public event" }, projects: [], grades: [] };
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        if (adminEventLoads === 2) throw new Error("directory unavailable");
        return adminEventLoads >= 3
          ? { rows: [{ id: "E1", name: "Event A", isCurrent: true }], projects: [] }
          : { rows: [{ id: "E1", name: "Event A", isCurrent: true }, { id: "E2", name: "Event B" }], projects: [] };
      }
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("E2");
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();

    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await flushPromises();
    await wrapper.get('[data-nav="overview"]').trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-event-switcher]").element.value).toBe("E2");
    expect(new URL(window.location.href).searchParams.get("eventId")).toBe("E2");
    expect(wrapper.text()).toContain("管理员赛事目录刷新失败");
    expect(wrapper.text()).toContain("已保留当前赛事选择");

    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await flushPromises();
    await wrapper.get('[data-nav="overview"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('option[value="E2"]').exists()).toBe(false);
    expect(wrapper.get("[data-event-switcher]").element.value).toBe("");
    expect(new URL(window.location.href).searchParams.has("eventId")).toBe(false);
    expect(wrapper.text()).not.toContain("管理员赛事目录刷新失败");
  });

  it("updates the directory but keeps the last public header when only the public refresh fails", async () => {
    let publicEventLoads = 0;
    let adminEventLoads = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        if (publicEventLoads === 2) throw new Error("public unavailable");
        return { event: { name: "Last known public event" }, projects: [], grades: [] };
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        return adminEventLoads >= 2
          ? { rows: [{ id: "E1", name: "Event A", isCurrent: true }], projects: [] }
          : { rows: [{ id: "E1", name: "Event A", isCurrent: true }, { id: "E2", name: "Event B" }], projects: [] };
      }
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("E2");
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await flushPromises();
    await wrapper.get('[data-nav="overview"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('option[value="E2"]').exists()).toBe(false);
    expect(wrapper.get("[data-event-switcher]").element.value).toBe("");
    expect(new URL(window.location.href).searchParams.has("eventId")).toBe(false);
    expect(wrapper.get(".admin-header").text()).toContain("Last known public event");
    expect(wrapper.text()).toContain("公开赛事信息刷新失败");
    expect(wrapper.text()).toContain("赛事目录已更新");
  });

  it("handles both refresh failures without clearing the selected event", async () => {
    let publicEventLoads = 0;
    let adminEventLoads = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        if (publicEventLoads === 2) throw new Error("public unavailable");
        return { event: { name: "Last known public event" }, projects: [], grades: [] };
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        if (adminEventLoads === 2) throw new Error("directory unavailable");
        return { rows: [{ id: "E1", name: "Event A", isCurrent: true }, { id: "E2", name: "Event B" }], projects: [] };
      }
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("E2");
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await flushPromises();
    await wrapper.get('[data-nav="overview"]').trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-event-switcher]").element.value).toBe("E2");
    expect(new URL(window.location.href).searchParams.get("eventId")).toBe("E2");
    expect(wrapper.get(".admin-header").text()).toContain("Last known public event");
    expect(wrapper.text()).toContain("赛事上下文刷新失败");
  });

  it("does not restore an error from an older failed refresh after a newer refresh succeeds", async () => {
    const oldPublicRefresh = deferred();
    const oldAdminRefresh = deferred();
    let publicEventLoads = 0;
    let adminEventLoads = 0;
    apiMock.mockImplementation((path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        if (publicEventLoads === 2) return oldPublicRefresh.promise;
        return Promise.resolve({ event: { name: publicEventLoads >= 3 ? "Newest public event" : "Initial public event" }, projects: [], grades: [] });
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        if (adminEventLoads === 2) return oldAdminRefresh.promise;
        return Promise.resolve({ rows: [{ id: "E1", name: "Event A", isCurrent: true }], projects: [] });
      }
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    const eventPage = wrapper.findComponent(EventManagementPage);

    eventPage.vm.$emit("event-changed");
    await Promise.resolve();
    eventPage.vm.$emit("event-changed");
    await flushPromises();
    oldPublicRefresh.reject(new Error("stale public failure"));
    oldAdminRefresh.reject(new Error("stale directory failure"));
    await flushPromises();

    expect(wrapper.get(".admin-header").text()).toContain("Newest public event");
    expect(wrapper.text()).not.toContain("刷新失败");
  });

  it("ignores a successful public refresh from the previous administrator session", async () => {
    const oldPublicRefresh = deferred();
    const oldAdminRefresh = deferred();
    let publicEventLoads = 0;
    let adminEventLoads = 0;
    apiMock.mockImplementation((path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        return publicEventLoads === 1
          ? Promise.resolve({ event: { name: "Current public event" }, projects: [], grades: [] })
          : oldPublicRefresh.promise;
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        if (adminEventLoads === 1) return Promise.resolve({ rows: [{ id: "E2", name: "Old administrator event" }], projects: [] });
        if (adminEventLoads === 2) return oldAdminRefresh.promise;
        return Promise.resolve({ rows: [{ id: "N1", name: "New administrator event" }], projects: [] });
      }
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("E2");
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await Promise.resolve();

    await wrapper.get('[data-action="logout"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-auth-form="login"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("刷新失败");

    const nextAdministrator = { id: "A2", name: "管理员二", type: "admin", mustChangePassword: false };
    session.login.mockImplementationOnce(async () => {
      session.user.value = nextAdministrator;
      return nextAdministrator;
    });
    await wrapper.get('[data-auth-form="login"]').trigger("submit");
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("N1");
    expect(new URL(window.location.href).searchParams.get("eventId")).toBe("N1");

    oldPublicRefresh.resolve({ event: { name: "Stale public event" }, projects: [], grades: [] });
    oldAdminRefresh.reject(new Error("stale directory failure"));
    await flushPromises();

    expect(wrapper.get(".admin-header").text()).toContain("Current public event");
    expect(wrapper.get(".admin-header").text()).not.toContain("Stale public event");
    expect(wrapper.find('option[value="E2"]').exists()).toBe(false);
    expect(wrapper.find('option[value="N1"]').exists()).toBe(true);
    expect(wrapper.get("[data-event-switcher]").element.value).toBe("N1");
    expect(new URL(window.location.href).searchParams.get("eventId")).toBe("N1");
    expect(wrapper.text()).not.toContain("stale directory failure");
    expect(wrapper.text()).not.toContain("刷新失败");
  });

  it("ignores refresh errors from the previous administrator session", async () => {
    const oldPublicRefresh = deferred();
    const oldAdminRefresh = deferred();
    let publicEventLoads = 0;
    let adminEventLoads = 0;
    apiMock.mockImplementation((path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        return publicEventLoads === 1
          ? Promise.resolve({ event: { name: "Current public event" }, projects: [], grades: [] })
          : oldPublicRefresh.promise;
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        if (adminEventLoads === 1) return Promise.resolve({ rows: [{ id: "E2", name: "Old administrator event" }], projects: [] });
        if (adminEventLoads === 2) return oldAdminRefresh.promise;
        return Promise.resolve({ rows: [{ id: "N1", name: "New administrator event" }], projects: [] });
      }
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("E2");
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await Promise.resolve();
    await wrapper.get('[data-action="logout"]').trigger("click");
    await flushPromises();

    const nextAdministrator = { id: "A2", name: "管理员二", type: "admin", mustChangePassword: false };
    session.login.mockImplementationOnce(async () => {
      session.user.value = nextAdministrator;
      return nextAdministrator;
    });
    await wrapper.get('[data-auth-form="login"]').trigger("submit");
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("N1");

    oldPublicRefresh.reject(new Error("stale public failure"));
    oldAdminRefresh.resolve({ rows: [{ id: "E2", name: "Old administrator event" }], projects: [] });
    await flushPromises();

    expect(wrapper.get(".admin-header").text()).toContain("Current public event");
    expect(wrapper.find('option[value="E2"]').exists()).toBe(false);
    expect(wrapper.get("[data-event-switcher]").element.value).toBe("N1");
    expect(new URL(window.location.href).searchParams.get("eventId")).toBe("N1");
    expect(wrapper.text()).not.toContain("公开赛事信息刷新失败");
    expect(wrapper.text()).not.toContain("stale public failure");
  });

  it("invalidates a pending refresh and clears the URL when a 401-style session clear removes the administrator", async () => {
    const oldPublicRefresh = deferred();
    const oldAdminRefresh = deferred();
    let publicEventLoads = 0;
    let adminEventLoads = 0;
    apiMock.mockImplementation((path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        return publicEventLoads === 1
          ? Promise.resolve({ event: { name: "Current public event" }, projects: [], grades: [] })
          : oldPublicRefresh.promise;
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        return adminEventLoads === 1
          ? Promise.resolve({ rows: [{ id: "E2", name: "Administrator event" }], projects: [] })
          : oldAdminRefresh.promise;
      }
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("[data-event-switcher]").setValue("E2");
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await Promise.resolve();
    await wrapper.get('[data-nav="overview"]').trigger("click");
    await flushPromises();
    expect(new URL(window.location.href).searchParams.get("eventId")).toBe("E2");

    session.clear();
    await flushPromises();
    oldPublicRefresh.resolve({ event: { name: "Stale public event" }, projects: [], grades: [] });
    oldAdminRefresh.reject(new Error("stale directory failure"));
    await flushPromises();

    expect(wrapper.find('[data-auth-form="login"]').exists()).toBe(true);
    expect(new URL(window.location.href).searchParams.has("eventId")).toBe(false);
    expect(wrapper.text()).not.toContain("Stale public event");
    expect(wrapper.text()).not.toContain("stale directory failure");
    expect(wrapper.text()).not.toContain("刷新失败");
  });

  it("clears an existing event refresh message on logout", async () => {
    let publicEventLoads = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        if (publicEventLoads === 2) throw new Error("public unavailable");
        return { event: { name: "Current public event" }, projects: [], grades: [] };
      }
      if (path === "/api/admin/events") return { rows: [{ id: "E1", name: "Administrator event" }], projects: [] };
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    wrapper.findComponent(EventManagementPage).vm.$emit("event-changed");
    await flushPromises();
    expect(wrapper.text()).toContain("公开赛事信息刷新失败");

    await wrapper.get('[data-action="logout"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-auth-form="login"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("公开赛事信息刷新失败");
  });

  it("performs one unified administrator refresh after a successful event mutation", async () => {
    let adminEventLoads = 0;
    let publicEventLoads = 0;
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        return { event: { name: "Public event" }, projects: [], grades: [] };
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        return { rows: [{
          id: "E1", name: "Event A", theme: "Theme", dateLabel: "Date", venue: "Venue", contact: "Contact",
          registrationStartAt: "2026-01-01T00:00:00.000Z", registrationEndAt: "2026-02-01T00:00:00.000Z",
          registrationMode: "automatic", status: "published", isCurrent: true
        }], projects: [] };
      }
      if (path === "/api/admin/events/E1/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      if (path === "/api/admin/events/E1" && options.method === "PATCH") return { row: { id: "E1", registrationMode: "force_closed" } };
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-event-card="E1"] [data-action="open-event"]').trigger("click");
    await flushPromises();
    const adminLoadsBeforeMutation = adminEventLoads;
    const publicLoadsBeforeMutation = publicEventLoads;

    await wrapper.get('[data-mode="force_closed"]').trigger("click");
    await flushPromises();

    expect(adminEventLoads - adminLoadsBeforeMutation).toBe(1);
    expect(publicEventLoads - publicLoadsBeforeMutation).toBe(1);
  });

  it("does not refresh administrator event context after a failed mutation", async () => {
    let adminEventLoads = 0;
    let publicEventLoads = 0;
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/public/event") {
        publicEventLoads += 1;
        return { event: { name: "Public event" }, projects: [], grades: [] };
      }
      if (path === "/api/admin/events") {
        adminEventLoads += 1;
        return { rows: [{
          id: "E1", name: "Event A", theme: "Theme", dateLabel: "Date", venue: "Venue", contact: "Contact",
          registrationStartAt: "2026-01-01T00:00:00.000Z", registrationEndAt: "2026-02-01T00:00:00.000Z",
          registrationMode: "automatic", status: "published", isCurrent: true
        }], projects: [] };
      }
      if (path === "/api/admin/events/E1/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      if (path === "/api/admin/events/E1" && options.method === "PATCH") throw new Error("save failed");
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    });

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-nav="events"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-event-card="E1"] [data-action="open-event"]').trigger("click");
    await flushPromises();
    const adminLoadsBeforeMutation = adminEventLoads;
    const publicLoadsBeforeMutation = publicEventLoads;

    await wrapper.get('[data-mode="force_closed"]').trigger("click");
    await flushPromises();

    expect(adminEventLoads - adminLoadsBeforeMutation).toBe(0);
    expect(publicEventLoads - publicLoadsBeforeMutation).toBe(0);
  });
});
