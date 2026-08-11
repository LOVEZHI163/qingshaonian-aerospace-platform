import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock, session } = vi.hoisted(() => {
  const { ref } = require("vue");
  return {
    apiMock: vi.fn(),
    apiBlobMock: vi.fn(),
    session: { user: ref({ id: "U1", type: "ordinary" }), organizations: ref([]) }
  };
});

vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, apiUrl: (path) => path }));
vi.mock("../../components/SubmissionAssetUploader.vue", () => ({
  default: {
    props: ["sessionId", "mode", "assets"],
    emits: ["complete"],
    template: '<button type="button" data-testid="submission-uploader" @click="$emit(\'complete\', true)">素材已完成</button>'
  }
}));
vi.mock("../../state/session.js", () => ({ useSession: () => session }));

import MyCertificatesPage from "../MyCertificatesPage.vue";
import RegistrationPage from "../RegistrationPage.vue";
import RegistrationRecordsPage from "../RegistrationRecordsPage.vue";

const context = {
  event: { id: "E2", name: "第二场公开赛事" },
  organizations: [{ id: "O1", name: "实验小学" }],
  defaultOrganizationId: "O1",
  eligibility: { eligible: true, code: "OK", organization: { id: "O1", name: "实验小学" } },
  grades: [{ id: "primary", name: "小学低段", grades: ["二年级"] }],
  projects: [{ id: "P2", eventId: "E2", name: "纸飞机", type: "individual", allowedGroups: ["小学低段"] }]
};

describe("ordinary user event workflow", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    session.user.value = { id: "U1", type: "ordinary" };
    session.organizations.value = [];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registration-context?eventId=E2") return context;
      if (path.startsWith("/api/schools")) return { rows: [] };
      if (path === "/api/me/events/E2/registrations") return { rows: [] };
      if (path === "/api/me/events/E2/certificates") return { rows: [] };
      if (path === "/api/me/events/E2/registrations" ) return { row: { id: "R2" } };
      throw new Error(`unexpected API path ${path}`);
    });
  });

  it("submits a personal registration through the selected event endpoint", async () => {
    const wrapper = mount(RegistrationPage, {
      props: { eventId: "E2", accountType: "ordinary", eventOrganizations: [{ organization: context.organizations[0], organizationJoined: true }] }
    });
    await flushPromises();
    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("实验小学");
    await inputs[2].setValue("二年级");
    await inputs[3].setValue("13600005001");
    await wrapper.get('[data-field="student-id-number"]').setValue("11010520140101123X");
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith(
      "/api/me/events/E2/registrations",
      expect.objectContaining({ method: "POST" })
    );
    const createCall = apiMock.mock.calls.find(([path, options]) => path === "/api/me/events/E2/registrations" && options?.method === "POST");
    expect(JSON.parse(createCall[1].body).organizationId).toBe("O1");
  });

  it("shows the one eligible organization read-only while leaving school editable", async () => {
    const wrapper = mount(RegistrationPage, {
      props: { eventId: "E2", accountType: "ordinary" }
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="eligible-organization"]').text()).toContain("实验小学");
    expect(wrapper.find('[data-field="organization-select"]').exists()).toBe(false);
    const school = wrapper.get('[data-field="registration-school"] input');
    expect(school.element.value).toBe("实验小学");
    await school.setValue("实验小学分校");
    expect(school.element.value).toBe("实验小学分校");
  });

  it("blocks the form and guides an ineligible ordinary user to My Organization", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registration-context?eventId=E2") return {
        ...context,
        organizations: [],
        defaultOrganizationId: "",
        eligibility: { eligible: false, code: "ACTIVE_ORGANIZATION_REQUIRED", organization: null }
      };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" } });
    await flushPromises();

    expect(wrapper.text()).toContain("请先加入组织");
    expect(wrapper.text()).toContain("请先加入已通过审核的组织后再报名");
    expect(wrapper.find("form").exists()).toBe(false);
    await wrapper.get('[data-action="open-my-organization"]').trigger("click");
    expect(wrapper.emitted("navigate")).toEqual([["myOrganization"]]);
  });

  it("keeps event details visible but disables new registration when the organization has no approved leader", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registration-context?eventId=E2") return {
        ...context,
        eligibility: {
          eligible: false,
          code: "ORGANIZATION_LEADER_REQUIRED",
          organization: context.organizations[0]
        }
      };
      if (path.startsWith("/api/schools")) return { rows: [] };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" } });
    await flushPromises();

    const guidance = wrapper.get('[data-testid="registration-eligibility-guidance"]');
    expect(guidance.attributes("role")).toBe("alert");
    expect(guidance.text()).toContain("所属组织尚未完成领队申报");
    expect(guidance.text()).toContain("请联系组织负责人进入“领队管理”");
    expect(guidance.text()).toContain("提交领队资料和授权书");
    expect(guidance.text()).toContain("无需退出组织或重新申请加入");
    expect(wrapper.text()).toContain("第二场公开赛事");
    expect(wrapper.text()).toContain("目前没有审核通过且已启用的领队");
    expect(wrapper.find("form").exists()).toBe(true);
    expect(wrapper.get("form button.primary").attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-action="open-my-organization"]').exists()).toBe(false);
  });

  it("translates a stable eligibility error returned while submitting", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/registration-context?eventId=E2") return context;
      if (path.startsWith("/api/schools")) return { rows: [] };
      if (path === "/api/me/events/E2/registrations" && options?.method === "POST") {
        throw Object.assign(new Error("raw eligibility wording"), { code: "ACTIVE_ORGANIZATION_REQUIRED" });
      }
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
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();

    expect(wrapper.emitted("error")).toEqual([["请先加入已通过审核的组织后再报名"]]);
    const feedback = wrapper.get('[data-testid="ordinary-registration-feedback"]');
    expect(feedback.attributes("role")).toBe("alert");
    expect(feedback.text()).toContain("请先加入已通过审核的组织后再报名");
  });

  it("explains that an invalid identity number does not meet the national standard", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/registration-context?eventId=E2") return context;
      if (path.startsWith("/api/schools")) return { rows: [] };
      if (path === "/api/me/events/E2/registrations" && options?.method === "POST") {
        throw Object.assign(new Error("身份证号校验失败"), { code: "INVALID_STUDENT_ID_NUMBER" });
      }
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2", accountType: "ordinary" } });
    await flushPromises();
    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("实验小学");
    await inputs[2].setValue("二年级");
    await inputs[3].setValue("13600005001");
    await wrapper.get('[data-field="student-id-number"]').setValue("330304198811232711");
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-testid="ordinary-registration-feedback"]').text()).toContain("输入的身份证号码不符合国家标准，请检查后重新填写");
    expect(wrapper.emitted("error")?.at(-1)).toEqual(["输入的身份证号码不符合国家标准，请检查后重新填写"]);
  });

  it("translates a leader loss returned by the locked submission check", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/registration-context?eventId=E2") return context;
      if (path.startsWith("/api/schools")) return { rows: [] };
      if (path === "/api/me/events/E2/registrations" && options?.method === "POST") {
        throw Object.assign(new Error("stale leader state"), { code: "ORGANIZATION_LEADER_REQUIRED" });
      }
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
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();

    expect(wrapper.emitted("error")?.at(-1)).toEqual(["所属组织尚无审核通过且已启用的领队，请联系组织负责人"]);
  });

  it("loads records and certificates from E2 without falling back to an implicit event", async () => {
    const records = mount(RegistrationRecordsPage, { props: { eventId: "E2" } });
    const certificates = mount(MyCertificatesPage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/me/events/E2/registrations");
    expect(apiMock).toHaveBeenCalledWith("/api/me/events/E2/certificates");
    expect(apiMock.mock.calls.some(([path]) => path === "/api/me/registrations" || path === "/api/me/certificates")).toBe(false);
    records.unmount();
    certificates.unmount();
  });

  it("loads all registration and certificate history without requiring an event selection", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registrations") return { rows: [
        { id: "R1", eventId: "E1", eventName: "本届赛事", athlete: { name: "张三" }, projectName: "纸飞机", status: "approved" },
        { id: "R2", eventId: "E-ARCHIVED", eventName: "往届赛事", athlete: { name: "张三" }, projectName: "航空绘画", status: "approved" }
      ] };
      if (path === "/api/me/certificates") return { rows: [
        { id: "C1", eventId: "E-ARCHIVED", eventName: "往届赛事", title: "一等奖", status: "published", athlete: { name: "张三" } }
      ] };
      throw new Error(`unexpected API path ${path}`);
    });

    const records = mount(RegistrationRecordsPage);
    const certificates = mount(MyCertificatesPage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/me/registrations");
    expect(apiMock).toHaveBeenCalledWith("/api/me/certificates");
    expect(records.text()).toContain("本届赛事");
    expect(records.text()).toContain("往届赛事");
    expect(certificates.text()).toContain("往届赛事");
    expect(certificates.text()).toContain("一等奖");
    records.unmount();
    certificates.unmount();
  });

  it("filters all-event registration and certificate history by event", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registrations") return { rows: [
        { id: "R1", eventId: "E1", eventName: "本届赛事", athlete: { name: "本届选手" }, projectName: "纸飞机", status: "approved" },
        { id: "R2", eventId: "E2", eventName: "往届赛事", athlete: { name: "往届选手" }, projectName: "航空绘画", status: "approved" }
      ] };
      if (path === "/api/me/certificates") return { rows: [
        { id: "C1", eventId: "E1", eventName: "本届赛事", title: "本届证书", status: "published" },
        { id: "C2", eventId: "E2", eventName: "往届赛事", title: "往届证书", status: "published" }
      ] };
      throw new Error(`unexpected API path ${path}`);
    });
    const records = mount(RegistrationRecordsPage);
    const certificates = mount(MyCertificatesPage);
    await flushPromises();

    await records.get('[data-field="registration-history-event"]').setValue("E2");
    await certificates.get('[data-field="certificate-history-event"]').setValue("E2");
    expect(records.text()).toContain("往届选手");
    expect(records.text()).not.toContain("本届选手");
    expect(certificates.text()).toContain("往届证书");
    expect(certificates.text()).not.toContain("本届证书");
    records.unmount();
    certificates.unmount();
  });

  it("shows private material availability and replacement only for pending or rejected registrations", async () => {
    const assetRows = [
      {
        id: "R-PENDING", status: "pending", athlete: { name: "张三", school: "实验小学", grade: "二年级" }, projectId: "P2", projectName: "纸飞机",
        submission: { required: true, complete: true, assets: { artwork_image: { kind: "artwork_image", originalName: "work.png" }, creation_video: { kind: "creation_video", originalName: "making.mp4" } } }
      },
      {
        id: "R-APPROVED", status: "approved", athlete: { name: "李四", school: "实验小学", grade: "二年级" }, projectId: "P2", projectName: "纸飞机",
        submission: { required: true, complete: true, assets: { artwork_image: { kind: "artwork_image", originalName: "approved.png" }, creation_video: { kind: "creation_video", originalName: "approved.mp4" } } }
      },
      {
        id: "R-REJECTED", status: "rejected", athlete: { name: "王五", school: "实验小学", grade: "二年级" }, projectId: "P2", projectName: "纸飞机",
        submission: { required: true, complete: true, assets: { artwork_image: { kind: "artwork_image", originalName: "rejected.png" }, creation_video: { kind: "creation_video", originalName: "rejected.mp4" } } }
      }
    ];
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/events/E2/registrations" && !options?.method) return { rows: assetRows };
      if (path === "/api/me/events/E2/projects/P2/upload-sessions") return { row: { id: "US-PERSONAL", assets: {} } };
      if (path.includes("/assets/artwork_image") || path.includes("/assets/creation_video")) return { registration: { ...assetRows[0], status: "pending" } };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(RegistrationRecordsPage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(wrapper.text()).toContain("作品图片可用");
    expect(wrapper.find('[data-action="replace-personal-materials-R-PENDING"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="replace-personal-materials-R-REJECTED"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="replace-personal-materials-R-APPROVED"]').exists()).toBe(false);
    await wrapper.get('[data-action="replace-personal-materials-R-PENDING"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/me/events/E2/projects/P2/upload-sessions", { method: "POST" });
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-personal-material-replacement-R-PENDING"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/me/events/E2/registrations/R-PENDING/assets/artwork_image", expect.objectContaining({ method: "PUT", body: JSON.stringify({ uploadSessionId: "US-PERSONAL" }) }));
  });

  it("resumes a personal material replacement with only the video after its first request fails", async () => {
    const row = {
      id: "R-RESUME", status: "pending", athlete: { name: "张三", school: "实验小学", grade: "二年级" }, projectId: "P2", projectName: "纸飞机",
      submission: { required: true, complete: true, assets: { artwork_image: { kind: "artwork_image", originalName: "work.png" }, creation_video: { kind: "creation_video", originalName: "making.mp4" } } }
    };
    let videoAttempts = 0;
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/events/E2/registrations" && !options?.method) return { rows: [row] };
      if (path === "/api/me/events/E2/projects/P2/upload-sessions") return { row: { id: "US-RESUME", assets: {} } };
      if (path.endsWith("/assets/artwork_image")) return { registration: row };
      if (path.endsWith("/assets/creation_video")) {
        videoAttempts += 1;
        if (videoAttempts === 1) throw new Error("video replacement failed");
        return { registration: row };
      }
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(RegistrationRecordsPage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-action="replace-personal-materials-R-RESUME"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-personal-material-replacement-R-RESUME"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("作品图片已替换，作画视频仍待替换");
    expect(apiMock.mock.calls.filter(([path, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/me/events/E2/registrations/R-RESUME/assets/artwork_image",
      "/api/me/events/E2/registrations/R-RESUME/assets/creation_video"
    ]);

    await wrapper.get('[data-action="retry-personal-material-replacement-R-RESUME"]').trigger("click");
    await flushPromises();

    expect(apiMock.mock.calls.filter(([path, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/me/events/E2/registrations/R-RESUME/assets/artwork_image",
      "/api/me/events/E2/registrations/R-RESUME/assets/creation_video",
      "/api/me/events/E2/registrations/R-RESUME/assets/creation_video"
    ]);
    expect(wrapper.text()).toContain("作品材料已替换");
  });

  it("ignores a cancelled personal replacement after its first material request resolves late", async () => {
    const row = {
      id: "R-CANCEL", status: "pending", athlete: { name: "张三", school: "实验小学", grade: "二年级" }, projectId: "P2", projectName: "纸飞机",
      submission: { required: true, complete: true, assets: { artwork_image: { kind: "artwork_image", originalName: "work.png" }, creation_video: { kind: "creation_video", originalName: "making.mp4" } } }
    };
    let resolveImage;
    const delayedImage = new Promise((resolve) => { resolveImage = resolve; });
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/events/E2/registrations" && !options?.method) return { rows: [row] };
      if (path === "/api/me/events/E2/projects/P2/upload-sessions") return { row: { id: "US-CANCEL", assets: {} } };
      if (path.endsWith("/assets/artwork_image")) return delayedImage;
      if (path.endsWith("/assets/creation_video")) return { registration: row };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(RegistrationRecordsPage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-action="replace-personal-materials-R-CANCEL"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-personal-material-replacement-R-CANCEL"]').trigger("click");

    const cancel = wrapper.findAll(".personal-material-replacement button").find((button) => button.text() === "取消替换");
    await cancel.trigger("click");
    resolveImage({ registration: row });
    await flushPromises();

    expect(wrapper.find(".personal-material-replacement").exists()).toBe(false);
    expect(apiMock.mock.calls.filter(([path, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/me/events/E2/registrations/R-CANCEL/assets/artwork_image"
    ]);
    expect(wrapper.text()).not.toContain("作品图片已替换");
    expect(wrapper.text()).not.toContain("作品材料已替换");
  });

  it("loads a historical certificate automatically without an active event", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/certificates") return { rows: [{ id: "C1", eventId: "E-ARCHIVED", eventName: "往届赛事", title: "历史证书" }] };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(MyCertificatesPage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/me/certificates");
    expect(wrapper.text()).toContain("往届赛事");
    expect(wrapper.text()).toContain("历史证书");
  });
});
