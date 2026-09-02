import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import OrganizationAthleteRegistrationForm from "../OrganizationAthleteRegistrationForm.vue";
import RegistrationPage from "../../pages/RegistrationPage.vue";

const identityNumbers = [
  "110105201401011215",
  "110105201401011223",
  "110105201401011231",
  "11010520140101124X",
  "110105201401011258",
  "110105201401011266",
  "110105201401011274",
  "110105201401011282"
];

const teamProject = {
  id: "P-TEAM",
  name: "无人机接力",
  type: "team",
  allowedGroups: ["小学高段"],
  teamMinMembers: 1,
  teamMaxMembers: 8,
  instructorRequired: true,
  submissionMode: "none"
};

const grades = [{ id: "primary_upper", name: "小学高段", grades: ["五年级"] }];

async function mountTeamForm() {
  const wrapper = mount(OrganizationAthleteRegistrationForm, {
    props: {
      eventId: "E1",
      projects: [teamProject],
      grades,
      defaultSchool: "航空学校"
    }
  });
  await flushPromises();
  return wrapper;
}

async function fillParticipant(wrapper, index) {
  const participant = wrapper.get(`[data-participant-index="${index}"]`);
  await participant.get('[data-field="participant-name"]').setValue(`队员${index + 1}`);
  await participant.get('[data-field="participant-school"]').setValue("航空学校");
  await participant.get('[data-field="participant-grade"]').setValue("五年级");
  await participant.get('[data-field="participant-phone"]').setValue(`1380000000${index + 1}`);
  await participant.get('[data-field="participant-student-id"]').setValue(identityNumbers[index]);
}

describe("team organization registration form", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/organization/leaders") {
        return { rows: [{ id: "OL1", reviewStatus: "approved", enabled: true }] };
      }
      if (path === "/api/organization/events/E1/registrations") return { row: { id: "R1", teamCode: "O1-P-TEAM-01" } };
      return {};
    });
  });

  it("marks the instructor field required when the project requires one", async () => {
    const wrapper = await mountTeamForm();
    expect(wrapper.get('[data-field="instructor"]').attributes("required")).toBeDefined();
    wrapper.unmount();
  });

  it("adds a second person and submits one organization-proxy team payload", async () => {
    const wrapper = await mountTeamForm();
    expect(wrapper.find('[data-registration-source="member_registration"]').exists()).toBe(false);

    await wrapper.get('[data-action="add-team-participant"]').trigger("click");
    await fillParticipant(wrapper, 0);
    await fillParticipant(wrapper, 1);
    await wrapper.get('[data-field="instructor"]').setValue("林老师");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    const registrationCalls = apiMock.mock.calls.filter(([path]) => path === "/api/organization/events/E1/registrations");
    expect(registrationCalls).toHaveLength(1);
    expect(registrationCalls[0][1].method).toBe("POST");
    const body = JSON.parse(registrationCalls[0][1].body);
    expect(body).toEqual({
      projectId: "P-TEAM",
      participants: [
        { name: "队员1", school: "航空学校", grade: "五年级", phone: "13800000001", studentIdNumber: identityNumbers[0] },
        { name: "队员2", school: "航空学校", grade: "五年级", phone: "13800000002", studentIdNumber: identityNumbers[1] }
      ],
      instructor: "林老师",
      registrationSource: "organization_proxy"
    });
    expect(body).not.toHaveProperty("memberUserId");
    expect(body).not.toHaveProperty("athlete");
    wrapper.unmount();
  });

  it("disables adding participants at the trusted project maximum", async () => {
    const wrapper = await mountTeamForm();
    const add = () => wrapper.get('[data-action="add-team-participant"]');
    for (let index = 1; index < 8; index += 1) await add().trigger("click");

    expect(wrapper.findAll("[data-participant-index]")).toHaveLength(8);
    expect(add().attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("loads the complete persisted roster when editing a team", async () => {
    const participants = [
      { id: "RP1", name: "已存队员甲", school: "航空学校", grade: "五年级", phone: "13800000001", studentIdNumber: identityNumbers[0] },
      { id: "RP2", name: "已存队员乙", school: "航空学校", grade: "五年级", phone: "13800000002", studentIdNumber: identityNumbers[1] }
    ];
    const wrapper = mount(OrganizationAthleteRegistrationForm, {
      props: {
        eventId: "E1",
        projects: [teamProject],
        grades,
        defaultSchool: "航空学校",
        registration: { id: "R1", projectId: "P-TEAM", source: "organization_proxy", participants, instructor: "原老师" }
      }
    });
    await flushPromises();

    expect(wrapper.findAll("[data-participant-index]")).toHaveLength(2);
    expect(wrapper.findAll('[data-field="participant-name"]').map((field) => field.element.value)).toEqual(["已存队员甲", "已存队员乙"]);
    wrapper.unmount();
  });
});

describe("personal registration project choices", () => {
  it("filters team projects out of the personal registration form", async () => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({
      event: { id: "E1", name: "测试赛事" },
      eligibility: { eligible: true, code: "OK", organization: { id: "O1", name: "航空学校" } },
      organizations: [{ id: "O1", name: "航空学校" }],
      grades,
      projects: [
        { ...teamProject },
        { id: "P-INDIVIDUAL", name: "纸飞机", type: "individual", allowedGroups: ["小学高段"], submissionMode: "none" }
      ]
    });
    const wrapper = mount(RegistrationPage, {
      props: { eventId: "E1", accountType: "ordinary", registrationState: "open" }
    });
    await flushPromises();
    await wrapper.get('input[placeholder="请选择实际年级"]').setValue("五年级");
    await flushPromises();

    const projectOptions = wrapper.findAll("select option").map((option) => option.attributes("value"));
    expect(projectOptions).toEqual(["P-INDIVIDUAL"]);
    expect(wrapper.text()).not.toContain("无人机接力");
    wrapper.unmount();
  });
});
