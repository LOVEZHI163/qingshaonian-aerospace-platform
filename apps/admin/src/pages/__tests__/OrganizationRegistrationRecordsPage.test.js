import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock, apiUrlMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  apiBlobMock: vi.fn(),
  apiUrlMock: vi.fn((path) => `https://api.example${path}`)
}));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, apiUrl: apiUrlMock }));
vi.mock("../../components/SubmissionAssetUploader.vue", () => ({
  default: {
    props: ["sessionId", "mode", "assets"],
    emits: ["complete"],
    template: '<button type="button" data-testid="submission-uploader" @click="$emit(\'complete\', true)">素材已完成</button>'
  }
}));
vi.mock("../../components/OrganizationAthleteRegistrationForm.vue", () => ({
  default: {
    props: ["eventId", "projects", "grades", "defaultSchool", "registration"],
    emits: ["registered"],
    template: '<div data-testid="organization-registration-editor" :data-event-id="eventId" :data-registration-id="registration.id"><button type="button" data-action="save-organization-registration" @click="$emit(\'registered\')">保存</button></div>'
  }
}));

import OrganizationRegistrationRecordsPage from "../OrganizationRegistrationRecordsPage.vue";

const payload = {
  rows: [
    {
      id: "R1", eventId: "E1", eventName: "春季航空赛", projectId: "P1", projectName: "纸飞机",
      athlete: { name: "张三", school: "实验小学", grade: "五年级" }, instructor: "林老师", status: "pending", score: "98", awardName: "一等奖",
      submission: { required: true, complete: true, assets: {
        artwork_image: { originalName: "作品.png", sizeBytes: 100 },
        creation_video: { originalName: "作画.mp4", sizeBytes: 200 }
      } }
    },
    {
      id: "R2", eventId: "E2", eventName: "夏季无人机赛", projectId: "P2", projectName: "无人机",
      athlete: { name: "李四", school: "航空学校", grade: "六年级" }, instructor: "", status: "pending", score: "", awardName: ""
    }
  ],
  total: 27,
  page: 1,
  pageSize: 25,
  refreshedAt: "2026-08-04T00:00:00.000Z",
  filterOptions: {
    events: [{ id: "E1", name: "春季航空赛" }, { id: "E2", name: "夏季无人机赛" }],
    projects: [{ id: "P1", name: "纸飞机" }, { id: "P2", name: "无人机" }]
  }
};

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

describe("OrganizationRegistrationRecordsPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiUrlMock.mockClear();
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
  });

  it("loads cross-event records and sends encoded filters with pagination", async () => {
    apiMock.mockResolvedValue(payload);
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/registrations?page=1&pageSize=25");
    expect(wrapper.text()).toContain("春季航空赛");
    expect(wrapper.text()).toContain("张三");
    expect(wrapper.text()).toContain("成绩 98");
    expect(wrapper.text()).toContain("一等奖");

    await wrapper.get('[data-filter="organization-records-q"]').setValue("张 三");
    await wrapper.get('[data-filter="organization-records-event"]').setValue("E2");
    await wrapper.get('[data-filter="organization-records-project"]').setValue("P2");
    await wrapper.get('[data-filter="organization-records-status"]').setValue("approved");
    await flushPromises();

    expect(apiMock).toHaveBeenLastCalledWith("/api/organization/registrations?q=%E5%BC%A0+%E4%B8%89&eventId=E2&projectId=P2&status=approved&page=1&pageSize=25");
    expect(wrapper.get('[data-action="organization-records-next"]').attributes("disabled")).toBeUndefined();
  });

  it("shows an empty state when the organization has no matching registrations", async () => {
    apiMock.mockResolvedValue({ ...payload, rows: [], total: 0 });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.get(".empty-state").text()).toContain("暂无报名记录");
    expect(wrapper.get('[data-action="organization-records-previous"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-action="organization-records-next"]').attributes("disabled")).toBeDefined();
  });

  it("shows the instructor column with a dash for an empty instructor", async () => {
    apiMock.mockResolvedValue(payload);
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.findAll("thead th").map((cell) => cell.text())).toContain("指导老师");
    const rows = wrapper.findAll("tbody tr");
    expect(rows[0].text()).toContain("林老师");
    expect(rows[1].text()).toContain("-");
  });

  it("shows Chinese source labels for member and organization proxy registrations", async () => {
    apiMock.mockResolvedValue({
      ...payload,
      rows: payload.rows.map((row, index) => ({
        ...row,
        source: index === 0 ? "member_registration" : "organization_proxy"
      }))
    });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.findAll("thead th").map((cell) => cell.text())).toContain("报名来源");
    expect(wrapper.findAll("tbody tr")[0].text()).toContain("成员报名");
    expect(wrapper.findAll("tbody tr")[1].text()).toContain("组织代报名");
  });

  it("allows a non-archived approved submission to enter the replacement flow", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/registrations?page=1&pageSize=25") {
        return { ...payload, rows: [{ ...payload.rows[0], status: "approved" }] };
      }
      if (path === "/api/organization/events/E1/projects/P1/upload-sessions") return { row: { id: "US-APPROVED", assets: {} } };
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.find('[data-action="replace-organization-materials-R1"]').exists()).toBe(true);
    await wrapper.get('[data-action="replace-organization-materials-R1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E1/projects/P1/upload-sessions", { method: "POST" });
  });

  it("shows a safe loading error and retries without rendering server HTML", async () => {
    apiMock.mockRejectedValueOnce(new Error("<!DOCTYPE html><html>gateway failure</html>"));
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("报名记录加载失败，请重试");
    expect(wrapper.text()).not.toContain("<!DOCTYPE html>");

    apiMock.mockResolvedValueOnce(payload);
    await wrapper.get('[data-action="retry-organization-records"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("张三");
  });

  it("uses each row's organization event for material preview, download, and replacement", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/registrations?page=1&pageSize=25") return payload;
      if (path === "/api/organization/events/E1/projects/P1/upload-sessions" && options?.method === "POST") return { row: { id: "US1", assets: {} } };
      if (path === "/api/organization/events/E1/registrations/R1/assets/artwork_image" && options?.method === "PUT") return { registration: payload.rows[0] };
      if (path === "/api/organization/events/E1/registrations/R1/assets/creation_video" && options?.method === "PUT") return { registration: payload.rows[0] };
      throw new Error(`unexpected ${path}`);
    });
    apiBlobMock.mockResolvedValue(new Blob(["image"]));
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.get('[data-asset-kind="artwork_image"] img').attributes("src")).toBe("https://api.example/api/organization/events/E1/registrations/R1/assets/artwork_image");
    expect(wrapper.get('[data-asset-kind="creation_video"] video').attributes("src")).toBe("https://api.example/api/organization/events/E1/registrations/R1/assets/creation_video");
    await wrapper.get('[data-action="download-organization-artwork_image-R1"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/organization/events/E1/registrations/R1/assets/artwork_image");

    await wrapper.get('[data-action="replace-organization-materials-R1"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-organization-material-replacement-R1"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E1/projects/P1/upload-sessions", { method: "POST" });
    expect(apiMock.mock.calls.filter(([, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/organization/events/E1/registrations/R1/assets/artwork_image",
      "/api/organization/events/E1/registrations/R1/assets/creation_video"
    ]);
    expect(apiMock.mock.calls.flat()).not.toContain(expect.stringMatching(/\/api\/me\/events/));
  });

  it("shows a safe material download error and retries the same row asset", async () => {
    apiMock.mockResolvedValue(payload);
    apiBlobMock.mockRejectedValueOnce(Object.assign(new Error("Cannot GET /asset"), { status: 403 }));
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    await wrapper.get('[data-action="download-organization-artwork_image-R1"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("无法下载作品材料，请返回报名记录后重试");
    expect(wrapper.text()).not.toContain("Cannot GET");
    apiBlobMock.mockResolvedValueOnce(new Blob(["image"]));
    await wrapper.get('[data-action="retry-organization-material-download"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenLastCalledWith("/api/organization/events/E1/registrations/R1/assets/artwork_image");
  });

  it("loads the row event workspace before editing and closes after saving a refreshed list", async () => {
    const workspace = {
      event: { id: "E1", name: "春季航空赛", status: "published" },
      organization: { id: "O1", name: "航空学校" },
      projects: [{ id: "P1", name: "纸飞机" }],
      grades: [{ id: "primary", grades: ["五年级"] }]
    };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/registrations?page=1&pageSize=25") return payload;
      if (path === "/api/organization/events/E1/workspace") return workspace;
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    await wrapper.get('[data-action="edit-organization-registration-R1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E1/workspace");
    expect(wrapper.get('[data-testid="organization-registration-editor"]').attributes("data-event-id")).toBe("E1");
    expect(wrapper.get('[data-testid="organization-registration-editor"]').attributes("data-registration-id")).toBe("R1");

    await wrapper.get('[data-action="save-organization-registration"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="organization-registration-editor"]').exists()).toBe(false);
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/organization/registrations?page=1&pageSize=25")).toHaveLength(2);
  });

  it.each([
    [Object.assign(new Error("Cannot GET /workspace"), { status: 403 }), "无法访问该赛事工作台，请返回报名记录后重试"],
    [Object.assign(new Error("not found"), { status: 404 }), "无法访问该赛事工作台，请返回报名记录后重试"],
    [new Error("<!DOCTYPE html><html>gateway</html>"), "赛事工作台加载失败，请重试"]
  ])("shows safe workspace error and retries it", async (workspaceError, message) => {
    const workspace = { event: { id: "E1", status: "published" }, organization: { name: "航空学校" }, projects: [], grades: [] };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/registrations?page=1&pageSize=25") return payload;
      if (path === "/api/organization/events/E1/workspace") throw workspaceError;
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();
    await wrapper.get('[data-action="edit-organization-registration-R1"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('.organization-registration-record-editor [role="alert"]').text()).toContain(message);
    expect(wrapper.text()).not.toContain("Cannot GET");
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/registrations?page=1&pageSize=25") return payload;
      if (path === "/api/organization/events/E1/workspace") return workspace;
      throw new Error(`unexpected ${path}`);
    });
    await wrapper.get('[data-action="retry-organization-edit-R1"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="organization-registration-editor"]').exists()).toBe(true);
  });

  it("sanitizes replacement failures and retries only the unfinished asset", async () => {
    let sessionAttempts = 0;
    let videoAttempts = 0;
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/registrations?page=1&pageSize=25") return payload;
      if (path === "/api/organization/events/E1/projects/P1/upload-sessions") {
        sessionAttempts += 1;
        if (sessionAttempts === 1) throw new Error("<html>upload proxy failure</html>");
        return { row: { id: "US1", assets: {} } };
      }
      if (path.endsWith("/assets/artwork_image") && options?.method === "PUT") return { registration: payload.rows[0] };
      if (path.endsWith("/assets/creation_video") && options?.method === "PUT") {
        videoAttempts += 1;
        if (videoAttempts === 1) throw new Error("Cannot GET /video");
        return { registration: payload.rows[0] };
      }
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();
    await wrapper.get('[data-action="replace-organization-materials-R1"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('.organization-registration-material-replacement [role="alert"]').text()).toContain("无法创建作品上传会话，请重试");
    expect(wrapper.text()).not.toContain("upload proxy failure");

    await wrapper.get('[data-action="retry-organization-material-replacement-R1"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-organization-material-replacement-R1"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('.organization-registration-material-replacement [role="alert"]').text()).toContain("作品材料替换失败，请重试");
    expect(wrapper.text()).not.toContain("Cannot GET");

    await wrapper.get('[data-action="retry-organization-material-replacement-R1"]').trigger("click");
    await flushPromises();
    expect(apiMock.mock.calls.filter(([, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/organization/events/E1/registrations/R1/assets/artwork_image",
      "/api/organization/events/E1/registrations/R1/assets/creation_video",
      "/api/organization/events/E1/registrations/R1/assets/creation_video"
    ]);
  });

  it.each([403, 404])("shows a safe Chinese replacement-session error for status %s", async (status) => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/registrations?page=1&pageSize=25") return payload;
      if (path === "/api/organization/events/E1/projects/P1/upload-sessions") throw Object.assign(new Error("permission denied"), { status });
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();
    await wrapper.get('[data-action="replace-organization-materials-R1"]').trigger("click");
    await flushPromises();

    const replacement = wrapper.get('.organization-registration-material-replacement [role="alert"]');
    expect(replacement.text()).toContain("无法创建作品上传会话，请返回报名记录后重试");
    expect(replacement.text()).not.toContain("permission denied");
    expect(wrapper.find('[data-action="retry-organization-material-replacement-R1"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="return-organization-records"]').exists()).toBe(true);
  });

  it("ignores a replacement session response after the action is cancelled", async () => {
    const session = deferred();
    apiMock.mockImplementation((path) => {
      if (path === "/api/organization/registrations?page=1&pageSize=25") return Promise.resolve(payload);
      if (path === "/api/organization/events/E1/projects/P1/upload-sessions") return session.promise;
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();
    await wrapper.get('[data-action="replace-organization-materials-R1"]').trigger("click");
    await wrapper.get('[data-action="return-organization-records"]').trigger("click");
    session.resolve({ row: { id: "OLD-SESSION", assets: {} } });
    await flushPromises();

    expect(wrapper.find('[data-testid="submission-uploader"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="confirm-organization-material-replacement-R1"]').exists()).toBe(false);
  });

  it("hides edit and replacement actions for archived events", async () => {
    apiMock.mockResolvedValue({
      ...payload,
      rows: [{ ...payload.rows[0], eventStatus: "archived" }]
    });
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.find('[data-action="edit-organization-registration-R1"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="replace-organization-materials-R1"]').exists()).toBe(false);
  });

  it.each([403, 404])("shows safe retry and return controls for status %s", async (status) => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("Cannot GET /private"), { status }));
    const wrapper = mount(OrganizationRegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("无法访问报名记录，请返回赛事工作台后重试");
    expect(wrapper.text()).not.toContain("Cannot GET");
    expect(wrapper.find('[data-action="retry-organization-records"]').exists()).toBe(true);
    await wrapper.get('[data-action="return-organization-workspace"]').trigger("click");
    expect(wrapper.emitted("back-to-events")).toEqual([[]]);
  });
});
