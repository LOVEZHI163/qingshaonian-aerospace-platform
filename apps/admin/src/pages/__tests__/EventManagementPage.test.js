import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import EventManagementPage from "../EventManagementPage.vue";

const event = {
  id: "E1",
  name: "2026赛事",
  theme: "航空创新",
  dateLabel: "2026年11月21日",
  venue: "温州",
  contact: "组委会",
  registrationStartAt: "2026-10-01T00:00:00.000Z",
  registrationEndAt: "2026-11-01T00:00:00.000Z",
  registrationMode: "automatic",
  status: "published",
  isCurrent: true
};
const project = {
  id: "P1",
  eventId: "E1",
  name: "纸飞机",
  type: "individual",
  category: "航空模型",
  enabled: true,
  instructorRequired: false,
  displayOrder: 1,
  allowedGroups: ["小学低段", "小学高段"]
};

function mockLoads(registrations = []) {
  apiMock.mockImplementation(async (path) => {
    if (path === "/api/admin/events") return { rows: [event], projects: [project] };
    if (path === "/api/admin/registrations?pageSize=100") return { rows: registrations, total: registrations.length, page: 1, pageSize: 100 };
    return { row: event };
  });
}

describe("EventManagementPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.restoreAllMocks();
  });

  it("shows the current event and all registration controls", async () => {
    mockLoads();
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("2026赛事");
    expect(wrapper.text()).toContain("当前赛事");
    expect(wrapper.text()).toContain("自动");
    expect(wrapper.text()).toContain("临时开放");
    expect(wrapper.text()).toContain("临时关闭");
  });

  it("updates the registration mode, reloads and announces the event change", async () => {
    mockLoads();
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    await wrapper.get('[data-mode="force_closed"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1", {
      method: "PATCH",
      body: JSON.stringify({ registrationMode: "force_closed" })
    });
    expect(wrapper.emitted("event-changed")).toHaveLength(1);
  });

  it("copies an event with the entered name", async () => {
    mockLoads();
    vi.spyOn(window, "prompt").mockReturnValue("2027赛事");
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    await wrapper.get('[data-action="copy-event"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/copy", {
      method: "POST",
      body: JSON.stringify({ name: "2027赛事" })
    });
  });

  it("offers disable instead of delete when a project has registrations", async () => {
    mockLoads([{ id: "R1", projectId: "P1" }]);
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    expect(wrapper.find('[data-action="delete-project"]').exists()).toBe(false);
    expect(wrapper.get('[data-action="disable-project"]').text()).toContain("停用");
  });

  it("loads every registration page before determining project history", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `R${index + 1}`, projectId: "P1" }));
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: firstPage, total: 101, page: 1, pageSize: 100 };
      if (path === "/api/admin/registrations?page=2&pageSize=100") return { rows: [{ id: "R101", projectId: "P1" }], total: 101, page: 2, pageSize: 100 };
      return { row: event };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/registrations?page=2&pageSize=100");
    expect(wrapper.find('[data-action="delete-project"]').exists()).toBe(false);
    expect(wrapper.get('[data-action="disable-project"]').text()).toContain("停用");
  });

  it("shows an incomplete-data error and preserves existing project history when pagination fails", async () => {
    let registrationRequests = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/registrations?pageSize=100") {
        registrationRequests += 1;
        return registrationRequests === 1
          ? { rows: [{ id: "R1", projectId: "P1" }], total: 1, page: 1, pageSize: 100 }
          : { rows: [], page: 1, pageSize: 100 };
      }
      return { row: event };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    expect(wrapper.find('[data-action="delete-project"]').exists()).toBe(false);

    await wrapper.get('[data-mode="force_closed"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("报名数据在加载期间发生变化，请刷新重试");
    expect(wrapper.find('[data-action="delete-project"]').exists()).toBe(false);
  });

  it("opens the form and creates the first event from an empty state", async () => {
    const rows = [];
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events" && options.method === "POST") {
        const row = { id: "E1", ...JSON.parse(options.body), status: "draft", isCurrent: false };
        rows.push(row);
        return { row };
      }
      if (path === "/api/admin/events") return { rows, projects: [] };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      return { row: event };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    const createButton = wrapper.findAll("button").find((button) => button.text().includes("新建赛事草稿"));
    await createButton.trigger("click");
    const form = wrapper.get("form.event-form");
    const inputs = form.findAll("input");
    await inputs[0].setValue("首届赛事");
    await inputs[1].setValue("航空创新");
    await inputs[2].setValue("2027年5月1日");
    await inputs[3].setValue("温州");
    await inputs[4].setValue("组委会 0577-12345678");
    await inputs[5].setValue("2027-04-01T08:00");
    await inputs[6].setValue("2027-04-30T18:00");
    await form.trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events", expect.objectContaining({ method: "POST" }));
    expect(wrapper.text()).toContain("赛事草稿已创建");
  });

  it("requires two confirmations before archiving an event", async () => {
    mockLoads();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    const archiveButton = wrapper.findAll("button").find((button) => button.text() === "归档");
    await archiveButton.trigger("click");
    await flushPromises();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/archive", { method: "POST" });
  });

  it("shows resource cleanup controls only for the selected archived event", async () => {
    const archived = { ...event, id: "E-OLD", name: "2025赛事", status: "archived", isCurrent: false };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [archived], projects: [] };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      if (path === "/api/admin/events/E-OLD/storage") return { certificateFiles: 1, importFiles: 0, totalBytes: 100 };
      return { row: archived };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    expect(wrapper.get('[data-action="open-cleanup"]').exists()).toBe(true);
    expect(wrapper.get('[data-action="open-delete"]').exists()).toBe(true);
  });
});
