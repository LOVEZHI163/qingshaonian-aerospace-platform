import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, apiUrl: (path) => path }));
vi.mock("../../components/SubmissionAssetUploader.vue", () => ({
  default: {
    props: ["sessionId", "mode", "assets"],
    emits: ["complete"],
    template: '<button type="button" data-testid="submission-uploader" @click="$emit(\'complete\', true)">素材已完成</button>'
  }
}));

import EventCenterPage from "../EventCenterPage.vue";
import OrganizationAthleteRegistrationForm from "../../components/OrganizationAthleteRegistrationForm.vue";
import OrganizationEventWorkspacePage from "../OrganizationEventWorkspacePage.vue";

const event = { id: "E2", name: "赛事二", status: "published" };
const registration = {
  id: "R1", athlete: { name: "张三", school: "航空学校", grade: "五年级", phone: "13800000000" },
  projectId: "P1", projectName: "无人机", status: "approved", awardName: "一等奖", rank: "1", score: "95"
};

describe("OrganizationEventWorkspacePage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return {
        event,
        summary: { registrationCount: 1, pendingRegistrationCount: 0, certificateCount: 1 },
        projects: [{ id: "P1", name: "无人机" }],
        registrations: [registration]
      };
      if (path === "/api/organization/events/E2/registrations") return { rows: [registration] };
      if (path === "/api/organization/events/E2/certificates") return { rows: [] };
      return { rows: [] };
    });
  });

  it("loads the selected event workspace through its explicit event endpoint", async () => {
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/workspace");
    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations");
    expect(wrapper.text()).toContain("赛事二");
    await wrapper.get('[data-workspace-tab="records"]').trigger("click");
    expect(wrapper.text()).toContain("张三");
  });

  it("submits organization athletes only to the explicit event endpoint and reports a merge", async () => {
    apiMock.mockResolvedValueOnce({ merged: true, row: registration });
    const wrapper = mount(OrganizationAthleteRegistrationForm, {
      props: { eventId: "E2", projects: [{ id: "P1", name: "无人机" }] }
    });
    await wrapper.get('[data-field="athlete-name"]').setValue("张三");
    await wrapper.get('input[placeholder="输入或选择学校"]').setValue("航空学校");
    await wrapper.get('[data-field="athlete-grade"]').setValue("五年级");
    await wrapper.get('[data-field="athlete-phone"]').setValue("13800000000");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ athlete: { name: "张三", school: "航空学校", grade: "五年级", phone: "13800000000" }, projectId: "P1", instructor: "" })
    }));
    expect(wrapper.text()).toContain("已与现有个人报名合并，未重复创建");
    expect(wrapper.find("select[data-field=organization]").exists()).toBe(false);
  });

  it("creates organization-owned material sessions and includes the completed session without exposing an editable organization id", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/projects/P-IMAGE/upload-sessions") return { row: { id: "US-ORG", assets: {} } };
      if (path === "/api/organization/events/E2/registrations") return { row: registration };
      if (path.startsWith("/api/schools")) return { rows: [] };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(OrganizationAthleteRegistrationForm, {
      props: { eventId: "E2", projects: [{ id: "P-IMAGE", name: "绘画", submissionMode: "image_video" }] }
    });
    await flushPromises();
    await wrapper.get('[data-field="athlete-name"]').setValue("张三");
    await wrapper.get('input[placeholder="输入或选择学校"]').setValue("航空学校");
    await wrapper.get('[data-field="athlete-grade"]').setValue("五年级");
    await wrapper.get('[data-field="athlete-phone"]').setValue("13800000000");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/projects/P-IMAGE/upload-sessions", { method: "POST" });
    expect(wrapper.get("button.primary").attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-field="organization"]').exists()).toBe(false);

    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ athlete: { name: "张三", school: "航空学校", grade: "五年级", phone: "13800000000" }, projectId: "P-IMAGE", instructor: "", uploadSessionId: "US-ORG" })
    }));
  });

  it("allows the organization owner to replace approved materials and immediately reports the restored pending review", async () => {
    const withSubmission = {
      ...registration,
      submission: {
        required: true,
        complete: true,
        assets: {
          artwork_image: { kind: "artwork_image", originalName: "work.png", mimeType: "image/png", sizeBytes: 1024 },
          creation_video: { kind: "creation_video", originalName: "making.mp4", mimeType: "video/mp4", sizeBytes: 2048 }
        }
      }
    };
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return { event, summary: {}, projects: [{ id: "P1", name: "无人机", submissionMode: "image_video" }], registrations: [withSubmission] };
      if (path === "/api/organization/events/E2/registrations" && !options?.method) return { rows: [withSubmission] };
      if (path === "/api/organization/events/E2/projects/P1/upload-sessions") return { row: { id: "US-REPLACE", assets: {} } };
      if (path.includes("/assets/artwork_image") || path.includes("/assets/creation_video")) return { registration: { ...withSubmission, status: "pending" } };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-workspace-tab="records"]').trigger("click");
    await wrapper.get('[data-action="replace-organization-materials-R1"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-organization-material-replacement-R1"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations/R1/assets/artwork_image", expect.objectContaining({ method: "PUT", body: JSON.stringify({ uploadSessionId: "US-REPLACE" }) }));
    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations/R1/assets/creation_video", expect.objectContaining({ method: "PUT", body: JSON.stringify({ uploadSessionId: "US-REPLACE" }) }));
    expect(wrapper.text()).toContain("已恢复待审核");
  });

  it("resumes an organization material replacement from the failed video without replaying the consumed image", async () => {
    const withSubmission = {
      ...registration,
      submission: {
        required: true,
        complete: true,
        assets: {
          artwork_image: { kind: "artwork_image", originalName: "work.png", mimeType: "image/png", sizeBytes: 1024 },
          creation_video: { kind: "creation_video", originalName: "making.mp4", mimeType: "video/mp4", sizeBytes: 2048 }
        }
      }
    };
    let status = "approved";
    let videoAttempts = 0;
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return { event, summary: {}, projects: [{ id: "P1", name: "无人机", submissionMode: "image_video" }], registrations: [{ ...withSubmission, status }] };
      if (path === "/api/organization/events/E2/registrations" && !options?.method) return { rows: [{ ...withSubmission, status }] };
      if (path === "/api/organization/events/E2/projects/P1/upload-sessions") return { row: { id: "US-RESUME", assets: {} } };
      if (path.endsWith("/assets/artwork_image")) {
        status = "pending";
        return { registration: { ...withSubmission, status } };
      }
      if (path.endsWith("/assets/creation_video")) {
        videoAttempts += 1;
        if (videoAttempts === 1) throw new Error("video replacement failed");
        return { registration: { ...withSubmission, status } };
      }
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-workspace-tab="records"]').trigger("click");
    await wrapper.get('[data-action="replace-organization-materials-R1"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-organization-material-replacement-R1"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("作品图片已替换，作画视频仍待替换");
    expect(apiMock.mock.calls.filter(([path, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/organization/events/E2/registrations/R1/assets/artwork_image",
      "/api/organization/events/E2/registrations/R1/assets/creation_video"
    ]);

    await wrapper.get('[data-action="retry-organization-material-replacement-R1"]').trigger("click");
    await flushPromises();

    expect(apiMock.mock.calls.filter(([path, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/organization/events/E2/registrations/R1/assets/artwork_image",
      "/api/organization/events/E2/registrations/R1/assets/creation_video",
      "/api/organization/events/E2/registrations/R1/assets/creation_video"
    ]);
    expect(wrapper.text()).toContain("已恢复待审核");
  });

  it("does not let a late organization replacement mutate a newer registration session", async () => {
    const first = {
      ...registration,
      id: "R-OLD",
      projectId: "P1",
      submission: { required: true, complete: true, assets: { artwork_image: { kind: "artwork_image", originalName: "old.png" }, creation_video: { kind: "creation_video", originalName: "old.mp4" } } }
    };
    const second = {
      ...registration,
      id: "R-NEW",
      athlete: { name: "李四", school: "第二学校", grade: "六年级", phone: "13900000000" },
      projectId: "P2",
      submission: { required: true, complete: true, assets: { artwork_image: { kind: "artwork_image", originalName: "new.png" }, creation_video: { kind: "creation_video", originalName: "new.mp4" } } }
    };
    let resolveOldImage;
    const delayedOldImage = new Promise((resolve) => { resolveOldImage = resolve; });
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return { event, summary: {}, projects: [{ id: "P1", name: "无人机", submissionMode: "image_video" }, { id: "P2", name: "火箭", submissionMode: "image_video" }], registrations: [first, second] };
      if (path === "/api/organization/events/E2/registrations" && !options?.method) return { rows: [first, second] };
      if (path === "/api/organization/events/E2/projects/P1/upload-sessions") return { row: { id: "US-OLD", assets: {} } };
      if (path === "/api/organization/events/E2/projects/P2/upload-sessions") return { row: { id: "US-NEW", assets: {} } };
      if (path === "/api/organization/events/E2/registrations/R-OLD/assets/artwork_image") return delayedOldImage;
      if (path.includes("/registrations/R-OLD/assets/creation_video")) return { registration: first };
      throw new Error(`unexpected API path ${path}`);
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-workspace-tab="records"]').trigger("click");
    await wrapper.get('[data-action="replace-organization-materials-R-OLD"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-organization-material-replacement-R-OLD"]').trigger("click");
    await wrapper.get('[data-action="replace-organization-materials-R-NEW"]').trigger("click");
    await flushPromises();
    resolveOldImage({ registration: first });
    await flushPromises();

    expect(wrapper.text()).toContain("替换 李四 的作品材料");
    expect(wrapper.text()).not.toContain("作品图片已替换，作画视频仍待替换");
    expect(apiMock.mock.calls.filter(([path, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/organization/events/E2/registrations/R-OLD/assets/artwork_image"
    ]);
  });

  it("joins an available event idempotently and opens its workspace", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/events") return { rows: [{ event, participationState: "available", registrationState: "open" }] };
      if (path === "/api/organization/events/E2/join" && options?.method === "POST") return { row: { organizationId: "O1", eventId: "E2" } };
      return { rows: [] };
    });
    const wrapper = mount(EventCenterPage, { props: { accountType: "organization" } });
    await flushPromises();
    await wrapper.get('[data-action="join-event"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/join", { method: "POST" });
    expect(wrapper.emitted("open-event")[0][0]).toEqual({ eventId: "E2", mode: "organizationWorkspace" });
  });

  it("edits an active organization registration through its event-scoped endpoint", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return { event, summary: {}, projects: [{ id: "P1", name: "无人机" }], registrations: [registration] };
      if (path === "/api/organization/events/E2/registrations" && !options?.method) return { rows: [registration] };
      if (path === "/api/organization/events/E2/registrations/R1" && options?.method === "PATCH") return { row: { ...registration, instructor: "王老师" } };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-workspace-tab="records"]').trigger("click");
    await wrapper.get('[data-action="edit-organization-registration-R1"]').trigger("click");
    await wrapper.get('input[data-field="instructor"]').setValue("王老师");
    await wrapper.get('[data-testid="organization-registration-editor"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations/R1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ athlete: registration.athlete, projectId: "P1", instructor: "王老师" })
    }));
  });

  it("resets the editor when switching registrations so it saves only the second athlete", async () => {
    const first = { ...registration, id: "R-A", instructor: "A老师" };
    const second = {
      ...registration,
      id: "R-B",
      athlete: { name: "李四", school: "第二学校", grade: "六年级", phone: "13900000000" },
      projectId: "P2",
      instructor: "B老师"
    };
    apiMock.mockResolvedValue({ row: second });
    const wrapper = mount(OrganizationAthleteRegistrationForm, {
      props: { eventId: "E2", projects: [{ id: "P1", name: "无人机" }, { id: "P2", name: "火箭" }], registration: first }
    });
    await wrapper.get('[data-field="instructor"]').setValue("A的旧编辑值");
    await wrapper.setProps({ registration: second });
    await flushPromises();

    expect(wrapper.get('[data-field="athlete-name"]').element.value).toBe("李四");
    expect(wrapper.get('input[placeholder="输入或选择学校"]').element.value).toBe("第二学校");
    expect(wrapper.get('[data-field="athlete-grade"]').element.value).toBe("六年级");
    expect(wrapper.get('[data-field="instructor"]').element.value).toBe("B老师");
    expect(wrapper.get("select").element.value).toBe("P2");
    expect(wrapper.get("select").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("赛项在报名创建后不可修改");

    await wrapper.get('[data-field="instructor"]').setValue("B的新编辑值");
    await wrapper.get('[data-testid="organization-registration-editor"]').trigger("submit");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations/R-B", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ athlete: second.athlete, projectId: "P2", instructor: "B的新编辑值" })
    }));
  });

  it("keeps archived workspaces read-only while retaining results and certificates", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return { event: { ...event, archivedAt: "2026-01-01" }, summary: {}, registrations: [registration] };
      if (path === "/api/organization/events/E2/registrations") return { rows: [registration] };
      if (path === "/api/organization/events/E2/certificates") return { rows: [{ id: "C1", athlete: registration.athlete, projectName: "无人机", title: "获奖证书" }] };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    expect(wrapper.find('[data-testid="organization-registration-form"]').exists()).toBe(false);
    await wrapper.get('[data-workspace-tab="results"]').trigger("click");
    expect(wrapper.text()).toContain("一等奖");
    await wrapper.get('[data-workspace-tab="records"]').trigger("click");
    expect(wrapper.find('[data-action="edit-organization-registration-R1"]').exists()).toBe(false);
    await wrapper.get('[data-workspace-tab="certificates"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("获奖证书");
  });
});
