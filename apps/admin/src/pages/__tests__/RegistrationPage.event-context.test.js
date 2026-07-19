import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import RegistrationPage from "../RegistrationPage.vue";

function context() {
  return {
    event: { id: "E2", name: "第二场公开赛事" },
    organizations: [],
    defaultOrganizationId: "",
    grades: [{ id: "primary_lower", name: "小学低段", grades: ["一年级", "二年级", "三年级"] }],
    projects: [{
      id: "P-E2",
      eventId: "E2",
      name: "第二场纸飞机",
      type: "individual",
      allowedGroups: ["小学低段"]
    }]
  };
}

describe("RegistrationPage selected event context", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/registration-context?eventId=E2") return context();
      if (path.startsWith("/api/schools")) return { rows: [] };
      if (path === "/api/registrations/check") return { duplicate: false };
      if (path === "/api/registrations") return { row: { id: "R2", eventId: "E2" } };
      throw new Error(`unexpected API path ${path}`);
    });
  });

  it("uses one event id for context, duplicate checks and submission", async () => {
    const wrapper = mount(RegistrationPage, { props: { eventId: "E2" } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/me/registration-context?eventId=E2");
    expect(wrapper.text()).toContain("第二场公开赛事");

    const inputs = wrapper.findAll("form.form-panel input");
    await inputs[0].setValue("张三");
    await inputs[1].setValue("实验小学");
    await inputs[2].setValue("二年级");
    await inputs[3].setValue("13600005001");
    await flushPromises();

    const duplicateCall = apiMock.mock.calls.find(([path]) => path === "/api/registrations/check");
    expect(JSON.parse(duplicateCall[1].body)).toMatchObject({ eventId: "E2", projectId: "P-E2" });

    await wrapper.get("form.form-panel").trigger("submit");
    await flushPromises();
    const createCall = apiMock.mock.calls.find(([path]) => path === "/api/registrations");
    expect(JSON.parse(createCall[1].body)).toMatchObject({ eventId: "E2", projectId: "P-E2" });
  });

  it("surfaces a missing-event selection error instead of using fallback projects", async () => {
    apiMock.mockRejectedValueOnce(new Error("存在多场可报名赛事，请选择赛事"));
    const wrapper = mount(RegistrationPage, {
      props: { fallbackContext: { projects: [{ id: "P-OTHER", name: "其他赛事项目" }] } }
    });
    await flushPromises();

    expect(wrapper.emitted("error")?.[0]).toEqual(["存在多场可报名赛事，请选择赛事"]);
    expect(wrapper.text()).not.toContain("其他赛事项目");
  });
});
