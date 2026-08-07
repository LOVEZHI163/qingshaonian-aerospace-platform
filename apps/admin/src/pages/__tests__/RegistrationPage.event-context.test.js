import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));
vi.mock("../../components/SubmissionAssetUploader.vue", () => ({
  default: {
    props: ["sessionId", "mode", "assets"],
    emits: ["complete"],
    template: '<button type="button" data-testid="submission-uploader" @click="$emit(\'complete\', true)">素材已完成</button>'
  }
}));

import RegistrationPage from "../RegistrationPage.vue";

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
    await flushPromises();

    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();
    const createCall = apiMock.mock.calls.find(([path]) => path === "/api/me/events/E2/registrations");
    expect(JSON.parse(createCall[1].body)).toMatchObject({ projectId: "P-E2" });
    expect(JSON.parse(createCall[1].body).uploadSessionId).toBeUndefined();
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
});
