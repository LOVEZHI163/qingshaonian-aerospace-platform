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
  defaultOrganizationId: "",
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
    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith(
      "/api/me/events/E2/registrations",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("explains why an active member cannot associate an organization that has not joined", async () => {
    const wrapper = mount(RegistrationPage, {
      props: { eventId: "E2", accountType: "ordinary", eventOrganizations: [{ organization: context.organizations[0], organizationJoined: false }] }
    });
    await flushPromises();

    expect(wrapper.text()).toContain("该组织尚未加入本赛事");
    expect(wrapper.get('option[value="O1"]').attributes("disabled")).toBeDefined();
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

  it("queries a historical certificate event id without an active event", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/events/E-ARCHIVED/certificates") return { rows: [{ id: "C1", title: "历史证书" }] };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(MyCertificatesPage);
    await flushPromises();

    await wrapper.get('[data-field="certificate-event-id"]').setValue("E-ARCHIVED");
    await wrapper.get('[data-action="query-certificates"]').trigger("submit");
    expect(wrapper.emitted("event-id")?.[0]).toEqual(["E-ARCHIVED"]);
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/me/events/E-ARCHIVED/certificates");
  });
});
