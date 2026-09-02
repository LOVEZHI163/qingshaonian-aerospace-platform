import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", async (importOriginal) => ({ ...await importOriginal(), api: apiMock }));
vi.mock("../../components/SubmissionAssetUploader.vue", () => ({
  default: {
    props: ["sessionId", "mode", "assets"],
    emits: ["complete"],
    template: '<button type="button" data-testid="submission-uploader" @click="$emit(\'complete\', true)">素材已完成</button>'
  }
}));

import RegistrationPage from "../RegistrationPage.vue";
import RegistrationRecordsPage from "../RegistrationRecordsPage.vue";

function context() {
  return {
    event: { id: "E2", name: "第二场公开赛事" },
    organizations: [{ id: "O1", name: "实验小学" }],
    defaultOrganizationId: "O1",
    eligibility: { eligible: true, code: "OK", organization: { id: "O1", name: "实验小学" } },
    grades: [{ id: "primary_lower", name: "小学低段", grades: ["一年级", "二年级", "三年级"] }],
    projects: [{
      id: "P-E2",
      eventId: "E2",
      name: "第二场纸飞机",
      type: "individual",
      allowedGroups: ["小学低段"],
      submissionMode: "none"
    }, {
      id: "P-IMAGE",
      eventId: "E2",
      name: "第二场绘画",
      type: "individual",
      allowedGroups: ["小学低段"],
      submissionMode: "image_video"
    }]
  };
}

describe("RegistrationPage selected event context", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registration-context?eventId=E2") return context();
      if (path.startsWith("/api/schools")) return { rows: [] };
      if (path === "/api/me/events/E2/registrations") return { row: { id: "R2", eventId: "E2" } };
      throw new Error(`unexpected API path ${path}`);
    });
  });

  it("renders ordinary-user registration fields as visible form controls", async () => {
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" }, attachTo: document.body });
    await flushPromises();

    const nameInput = wrapper.get("form.form-panel input");
    expect(nameInput.isVisible()).toBe(true);

    wrapper.unmount();
  });

  it("uses one event id for context and ordinary-user submission", async () => {
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/me/registration-context?eventId=E2");
    expect(wrapper.text()).toContain("第二场公开赛事");

    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("实验小学");
    await inputs[2].setValue("二年级");
    await inputs[3].setValue("13600005001");
    await wrapper.get('[data-field="student-id-number"]').setValue("11010520140101123x");
    await flushPromises();

    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();
    const createCall = apiMock.mock.calls.find(([path]) => path === "/api/me/events/E2/registrations");
    const body = JSON.parse(createCall[1].body);
    expect(body).toMatchObject({ projectId: "P-E2", studentIdNumber: "11010520140101123x" });
    expect(body.athlete.studentIdNumber).toBeUndefined();
    expect(body.uploadSessionId).toBeUndefined();
    expect(apiMock.mock.calls.some(([path]) => path.includes("/upload-sessions"))).toBe(false);
  });

  it("creates an upload session for image-video projects and submits it only after both materials complete", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registration-context?eventId=E2") return context();
      if (path.startsWith("/api/schools")) return { rows: [] };
      if (path === "/api/me/events/E2/projects/P-IMAGE/upload-sessions") return { row: { id: "US1", assets: {} } };
      if (path === "/api/me/events/E2/registrations") return { row: { id: "R2", eventId: "E2" } };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" } });
    await flushPromises();

    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("实验小学");
    await inputs[2].setValue("二年级");
    await inputs[3].setValue("13600005001");
    await wrapper.get('[data-field="student-id-number"]').setValue("11010520140101123X");
    await wrapper.get("select").setValue("P-IMAGE");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/me/events/E2/projects/P-IMAGE/upload-sessions", { method: "POST" });
    expect(wrapper.get("button.primary").attributes("disabled")).toBeDefined();

    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();

    const createCall = apiMock.mock.calls.find(([path]) => path === "/api/me/events/E2/registrations");
    expect(JSON.parse(createCall[1].body)).toMatchObject({ projectId: "P-IMAGE", uploadSessionId: "US1" });
  });

  it("requires a valid student identity and shows the approved purpose before submission", async () => {
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" } });
    await flushPromises();

    const identity = wrapper.get('[data-field="student-id-number"]');
    expect(identity.attributes("required")).toBeDefined();
    expect(identity.attributes("minlength")).toBe("18");
    expect(identity.attributes("maxlength")).toBe("18");
    expect(identity.attributes("pattern")).toBe("[0-9]{17}[0-9Xx]");
    expect(identity.attributes("placeholder")).toBe("18 位居民身份证号，末位可为 X");
    expect(wrapper.text()).toContain("学生身份证号是报名资料，将用于名单导出和证书信息核对，请本人或监护人确认填写正确。");

    await identity.setValue("11010520140101123A");
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();
    expect(apiMock.mock.calls.some(([path]) => path === "/api/me/events/E2/registrations")).toBe(false);
    expect(wrapper.emitted("error")?.at(-1)).toEqual(["请输入 18 位居民身份证号，末位可为 X"]);
  });

  it("shows the authorized full identity and labels a historical empty identity without requesting another scope", async () => {
    apiMock.mockResolvedValueOnce({ rows: [
      { id: "R1", eventId: "E2", athlete: { name: "张三", school: "实验小学", grade: "二年级" }, studentIdNumber: "11010520140101123X" },
      { id: "R0", eventId: "E1", athlete: { name: "历史学生", school: "实验小学", grade: "一年级" }, studentIdNumber: null }
    ] });
    const wrapper = mount(RegistrationRecordsPage);
    await flushPromises();

    expect(wrapper.findAll("thead th").map((cell) => cell.text())).toContain("学生身份证号");
    expect(wrapper.text()).toContain("11010520140101123X");
    expect(wrapper.text()).toContain("—（历史报名）");
    expect(wrapper.text()).not.toContain("待补录");
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith("/api/me/registrations");
  });

  it("discards a stale material session when the project changes without clearing athlete fields", async () => {
    let resolveImageSession;
    const imageSession = new Promise((resolve) => { resolveImageSession = resolve; });
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registration-context?eventId=E2") return context();
      if (path.startsWith("/api/schools")) return { rows: [] };
      if (path === "/api/me/events/E2/projects/P-IMAGE/upload-sessions") return imageSession;
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" } });
    await flushPromises();
    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("实验小学");
    await inputs[2].setValue("二年级");
    await inputs[3].setValue("13600005001");
    await wrapper.get("select").setValue("P-IMAGE");
    await flushPromises();
    await wrapper.get("select").setValue("P-E2");
    resolveImageSession({ row: { id: "US-STALE", assets: {} } });
    await flushPromises();

    expect(wrapper.find('[data-testid="submission-uploader"]').exists()).toBe(false);
    expect(inputs[0].element.value).toBe("张三");
    expect(inputs[1].element.value).toBe("实验小学");
    expect(inputs[2].element.value).toBe("二年级");
    expect(inputs[3].element.value).toBe("13600005001");
  });

  it("rejects an empty event context instead of using fallback projects", async () => {
    const wrapper = mount(RegistrationPage, {
      props: { accountType: "ordinary", fallbackContext: { projects: [{ id: "P-OTHER", name: "其他赛事项目" }] } }
    });
    await flushPromises();

    expect(wrapper.text()).toContain("请先选择赛事");
    expect(wrapper.text()).not.toContain("其他赛事项目");
    expect(apiMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing organization", null],
    ["empty organization", {}],
    ["blank organization id", { id: "", name: "Invalid organization" }]
  ])("fails closed when eligibility is true with %s", async (_label, organization) => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registration-context?eventId=E2") {
        return { ...context(), organizations: [], eligibility: { eligible: true, code: "OK", organization } };
      }
      if (path.startsWith("/api/schools")) return { rows: [] };
      throw new Error(`unexpected API path ${path}`);
    });

    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" } });
    await flushPromises();

    expect(wrapper.find('[data-testid="registration-eligibility-guidance"]').exists()).toBe(true);
    expect(wrapper.find("form.form-panel").exists()).toBe(false);
  });

  it("never falls back to the legacy registration endpoint for a non-ordinary account", async () => {
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "organization" } });
    await flushPromises();

    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("实验小学");
    await inputs[2].setValue("二年级");
    await inputs[3].setValue("13600005002");
    await flushPromises();
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();

    expect(apiMock.mock.calls.some(([path]) => path === "/api/registrations")).toBe(false);
  });

  it("includes the verified identity in legacy duplicate checks", async () => {
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "organization" } });
    await flushPromises();

    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("实验小学");
    await inputs[2].setValue("二年级");
    await inputs[3].setValue("13600005002");
    await wrapper.get('[data-field="student-id-number"]').setValue("11010520140101123x");
    await flushPromises();

    const duplicateCall = apiMock.mock.calls.find(([path]) => path === "/api/registrations/check");
    expect(duplicateCall).toBeDefined();
    expect(JSON.parse(duplicateCall[1].body)).toMatchObject({
      eventId: "E2",
      projectId: "P-E2",
      studentIdNumber: "11010520140101123x"
    });
  });
});
