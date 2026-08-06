import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: vi.fn(), apiUrl: (path) => path }));
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
});
