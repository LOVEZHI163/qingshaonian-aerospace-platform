import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));

import AdminLeaderReviewPage from "../AdminLeaderReviewPage.vue";

const pendingLeader = {
  id: "OL-9",
  organizationId: "O9",
  organization: { id: "O9", name: "温州市实验小学" },
  name: "王老师",
  phone: "13800000009",
  email: "wang@example.com",
  notes: "总领队",
  reviewStatus: "pending",
  rejectionReason: "",
  enabled: true,
  document: { id: "OLD-9", originalName: "授权书.pdf", mimeType: "application/pdf", sizeBytes: 4096 }
};

function installApi() {
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path.startsWith("/api/admin/organization-leaders") && !options.method) return { rows: [pendingLeader] };
    if (path === "/api/organization/leaders/OL-9/reviews") {
      return { rows: [{ id: "R9", action: "submitted", reason: "", createdAt: "2026-08-03T08:00:00.000Z" }] };
    }
    if (path === "/api/admin/organization-leaders/OL-9/review") {
      const body = JSON.parse(options.body);
      return { row: { ...pendingLeader, reviewStatus: body.decision, rejectionReason: body.reason } };
    }
    if (path === "/api/admin/organization-leaders/OL-9/enabled") {
      return { row: { ...pendingLeader, enabled: false } };
    }
    return { rows: [] };
  });
}

describe("AdminLeaderReviewPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    apiMock.mockReset();
    apiBlobMock.mockReset();
    installApi();
    apiBlobMock.mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:leader") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("filters leaders by organization and status through the platform API", async () => {
    const wrapper = mount(AdminLeaderReviewPage);
    await flushPromises();
    expect(wrapper.text()).toContain("温州市实验小学");
    expect(wrapper.text()).toContain("王老师");

    await wrapper.get('[data-testid="organization-filter"]').setValue("O9");
    await wrapper.get('[data-testid="status-filter"]').setValue("pending");
    await wrapper.get('[data-testid="leader-filter-form"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/organization-leaders?organizationId=O9&reviewStatus=pending");
  });

  it("previews, downloads and closes a protected authorization document", async () => {
    const wrapper = mount(AdminLeaderReviewPage);
    await flushPromises();

    await wrapper.get('[data-action="preview-OL-9"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/organization/leaders/OL-9/authorization/OLD-9", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(wrapper.get('[data-testid="leader-document-preview"]').attributes("src")).toBe("blob:leader");
    await wrapper.get('[data-action="close-preview"]').trigger("click");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:leader");

    await wrapper.get('[data-action="download-OL-9"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenLastCalledWith("/api/organization/leaders/OL-9/authorization/OLD-9");
    wrapper.unmount();
  });

  it("loads review history and approves or disables a leader", async () => {
    const wrapper = mount(AdminLeaderReviewPage);
    await flushPromises();

    await wrapper.get('[data-action="history-OL-9"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/leaders/OL-9/reviews");
    expect(wrapper.get('[data-testid="leader-review-history"]').text()).toContain("提交审核");
    await wrapper.get('[data-action="close-history"]').trigger("click");

    await wrapper.get('[data-action="approve-OL-9"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organization-leaders/OL-9/review", {
      method: "PATCH",
      body: JSON.stringify({ decision: "approved", reason: "" })
    });

    await wrapper.get('[data-action="disable-OL-9"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organization-leaders/OL-9/enabled", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });
  });

  it("does not submit a rejection without a reason", async () => {
    const wrapper = mount(AdminLeaderReviewPage);
    await flushPromises();
    await wrapper.get('[data-action="reject-OL-9"]').trigger("click");
    await wrapper.get('[data-testid="reject-form"]').trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-testid="reject-error"]').text()).toContain("请填写驳回原因");
    expect(apiMock.mock.calls.some(([path, options]) => path.endsWith("/OL-9/review") && options?.body?.includes("rejected"))).toBe(false);

    await wrapper.get('[data-testid="reject-reason"]').setValue("授权书缺少公章");
    await wrapper.get('[data-testid="reject-form"]').trigger("submit");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organization-leaders/OL-9/review", {
      method: "PATCH",
      body: JSON.stringify({ decision: "rejected", reason: "授权书缺少公章" })
    });
  });
});
