import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function membership(id, name, status, direction) {
  return {
    id,
    userId: `U-${id}`,
    organizationId: "O1",
    role: "member",
    status,
    direction,
    note: "",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:00.000Z",
    user: { id: `U-${id}`, name, phone: `13700000${id.slice(-3).padStart(3, "0")}` }
  };
}

const rows = [
  membership("M-request", "申请用户", "pending", "user_request"),
  membership("M-invite", "受邀用户", "pending", "organization_invite"),
  membership("M-active", "正式成员", "active", "user_request"),
  membership("M-rejected", "已拒绝用户", "rejected", "user_request"),
  membership("M-removed", "历史成员", "removed", "organization_invite")
];

function membershipsPayload() {
  return { organization, summary: { total: 5, pending: 2, active: 1 }, rows };
}

describe("OrganizationConsolePage", () => {
  beforeEach(() => {
    session.user.value = { id: "U1", type: "organization" };
    session.organizations.value = [organization];
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organizations") return { rows: [organization] };
      if (path === "/api/organization/memberships") return membershipsPayload();
      return { rows: [] };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("finds a registered ordinary user and sends an invitation", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/organizations") return { rows: [organization] };
      if (path === "/api/organization/memberships") return membershipsPayload();
      if (path === "/api/organization/member-candidate?phone=13700000021") {
        return { user: { id: "U21", name: "受邀用户", phone: "13700000021" } };
      }
      if (path === "/api/organization/invitations" && options?.method === "POST") return { row: membership("M-new", "受邀用户", "pending", "organization_invite") };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    await wrapper.get('[data-field="member-phone"]').setValue("13700000021");
    await wrapper.get('[data-action="find-member"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("受邀用户");

    await wrapper.get('[data-action="invite-member"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/invitations", {
      method: "POST",
      body: JSON.stringify({ phone: "13700000021" })
    });
    expect(wrapper.find('[data-action="invite-member"]').exists()).toBe(false);
  });

  it("validates an exact mobile number locally and only shows a returned candidate", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organizations") return { rows: [organization] };
      if (path === "/api/organization/memberships") return membershipsPayload();
      if (path === "/api/organization/member-candidate?phone=13700000022") return { user: { id: "U22", name: "资料不完整" } };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    await wrapper.get('[data-field="member-phone"]').setValue("137-0000-0021");
    await wrapper.get('[data-action="find-member"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("请输入完整的 11 位手机号");
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining("member-candidate"));

    await wrapper.get('[data-field="member-phone"]').setValue("13700000022");
    await wrapper.get('[data-action="find-member"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-action="invite-member"]').exists()).toBe(false);
  });

  it("shows summary counts plus applications, invitations, members, and historical relations", async () => {
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/memberships");
    expect(wrapper.get('[data-summary="total"]').text()).toContain("5");
    expect(wrapper.get('[data-summary="pending"]').text()).toContain("2");
    expect(wrapper.get('[data-summary="active"]').text()).toContain("1");
    expect(wrapper.text()).toContain("申请用户");
    expect(wrapper.text()).toContain("受邀用户");
    expect(wrapper.text()).toContain("正式成员");
    expect(wrapper.text()).toContain("已拒绝用户");
    expect(wrapper.text()).toContain("历史成员");
  });

  it("approves or rejects user applications with explicit owner actions", async () => {
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    await wrapper.get('[data-action="approve-M-request"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/memberships/M-request", {
      method: "PATCH",
      body: JSON.stringify({ action: "approve" })
    });

    await wrapper.get('[data-action="reject-M-request"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/memberships/M-request", {
      method: "PATCH",
      body: JSON.stringify({ action: "reject" })
    });
  });

  it("cancels a pending organization invitation", async () => {
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    await wrapper.get('[data-action="cancel-M-invite"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/memberships/M-invite", {
      method: "PATCH",
      body: JSON.stringify({ action: "cancel" })
    });
  });

  it("requires confirmation before removing a member and preserves historical records", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    await wrapper.get('[data-action="remove-M-active"]').trigger("click");
    expect(apiMock).not.toHaveBeenCalledWith("/api/organization/memberships/M-active", expect.anything());

    await wrapper.get('[data-action="remove-M-active"]').trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenLastCalledWith("确认移除成员 正式成员？历史报名和证书不会删除。");
    expect(apiMock).toHaveBeenCalledWith("/api/organization/memberships/M-active", {
      method: "PATCH",
      body: JSON.stringify({ action: "remove" })
    });
  });

  it("keeps qualification progress but hides invitation tools for a non-operational organization", async () => {
    const pendingOrganization = { ...organization, reviewStatus: "pending" };
    session.organizations.value = [pendingOrganization];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organizations") return { rows: [pendingOrganization] };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    expect(wrapper.get('[data-testid="organization-review-progress"]').text()).toContain("待审核");
    expect(wrapper.find('[data-field="member-phone"]').exists()).toBe(false);
    expect(apiMock).not.toHaveBeenCalledWith("/api/organization/memberships");
  });

  it("keeps the existing rejected qualification progress wording", async () => {
    const rejectedOrganization = { ...organization, reviewStatus: "rejected", rejectReason: "资料不清晰" };
    session.organizations.value = [rejectedOrganization];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organizations") return { rows: [rejectedOrganization] };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationConsolePage);
    await flushPromises();

    expect(wrapper.get('[data-testid="organization-review-progress"]').text()).toContain("已驳回");
    expect(wrapper.text()).toContain("驳回原因：资料不清晰");
    expect(apiMock).not.toHaveBeenCalledWith("/api/organization/memberships");
  });
});
