import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, session } = vi.hoisted(() => {
  const organizationState = { value: [] };
  const userState = { value: null };
  return {
    apiMock: vi.fn(),
    session: { user: userState, organizations: organizationState, restore: vi.fn() }
  };
});
vi.mock("../../lib/api.js", () => ({ api: apiMock }));
vi.mock("../../state/session.js", () => ({ useSession: () => session }));

import OrganizationConsolePage from "../OrganizationConsolePage.vue";

const organization = { id: "O1", ownerUserId: "U1", name: "航空少年宫", status: "active", reviewStatus: "approved" };

describe("OrganizationConsolePage", () => {
  beforeEach(() => {
    session.user.value = { id: "U1", type: "organization" };
    session.organizations.value = [organization];
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organizations") return { rows: [organization] };
      if (path === "/api/organizations/O1/members") return { rows: [{ id: "M1", organizationId: "O1", invitedName: "张三", status: "pending", direction: "user_request" }] };
      return { rows: [] };
    });
  });

  it("manages only its owner organization and member requests without manager roles or selectors", async () => {
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organizations/O1/members");
    expect(wrapper.text()).toContain("张三");
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("角色");
    expect(wrapper.text()).not.toContain("邀请成员");
  });
});
