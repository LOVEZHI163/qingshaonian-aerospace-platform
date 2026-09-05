import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import OrganizationEventWorkspacePage from "../OrganizationEventWorkspacePage.vue";

const workspace = {
  event: {
    id: "E2",
    name: "Event E2",
    dateLabel: "2026-08-20",
    venue: "Airport Hall",
    registrationEndAt: "2026-08-10T18:00:00.000Z",
    status: "published"
  },
  organization: { id: "O1", name: "Aviation School" },
  summary: { registrationCount: 1, pendingRegistrationCount: 0, certificateCount: 1 },
  projects: [{ id: "P1", name: "Drone" }],
  grades: [{ id: "primary", name: "Primary", grades: ["Grade 5"] }],
  members: [{ id: "U1", name: "Student Member", phone: "13800000001" }],
  registrations: []
};

describe("OrganizationEventWorkspacePage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return workspace;
      if (path === "/api/organization/leaders") return { rows: [{ id: "OL1", reviewStatus: "approved", enabled: true }] };
      if (path === "/api/organization/events/E2/registrations") return { rows: [] };
      return { rows: [] };
    });
  });

  it("keeps the event workspace visible while disabling only new registration without an approved leader", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return workspace;
      if (path === "/api/organization/leaders") return { rows: [{ id: "OL-pending", reviewStatus: "pending", enabled: true }] };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(wrapper.text()).toContain("Event E2");
    expect(wrapper.text()).toContain("报名 1");
    expect(wrapper.text()).toContain("请先在领队管理提交至少一名领队并等待平台审核通过");
    expect(wrapper.find('[data-testid="organization-registration-form"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="organization-registration-form"] button.primary').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-action="open-leader-management"]').attributes("href")).toContain("view=leaders");
  });

  it("renders the single-event overview, guidance, and registration cards without local workspace tabs", async () => {
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(wrapper.text()).toContain("Event E2");
    expect(wrapper.text()).toContain("2026-08-20");
    expect(wrapper.text()).toContain("Airport Hall");
    expect(wrapper.text()).toContain("报名 1");
    expect(wrapper.findAll(".organization-event-summary-card")).toHaveLength(1);
    expect(wrapper.findAll(".organization-registration-guide")).toHaveLength(1);
    expect(wrapper.findAll(".organization-registration-card")).toHaveLength(1);
    expect(wrapper.find('[data-testid="organization-registration-form"]').exists()).toBe(true);
    expect(wrapper.findAll("[data-workspace-tab]")).toHaveLength(0);
    expect(wrapper.find("[data-action=export-organization-registrations]").exists()).toBe(false);
  });

  it("shows the loading state until the workspace response arrives", async () => {
    let resolveWorkspace;
    apiMock.mockImplementationOnce(() => new Promise((resolve) => { resolveWorkspace = resolve; }));
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });

    expect(wrapper.find(".organization-event-workspace > .hint").exists()).toBe(true);
    expect(wrapper.find(".organization-event-summary-card").exists()).toBe(false);

    resolveWorkspace(workspace);
    await flushPromises();
    expect(wrapper.find(".organization-event-summary-card").exists()).toBe(true);
  });

  it.each([403, 404])("emits access-denied for workspace status %s", async (status) => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("denied"), { status }));
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(wrapper.emitted("access-denied")).toHaveLength(1);
    expect(wrapper.emitted("access-denied")[0][0]).toMatchObject({ status });
  });

  it("emits access-denied for a stable organization restriction code without an HTTP status", async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("stale session"), { code: "ORGANIZATION_REJECTED" }));
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(wrapper.emitted("access-denied")?.[0]?.[0]).toMatchObject({ code: "ORGANIZATION_REJECTED" });
  });

  it("propagates a stable restriction from upload-session creation", async () => {
    const imageWorkspace = {
      ...workspace,
      projects: [{ id: "P-IMAGE", name: "Artwork", type: "individual", allowedGroups: ["Primary"], submissionMode: "image_video" }]
    };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return imageWorkspace;
      if (path === "/api/organization/leaders") return { rows: [{ id: "OL1", reviewStatus: "approved", enabled: true }] };
      if (path === "/api/organization/events/E2/projects/P-IMAGE/upload-sessions") {
        throw Object.assign(new Error("stale session"), { code: "ORGANIZATION_DISABLED" });
      }
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-field="athlete-grade"]').setValue("Grade 5");
    await flushPromises();

    expect(wrapper.emitted("access-denied")?.[0]?.[0]).toMatchObject({ code: "ORGANIZATION_DISABLED" });
  });

  it("submits a new organization registration from the retained form", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return workspace;
      if (path === "/api/organization/leaders") return { rows: [{ id: "OL1", reviewStatus: "approved", enabled: true }] };
      if (path === "/api/organization/events/E2/registrations" && options?.method === "POST") return { row: { id: "R2" } };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-registration-source="organization_proxy"]').setValue();
    await wrapper.get('[data-field="athlete-name"]').setValue("Student A");
    await wrapper.get('[data-field="athlete-grade"]').setValue("Grade 5");
    await wrapper.get('[data-field="athlete-phone"]').setValue("13800000000");
    await wrapper.get('[data-field="student-id-number"]').setValue("11010520140101123X");
    await wrapper.get('[data-testid="organization-registration-form"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ registrationSource: "organization_proxy", studentIdNumber: "11010520140101123X", athlete: { name: "Student A", school: "Aviation School", grade: "Grade 5", phone: "13800000000" }, projectId: "P1", instructor: "" })
    }));
    const feedback = wrapper.get('[data-testid="organization-registration-feedback"]');
    expect(feedback.attributes("role")).toBe("status");
    expect(feedback.text()).toContain("提交成功");
    await wrapper.get('[data-action="view-registration-records"]').trigger("click");
    expect(wrapper.emitted("view-records")).toEqual([[]]);
  });

  it("explains the national-standard validation failure and preserves its stable error code", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return workspace;
      if (path === "/api/organization/leaders") return { rows: [{ id: "OL1", reviewStatus: "approved", enabled: true }] };
      if (path === "/api/organization/events/E2/registrations" && options?.method === "POST") {
        throw Object.assign(new Error("身份证号校验失败"), { status: 400, code: "INVALID_STUDENT_ID_NUMBER" });
      }
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-registration-source="organization_proxy"]').setValue();
    await wrapper.get('[data-field="athlete-name"]').setValue("Student A");
    await wrapper.get('[data-field="athlete-grade"]').setValue("Grade 5");
    await wrapper.get('[data-field="athlete-phone"]').setValue("13800000000");
    await wrapper.get('[data-field="student-id-number"]').setValue("330304198811232711");
    await wrapper.get('[data-testid="organization-registration-form"]').trigger("submit");
    await flushPromises();

    const feedback = wrapper.get('[data-testid="organization-registration-feedback"]');
    expect(feedback.attributes("role")).toBe("alert");
    expect(feedback.text()).toContain("输入的身份证号码不符合国家标准，请检查后重新填写");
    expect(wrapper.emitted("error")?.at(-1)?.[0]).toMatchObject({ code: "INVALID_STUDENT_ID_NUMBER" });
  });

  it("submits member_registration with the selected active member and prefilled identity", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return workspace;
      if (path === "/api/organization/leaders") return { rows: [{ id: "OL1", reviewStatus: "approved", enabled: true }] };
      if (path === "/api/organization/events/E2/registrations" && options?.method === "POST") return { row: { id: "R-member" } };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(wrapper.text()).toContain("成员报名");
    expect(wrapper.text()).toContain("组织代报名");
    await wrapper.get('[data-registration-source="member_registration"]').setValue();
    await wrapper.get('[data-field="member-user-id"]').setValue("U1");
    expect(wrapper.get('[data-field="athlete-name"]').element.value).toBe("Student Member");
    expect(wrapper.get('[data-field="athlete-phone"]').element.value).toBe("13800000001");
    expect(wrapper.get('[data-field="athlete-name"]').attributes("readonly")).toBeDefined();
    expect(wrapper.get('[data-field="athlete-phone"]').attributes("readonly")).toBeDefined();
    await wrapper.get('[data-field="athlete-grade"]').setValue("Grade 5");
    await wrapper.get('[data-field="student-id-number"]').setValue("11010520140101123x");
    await wrapper.get('[data-testid="organization-registration-form"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ registrationSource: "member_registration", memberUserId: "U1", studentIdNumber: "11010520140101123x", athlete: { name: "Student Member", school: "Aviation School", grade: "Grade 5", phone: "13800000001" }, projectId: "P1", instructor: "" })
    }));
  });

  it("requires a valid student identity and shows the approved purpose for new organization registrations", async () => {
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    const identity = wrapper.get('[data-field="student-id-number"]');
    expect(identity.attributes("required")).toBeDefined();
    expect(identity.attributes("minlength")).toBe("18");
    expect(identity.attributes("maxlength")).toBe("18");
    expect(identity.attributes("pattern")).toBe("[0-9]{17}[0-9Xx]");
    expect(identity.attributes("placeholder")).toBe("18 位居民身份证号，末位可为 X");
    expect(wrapper.text()).toContain("学生身份证号是报名资料，将用于名单导出和证书信息核对，请本人或监护人确认填写正确。");

    await wrapper.get('[data-registration-source="organization_proxy"]').setValue();
    await identity.setValue("11010520140101123A");
    await wrapper.get('[data-testid="organization-registration-form"]').trigger("submit");
    await flushPromises();
    expect(apiMock.mock.calls.some(([path, options]) => path === "/api/organization/events/E2/registrations" && options?.method === "POST")).toBe(false);
    expect(wrapper.emitted("error")?.at(-1)?.[0]).toMatchObject({ message: "请输入 18 位居民身份证号，末位可为 X" });
  });

  it("keeps proxy identity editable while member identity is derived and read-only", async () => {
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-registration-source="organization_proxy"]').setValue();
    expect(wrapper.get('[data-field="athlete-name"]').attributes("readonly")).toBeUndefined();
    expect(wrapper.get('[data-field="athlete-phone"]').attributes("readonly")).toBeUndefined();
  });

  it("searches active members by name or phone and clears stale selections and identity", async () => {
    const searchableWorkspace = {
      ...workspace,
      members: [
        { id: "U1", name: "张同学", phone: "13800000001" },
        { id: "U2", name: "李同学", phone: "13900000002" }
      ]
    };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return searchableWorkspace;
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    await wrapper.get('[data-registration-source="member_registration"]').setValue();
    const search = wrapper.get('[data-field="member-search"]');
    await search.setValue("李同学");
    expect(wrapper.get('[data-field="member-user-id"]').findAll("option").map((option) => option.text())).toEqual([
      "请选择本组织有效成员",
      "李同学 · 13900000002"
    ]);

    await search.setValue("0002");
    await wrapper.get('[data-field="member-user-id"]').setValue("U2");
    expect(wrapper.get('[data-field="athlete-name"]').element.value).toBe("李同学");
    expect(wrapper.get('[data-field="athlete-phone"]').element.value).toBe("13900000002");

    await search.setValue("");
    await wrapper.get('[data-field="member-user-id"]').setValue("U1");
    expect(wrapper.get('[data-field="athlete-name"]').element.value).toBe("张同学");
    expect(wrapper.get('[data-field="athlete-phone"]').element.value).toBe("13800000001");

    await search.setValue("0002");
    expect(wrapper.get('[data-field="member-user-id"]').element.value).toBe("");
    expect(wrapper.get('[data-field="athlete-name"]').element.value).toBe("");
    expect(wrapper.get('[data-field="athlete-phone"]').element.value).toBe("");

    await search.setValue("没有这个成员");
    expect(wrapper.get('[data-state="member-search-empty"]').text()).toContain("未找到匹配的有效成员");

    await search.setValue("");
    await wrapper.get('[data-field="member-user-id"]').setValue("U1");
    await wrapper.get('[data-registration-source="organization_proxy"]').setValue();
    await wrapper.get('[data-registration-source="member_registration"]').setValue();
    expect(wrapper.get('[data-field="member-search"]').element.value).toBe("");
    expect(wrapper.get('[data-field="member-user-id"]').element.value).toBe("");
    expect(wrapper.get('[data-field="athlete-name"]').element.value).toBe("");
    expect(wrapper.get('[data-field="athlete-phone"]').element.value).toBe("");
  });

  it("renders the exact grade dropdown and keeps the organization school editable", async () => {
    const exactGrades = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级", "初一", "初二", "初三", "高一", "高二", "高三", "职高一年级", "职高二年级", "职高三年级"];
    const exactWorkspace = {
      ...workspace,
      organization: { id: "O1", name: "默认组织学校" },
      grades: [
        { id: "primary", grades: exactGrades.slice(0, 6) },
        { id: "middle", grades: exactGrades.slice(6, 9) },
        { id: "high", grades: exactGrades.slice(9, 12) },
        { id: "vocational", grades: exactGrades.slice(12) }
      ]
    };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return exactWorkspace;
      if (path.startsWith("/api/schools")) return { rows: [] };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(wrapper.get('[data-field="athlete-grade"]').findAll("option").slice(1).map((option) => option.text())).toEqual(exactGrades);
    const school = wrapper.get('.organization-athlete-registration-form input[list="school-options"]');
    expect(school.element.value).toBe("默认组织学校");
    await school.setValue("参赛学生实际学校");
    expect(school.element.value).toBe("参赛学生实际学校");
  });

  it("keeps archived workspaces read-only while allowing a return to events", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/events/E2/workspace") return { ...workspace, event: { ...workspace.event, status: "archived", archivedAt: "2026-01-01" } };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(wrapper.find('[data-testid="organization-registration-form"]').exists()).toBe(false);
    await wrapper.get("[data-action=back-to-events]").trigger("click");
    expect(wrapper.emitted("back-to-events")).toEqual([[]]);
  });

  it("emits back-to-events when the return control is used", async () => {
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    await wrapper.get("[data-action=back-to-events]").trigger("click");

    expect(wrapper.emitted("back-to-events")).toEqual([[]]);
  });
});
