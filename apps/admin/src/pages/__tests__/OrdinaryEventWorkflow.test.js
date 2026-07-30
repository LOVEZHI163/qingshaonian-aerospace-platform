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

vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));
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
});
