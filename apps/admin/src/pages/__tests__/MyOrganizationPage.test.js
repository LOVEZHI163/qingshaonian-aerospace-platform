import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import MyOrganizationPage from "../MyOrganizationPage.vue";

enableAutoUnmount(afterEach);

const organization = { id: "O1", name: "实验学校", code: "WZ-001", contactName: "王老师", contactPhone: "13800000000" };
const otherOrganization = { id: "O2", name: "航空少年宫", code: "WZ-002", contactName: "李老师", contactPhone: "13900000000" };

function relation(id, status, direction, organizationSummary = organization) {
  return {
    id,
    userId: "U1",
    organizationId: organizationSummary.id,
    role: "member",
    status,
    direction,
    note: "欢迎加入",
    createdAt: "2026-08-04T08:00:00.000Z",
    updatedAt: "2026-08-04T08:00:00.000Z",
    organization: organizationSummary
  };
}

describe("MyOrganizationPage", () => {
  beforeEach(() => apiMock.mockReset());

  it("搜索组织并提交个人加入申请", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/organization-relations") return { active: [], requests: [], invitations: [] };
      if (path === "/api/organizations/search?q=%E5%AE%9E%E9%AA%8C") return { rows: [organization] };
      if (path === "/api/me/organization-requests" && options?.method === "POST") return { row: relation("M1", "pending", "user_request") };
      return { rows: [] };
    });
    const wrapper = mount(MyOrganizationPage);
    await flushPromises();

    await wrapper.get('[data-field="organization-search"]').setValue("实验");
    await wrapper.get('[data-action="search-organizations"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("实验学校");

    await wrapper.get('[data-action="request-organization-O1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/me/organization-requests", expect.objectContaining({
      method: "POST", body: JSON.stringify({ organizationId: "O1", note: "" })
    }));
    expect(wrapper.text()).toContain("已提交");
  });

  it("让用户接受或拒绝本人收到的组织邀请", async () => {
    const invitation = relation("M-invite", "pending", "organization_invite", otherOrganization);
    let loadCount = 0;
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/organization-relations") {
        loadCount += 1;
        return loadCount === 1
          ? { active: [], requests: [], invitations: [invitation] }
          : { active: [relation("M-invite", "active", "organization_invite", otherOrganization)], requests: [], invitations: [] };
      }
      if (path === "/api/me/organization-relations/M-invite" && options?.method === "PATCH") return { row: relation("M-invite", "active", "organization_invite", otherOrganization) };
      return { rows: [] };
    });
    const wrapper = mount(MyOrganizationPage);
    await flushPromises();

    await wrapper.get('[data-action="accept-organization-invitation-M-invite"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/me/organization-relations/M-invite", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ action: "accept" })
    }));
    expect(wrapper.emitted("organization-changed")).toHaveLength(1);
    expect(wrapper.text()).toContain("已加入组织");
    expect(wrapper.text()).toContain("航空少年宫");

    const rejectInvitation = relation("M-reject", "pending", "organization_invite");
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/organization-relations") return { active: [], requests: [], invitations: [rejectInvitation] };
      if (path === "/api/me/organization-relations/M-reject" && options?.method === "PATCH") return { row: relation("M-reject", "rejected", "organization_invite") };
      return { rows: [] };
    });
    const rejected = mount(MyOrganizationPage);
    await flushPromises();
    await rejected.get('[data-action="reject-organization-invitation-M-reject"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/me/organization-relations/M-reject", expect.objectContaining({ body: JSON.stringify({ action: "reject" }) }));
  });

  it("允许撤回待处理的个人申请", async () => {
    const request = relation("M-request", "pending", "user_request");
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/organization-relations") return { active: [], requests: [request], invitations: [] };
      if (path === "/api/me/organization-relations/M-request" && options?.method === "PATCH") return { row: relation("M-request", "rejected", "user_request") };
      return { rows: [] };
    });
    const wrapper = mount(MyOrganizationPage);
    await flushPromises();

    await wrapper.get('[data-action="withdraw-organization-request-M-request"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/me/organization-relations/M-request", expect.objectContaining({ body: JSON.stringify({ action: "withdraw" }) }));
  });

  it("确认后退出已加入组织并提示历史记录保留", async () => {
    const active = relation("M-active", "active", "organization_invite");
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/me/organization-relations") return { active: [active], requests: [], invitations: [] };
      if (path === "/api/me/organization-relations/M-active" && options?.method === "PATCH") return { row: relation("M-active", "removed", "organization_invite") };
      return { rows: [] };
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(MyOrganizationPage);
    await flushPromises();

    expect(wrapper.text()).toContain("实验学校");
    await wrapper.get('[data-action="leave-organization-M-active"]').trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith("确认退出该组织？历史报名、成绩和证书不会删除。");
    expect(apiMock).toHaveBeenCalledWith("/api/me/organization-relations/M-active", expect.objectContaining({ body: JSON.stringify({ action: "leave" }) }));
    confirm.mockRestore();
  });

  it("接口失败时保留搜索输入并显示错误信息", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organization-relations") return { active: [], requests: [], invitations: [] };
      if (path === "/api/organizations/search?q=%E5%AE%9E%E9%AA%8C") throw new Error("组织搜索暂不可用");
      return { rows: [] };
    });
    const wrapper = mount(MyOrganizationPage);
    await flushPromises();

    await wrapper.get('[data-field="organization-search"]').setValue("实验");
    await wrapper.get('[data-action="search-organizations"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-field="organization-search"]').element.value).toBe("实验");
    expect(wrapper.text()).toContain("组织搜索暂不可用");
    expect(wrapper.emitted("error")).toEqual([["组织搜索暂不可用"]]);
  });

  it("页面重新获得焦点时刷新后来收到的组织邀请", async () => {
    const invitation = relation("M-focus-invite", "pending", "organization_invite", otherOrganization);
    let relationLoads = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organization-relations") {
        relationLoads += 1;
        return relationLoads === 1
          ? { active: [], requests: [], invitations: [] }
          : { active: [], requests: [], invitations: [invitation] };
      }
      return { rows: [] };
    });

    const wrapper = mount(MyOrganizationPage);
    await flushPromises();
    expect(wrapper.find('[data-action="accept-organization-invitation-M-focus-invite"]').exists()).toBe(false);

    window.dispatchEvent(new Event("focus"));
    await flushPromises();

    expect(wrapper.find('[data-action="accept-organization-invitation-M-focus-invite"]').exists()).toBe(true);
    expect(relationLoads).toBe(2);
    wrapper.unmount();
  });

  it("把待确认邀请显示在组织搜索之前", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organization-relations") {
        return {
          active: [],
          requests: [],
          invitations: [relation("M-priority", "pending", "organization_invite", otherOrganization)]
        };
      }
      return { rows: [] };
    });

    const wrapper = mount(MyOrganizationPage);
    await flushPromises();
    const invitationSection = wrapper.get('[data-action="accept-organization-invitation-M-priority"]').element.closest(".relation-status-list");
    const searchForm = wrapper.get(".organization-search-form").element;

    expect(invitationSection.compareDocumentPosition(searchForm) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("允许用户手动刷新组织关系", async () => {
    const invitation = relation("M-manual-refresh", "pending", "organization_invite", otherOrganization);
    let relationLoads = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/me/organization-relations") {
        relationLoads += 1;
        return relationLoads === 1
          ? { active: [], requests: [], invitations: [] }
          : { active: [], requests: [], invitations: [invitation] };
      }
      return { rows: [] };
    });

    const wrapper = mount(MyOrganizationPage);
    await flushPromises();
    await wrapper.get('[data-action="refresh-organization-relations"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-action="accept-organization-invitation-M-manual-refresh"]').exists()).toBe(true);
  });
});
