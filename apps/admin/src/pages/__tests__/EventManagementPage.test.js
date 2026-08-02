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
    if (path === "/api/admin/events/E1/registrations?pageSize=100") return { rows: registrations, total: registrations.length, page: 1, pageSize: 100 };
    return { row: event };
  });
}

async function openEventDetails(wrapper, eventId = "E1") {
  await wrapper.get(`[data-event-card="${eventId}"] [data-action="open-event"]`).trigger("click");
  await flushPromises();
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

    expect(wrapper.get('[data-management-level="list"]').text()).toContain("2026赛事");
    expect(wrapper.get('[data-event-card="E1"]').text()).toContain("1赛项");
    expect(wrapper.text()).toContain("官网首页置顶");
    await openEventDetails(wrapper);
    expect(wrapper.text()).toContain("自动");
    expect(wrapper.text()).toContain("临时开放");
    expect(wrapper.text()).toContain("临时关闭");
  });

  it("switches real panels without reloading and keeps the selected event", async () => {
    mockLoads();
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper);
    const initialEventLoads = apiMock.mock.calls.filter(([path]) => path === "/api/admin/events").length;

    expect(wrapper.get('[data-section="event"]').classes()).toContain("active");
    expect(wrapper.find('[data-section-panel="event"]').exists()).toBe(true);
    expect(wrapper.find('[data-section-panel="projects"]').exists()).toBe(false);
    await wrapper.get("form.event-form").findAll("input")[1].setValue("未保存主题");

    await wrapper.get('[data-section="projects"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-section-panel="event"]').exists()).toBe(false);
    expect(wrapper.get('[data-section-panel="projects"]').text()).toContain("纸飞机");
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/admin/events")).toHaveLength(initialEventLoads);
    await wrapper.get("form.project-form").findAll("input")[0].setValue("未保存赛项");

    await wrapper.get('[data-section="event"]').trigger("click");
    expect(wrapper.get('.event-detail-heading').text()).toContain("2026赛事");
    expect(wrapper.get("form.event-form").findAll("input")[1].element.value).toBe("未保存主题");
    await wrapper.get('[data-section="projects"]').trigger("click");
    expect(wrapper.get("form.project-form").findAll("input")[0].element.value).toBe("未保存赛项");
  });

  it("shows an event empty state and starts the first event from that level", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [], projects: [] };
      if (path === "/api/admin/events/E1/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      return { rows: [] };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("还没有赛事");
    expect(wrapper.find('[data-section="projects"]').exists()).toBe(false);
    await wrapper.get('[data-action="start-create-event-empty"]').trigger("click");
    expect(wrapper.get('[data-management-level="detail"]').text()).toContain("创建赛事草稿");
    expect(wrapper.find('[data-section="projects"]').exists()).toBe(false);
  });

  it("opens a selected event before managing its projects", async () => {
    const secondEvent = { ...event, id: "E2", name: "2027赛事", isCurrent: false };
    const secondProject = { ...project, id: "P2", eventId: "E2", name: "无人机竞速" };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event, secondEvent], projects: [project, secondProject] };
      if (path === "/api/admin/events/E1/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      return { rows: [] };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    expect(wrapper.findAll('[data-event-card]')).toHaveLength(2);
    await openEventDetails(wrapper, "E2");
    expect(wrapper.get('.event-detail-heading').text()).toContain("2027赛事");
    await wrapper.get('[data-section="projects"]').trigger("click");
    expect(wrapper.get('[data-section-panel="projects"]').text()).toContain("无人机竞速");
    await wrapper.get('[data-section="event"]').trigger("click");
    expect(wrapper.get("form.event-form").findAll("input")[0].element.value).toBe("2027赛事");
  });

  it("updates the registration mode, reloads and announces the event change", async () => {
    mockLoads();
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper);

    await wrapper.get('[data-mode="force_closed"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1", {
      method: "PATCH",
      body: JSON.stringify({ registrationMode: "force_closed" })
    });
    expect(wrapper.emitted("event-changed")).toHaveLength(1);
  });

  it("offers submission modes and saves the selected project submission mode", async () => {
    mockLoads();
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper);
    await wrapper.get('[data-section="projects"]').trigger("click");
    await wrapper.get('[data-action="edit-project"]').trigger("click");

    expect(wrapper.get('[data-field="submission-mode"]').findAll("option").map((node) => node.text()))
      .toEqual(["无需上传", "图像视频作品"]);

    await wrapper.get('[data-field="submission-mode"]').setValue("image_video");
    await wrapper.get("form.project-form").trigger("submit");

    expect(apiMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: expect.stringContaining('"submissionMode":"image_video"')
    }));
  });

  it("copies an event with the entered name", async () => {
    mockLoads();
    vi.spyOn(window, "prompt").mockReturnValue("2027赛事");
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper);

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
    await openEventDetails(wrapper);
    await wrapper.get('[data-section="projects"]').trigger("click");

    expect(wrapper.find('[data-action="delete-project"]').exists()).toBe(false);
    expect(wrapper.get('[data-action="disable-project"]').text()).toContain("停用");
  });

  it("loads every registration page before determining project history", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `R${index + 1}`, projectId: "P1" }));
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/events/E1/registrations?pageSize=100") return { rows: firstPage, total: 101, page: 1, pageSize: 100 };
      if (path === "/api/admin/events/E1/registrations?page=2&pageSize=100") return { rows: [{ id: "R101", projectId: "P1" }], total: 101, page: 2, pageSize: 100 };
      return { row: event };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper);
    await wrapper.get('[data-section="projects"]').trigger("click");

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/registrations?page=2&pageSize=100");
    expect(wrapper.find('[data-action="delete-project"]').exists()).toBe(false);
    expect(wrapper.get('[data-action="disable-project"]').text()).toContain("停用");
  });

  it("shows an incomplete-data error and preserves existing project history when pagination fails", async () => {
    let registrationRequests = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/events/E1/registrations?pageSize=100") {
        registrationRequests += 1;
        return registrationRequests === 1
          ? { rows: [{ id: "R1", projectId: "P1" }], total: 1, page: 1, pageSize: 100 }
          : { rows: [], page: 1, pageSize: 100 };
      }
      return { row: event };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper);
    await wrapper.get('[data-section="projects"]').trigger("click");
    expect(wrapper.find('[data-action="delete-project"]').exists()).toBe(false);

    await wrapper.get('[data-section="event"]').trigger("click");
    await wrapper.get('[data-mode="force_closed"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-section="projects"]').trigger("click");

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
      if (path === "/api/admin/events/E1/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      return { row: event };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();

    const createButton = wrapper.get('[data-action="start-create-event"]');
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

  it("uses matching module headers and opens a blank project form from the top shortcut", async () => {
    mockLoads();
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper);

    expect(wrapper.get('[data-section-panel="event"] .management-context-card').text()).toContain("赛事信息");
    expect(wrapper.get('[data-action="back-to-events"]').text()).toContain("返回赛事列表");

    await wrapper.get('[data-section="projects"]').trigger("click");
    await wrapper.get('[data-action="edit-project"]').trigger("click");
    expect(wrapper.get("form.project-form").findAll("input")[0].element.value).toBe("纸飞机");

    await wrapper.get('[data-action="start-create-project"]').trigger("click");
    expect(wrapper.get('[data-section-panel="projects"] .management-context-card').text()).toContain("赛项与组别");
    expect(wrapper.get("form.project-form").findAll("input")[0].element.value).toBe("");
    expect(wrapper.get("form.project-form button.primary").text()).toBe("保存赛项");
  });

  it("requires two confirmations before archiving an event", async () => {
    mockLoads();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper);

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
      if (path === "/api/admin/events/E-OLD/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      if (path === "/api/admin/events/E-OLD/storage") return { certificateFiles: 1, importFiles: 0, totalBytes: 100 };
      return { row: archived };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper, "E-OLD");

    expect(wrapper.get('[data-action="open-cleanup"]').exists()).toBe(true);
    expect(wrapper.get('[data-action="open-delete"]').exists()).toBe(true);
  });

  it("keeps archived event details and projects read-only", async () => {
    const archived = { ...event, id: "E-OLD", name: "2025赛事", status: "archived", isCurrent: false, archivedAt: "2025-12-31T00:00:00.000Z" };
    const archivedProject = { ...project, id: "P-OLD", eventId: archived.id };
    const archivedProjectWithoutHistory = { ...project, id: "P-EMPTY", eventId: archived.id, name: "无报名赛项" };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [archived], projects: [archivedProject, archivedProjectWithoutHistory] };
      if (path === "/api/admin/events/E-OLD/registrations?pageSize=100") {
        return { rows: [{ id: "R-OLD", projectId: archivedProject.id }], total: 1, page: 1, pageSize: 100 };
      }
      if (path === "/api/admin/events/E-OLD/storage") return { certificateFiles: 0, importFiles: 0, totalBytes: 0 };
      return { row: archived };
    });
    const wrapper = mount(EventManagementPage);
    await flushPromises();
    await openEventDetails(wrapper, "E-OLD");

    expect(wrapper.get('[data-readonly-event]').text()).toContain("已归档，只可查看");
    expect(wrapper.get("form.event-form").findAll("input").every((input) => input.attributes("disabled") !== undefined)).toBe(true);
    expect(wrapper.get("form.event-form").get("button.primary").attributes("disabled")).not.toBeUndefined();
    expect(wrapper.findAll("[data-mode]").every((button) => button.attributes("disabled") !== undefined)).toBe(true);

    await wrapper.get('[data-section="projects"]').trigger("click");
    expect(wrapper.get('[data-readonly-projects]').text()).toContain("已归档，只可查看");
    expect(wrapper.get('[data-action="edit-project"]').attributes("disabled")).not.toBeUndefined();
    expect(wrapper.get('[data-action="disable-project"]').attributes("disabled")).not.toBeUndefined();
    expect(wrapper.get('[data-action="delete-project"]').attributes("disabled")).not.toBeUndefined();
    expect(wrapper.get("form.project-form").findAll("input").every((input) => input.attributes("disabled") !== undefined)).toBe(true);
    expect(wrapper.get("form.project-form").get("button.primary").attributes("disabled")).not.toBeUndefined();
  });
});
