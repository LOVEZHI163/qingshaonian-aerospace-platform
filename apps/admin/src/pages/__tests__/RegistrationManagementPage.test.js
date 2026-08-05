import { flushPromises, mount as vueMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));
vi.mock("../../components/SubmissionAssetReview.vue", () => ({
  default: {
    props: ["eventId", "registration", "disabled"],
    emits: ["close", "refresh", "error"],
    methods: {
      refreshRegistration() {
        this.$emit("refresh", { ...this.registration, status: "rejected", submission: { ...this.registration.submission, warnings: ["已刷新素材元数据"] } });
      }
    },
    template: '<section data-testid="submission-review">{{ registration.id }} {{ registration.status }} {{ registration.submission?.warnings?.join(\' \') }}<button type="button" data-action="refresh-review" @click="refreshRegistration">刷新</button><button type="button" data-action="close-review" @click="$emit(\'close\')">关闭</button></section>'
  }
}));

import RegistrationManagementPage from "../RegistrationManagementPage.vue";
const mount = (component, options = {}) => vueMount(component, { ...options, props: { eventId: "E1", ...(options.props || {}) } });

const event = { id: "E1", name: "2026 航空赛事", isCurrent: true };
const project = { id: "P1", eventId: "E1", name: "纸飞机", allowedGroups: ["小学低段"] };
const registration = {
  id: "R1", eventId: "E1", organizationId: "O1", organization: "实验小学", athlete: { name: "张三", school: "实验小学", grade: "三年级", phone: "13800000000" },
  group: "小学低段", projectId: "P1", projectName: "纸飞机", projectType: "individual", instructor: "林老师", status: "pending"
};

function mockLoads() {
  apiMock.mockImplementation(async (path) => {
    if (path === "/api/admin/events") return { rows: [event], projects: [project] };
    if (path === "/api/admin/organizations") return { rows: [{ id: "O1", name: "实验小学" }] };
    if (path.startsWith("/api/admin/events/E1/registrations?")) return { rows: [registration], total: 1, page: 1, pageSize: 25, refreshedAt: "2026-07-17T08:00:00.000Z" };
    return { row: registration };
  });
}

describe("RegistrationManagementPage", () => {
  beforeEach(() => { apiMock.mockReset(); apiBlobMock.mockReset(); mockLoads(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("renders filters, instructor, refresh timestamp, pagination and management entries", async () => {
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("林老师");
    expect(wrapper.text()).toContain("最近刷新");
    expect(wrapper.text()).toContain("审核");
    expect(wrapper.text()).toContain("驳回");
    expect(wrapper.text()).toContain("编辑");
    expect(wrapper.text()).toContain("成绩");
    expect(wrapper.text()).toContain("证书");
    expect(wrapper.find('[data-filter="eventId"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="export-filtered"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="export-all"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="certificate-template"]').exists()).toBe(true);
  });

  it("shows an approved registration as reviewed in Chinese and disables repeat approval", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/organizations") return { rows: [{ id: "O1", name: "实验小学" }] };
      if (path.startsWith("/api/admin/events/E1/registrations?")) return { rows: [{ ...registration, status: "approved" }], total: 1, page: 1, pageSize: 25 };
      return { row: registration };
    });
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();

    expect(wrapper.get("em.approved").text()).toBe("已审核");
    const reviewedButton = wrapper.get('[data-action="approve-R1"]');
    expect(reviewedButton.text()).toBe("已审核");
    expect(reviewedButton.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).not.toContain("approved");
  });

  it("refreshes the filtered page without rendering a certificate number", async () => {
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="refresh"]').trigger("click");
    await flushPromises();

    expect(apiMock.mock.calls.filter(([path]) => path.startsWith("/api/admin/events/E1/registrations?")).length).toBeGreaterThan(1);
    expect(wrapper.text()).not.toContain("证书编号");
  });

  it("opens certificate management for the selected registration", async () => {
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();

    await wrapper.get('[data-action="manage-certificates"]').trigger("click");

    expect(wrapper.emitted("open-certificates")?.[0]).toEqual([registration]);
  });

  it("opens the material review drawer and blocks direct approval when required material is missing", async () => {
    const missingMaterials = {
      ...registration,
      submission: { required: true, complete: false, warnings: [], assets: { artwork_image: null, creation_video: null } }
    };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/organizations") return { rows: [{ id: "O1", name: "实验小学" }] };
      if (path.startsWith("/api/admin/events/E1/registrations?")) return { rows: [missingMaterials], total: 1, page: 1, pageSize: 25, refreshedAt: "2026-07-17T08:00:00.000Z" };
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("待上传");
    await wrapper.get('[data-action="review-materials-R1"]').trigger("click");
    expect(wrapper.get('[data-testid="submission-review"]').text()).toContain("R1");
    await wrapper.get('[data-action="approve-R1"]').trigger("click");
    await flushPromises();

    expect(apiMock.mock.calls.some(([path, options]) => path.endsWith("/registrations/R1/status") && options?.method === "PATCH")).toBe(false);
    expect(wrapper.text()).toContain("作品材料");
  });

  it("keeps the open review drawer synchronized with a replacement response", async () => {
    const withSubmission = {
      ...registration,
      submission: { required: true, complete: true, warnings: [], assets: { artwork_image: { kind: "artwork_image" }, creation_video: { kind: "creation_video" } } }
    };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/organizations") return { rows: [{ id: "O1", name: "实验小学" }] };
      if (path.startsWith("/api/admin/events/E1/registrations?")) return { rows: [withSubmission], total: 1, page: 1, pageSize: 25, refreshedAt: "2026-07-17T08:00:00.000Z" };
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="review-materials-R1"]').trigger("click");
    await wrapper.get('[data-action="refresh-review"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="submission-review"]').text()).toContain("rejected");
    expect(wrapper.get('[data-testid="submission-review"]').text()).toContain("已刷新素材元数据");
  });

  it("makes the project immutable in the edit dialog and restores focus after closing material review", async () => {
    const withSubmission = {
      ...registration,
      submission: { required: true, complete: true, warnings: [], assets: { artwork_image: { kind: "artwork_image" }, creation_video: { kind: "creation_video" } } }
    };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/organizations") return { rows: [{ id: "O1", name: "实验小学" }] };
      if (path.startsWith("/api/admin/events/E1/registrations?")) return { rows: [withSubmission], total: 1, page: 1, pageSize: 25, refreshedAt: "2026-07-17T08:00:00.000Z" };
      throw new Error(`unexpected ${path}`);
    });
    const wrapper = mount(RegistrationManagementPage, { attachTo: document.body });
    await flushPromises();
    const editButton = wrapper.findAll("button").find((button) => button.text() === "编辑");
    await editButton.trigger("click");
    const projectSelect = wrapper.get('[data-field="registration-project"]');
    expect(projectSelect.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("赛项在报名创建后不可修改");

    const reviewButton = wrapper.get('[data-action="review-materials-R1"]');
    reviewButton.element.focus();
    await reviewButton.trigger("click");
    await wrapper.get('[data-action="close-review"]').trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(reviewButton.element);
    wrapper.unmount();
  });

  it("releases successful Blob downloads on unmount and does not create a URL for failures", async () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:download"); URL.revokeObjectURL = vi.fn();
    apiBlobMock.mockResolvedValueOnce({});
    const wrapper = mount(RegistrationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="export-all"]').trigger("click");
    await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");

    apiBlobMock.mockRejectedValueOnce(new Error("denied"));
    const failed = mount(RegistrationManagementPage);
    await flushPromises();
    await failed.get('[data-action="export-all"]').trigger("click");
    await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});
