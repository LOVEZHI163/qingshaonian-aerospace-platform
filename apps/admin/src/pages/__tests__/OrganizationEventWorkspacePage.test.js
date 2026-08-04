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

  it("submits a new organization registration from the retained form", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/organization/events/E2/workspace") return workspace;
      if (path === "/api/organization/events/E2/registrations" && options?.method === "POST") return { row: { id: "R2" } };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();
    await wrapper.get('[data-field="athlete-name"]').setValue("Student A");
    await wrapper.get('[data-field="athlete-grade"]').setValue("Grade 5");
    await wrapper.get('[data-field="athlete-phone"]').setValue("13800000000");
    await wrapper.get('[data-testid="organization-registration-form"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/registrations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ athlete: { name: "Student A", school: "Aviation School", grade: "Grade 5", phone: "13800000000" }, projectId: "P1", instructor: "" })
    }));
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
