import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: apiMock,
  apiBlob: vi.fn(),
  apiUrl: (path) => path,
  ApiError: class ApiError extends Error {}
}));
vi.mock("../../state/session.js", async () => {
  const { ref } = await import("vue");
  const session = {
    user: ref({ id: "A1", name: "管理员", type: "admin", mustChangePassword: false }),
    organizations: ref([]), accountEvents: ref([]), restoring: ref(false),
    restore: vi.fn(async () => {}), logout: vi.fn(), loadAccountEvents: vi.fn(async () => [])
  };
  return { useSession: () => session };
});

import App from "../../App.vue";
import EventManagementPage from "../EventManagementPage.vue";

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
