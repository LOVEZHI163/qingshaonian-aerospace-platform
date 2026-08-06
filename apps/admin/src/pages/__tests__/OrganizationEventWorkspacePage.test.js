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
      if (path === "/api/organization/events/E2/registrations") return { rows: [] };
      return { rows: [] };
    });
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

  it("submits a new organization registration from the retained form", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return workspace;
      if (path === "/api/organization/events/E2/registrations" && options?.method === "POST") return { row: { id: "R2" } };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-registration-source="organization_proxy"]').setValue();
    await wrapper.get('[data-field="athlete-name"]').setValue("Student A");
    await wrapper.get('[data-field="athlete-grade"]').setValue("Grade 5");
    await wrapper.get('[data-field="athlete-phone"]').setValue("13800000000");
    await wrapper.get('[data-testid="organization-registration-form"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ registrationSource: "organization_proxy", athlete: { name: "Student A", school: "Aviation School", grade: "Grade 5", phone: "13800000000" }, projectId: "P1", instructor: "" })
    }));
  });

  it("submits member_registration with the selected active member and prefilled identity", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return workspace;
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
    await wrapper.get('[data-field="athlete-grade"]').setValue("Grade 5");
    await wrapper.get('[data-testid="organization-registration-form"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ registrationSource: "member_registration", memberUserId: "U1", athlete: { name: "Student Member", school: "Aviation School", grade: "Grade 5", phone: "13800000001" }, projectId: "P1", instructor: "" })
    }));
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
