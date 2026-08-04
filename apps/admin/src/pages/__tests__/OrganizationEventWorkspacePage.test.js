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
  grades: [],
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
    expect(wrapper.findAll(".organization-event-summary-card")).toHaveLength(1);
    expect(wrapper.findAll(".organization-registration-guide")).toHaveLength(1);
    expect(wrapper.findAll(".organization-registration-card")).toHaveLength(1);
    expect(wrapper.find('[data-testid="organization-registration-form"]').exists()).toBe(true);
    expect(wrapper.findAll("[data-workspace-tab]")).toHaveLength(0);
    expect(wrapper.find("[data-action=export-organization-registrations]").exists()).toBe(false);
  });

  it("emits back-to-events when the return control is used", async () => {
    const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
    await flushPromises();

    await wrapper.get("[data-action=back-to-events]").trigger("click");

    expect(wrapper.emitted("back-to-events")).toEqual([[]]);
  });
});
