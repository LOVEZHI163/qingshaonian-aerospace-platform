import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    constructor(message, { code = "" } = {}) { super(message); this.name = "ApiError"; this.code = code; }
  }
  return { apiMock: vi.fn(), apiBlobMock: vi.fn(), ApiErrorMock };
});
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, ApiError: ApiErrorMock }));

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
  submissionVersion: 3,
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

  it("filters leaders by organization, status and normalized keyword while displaying submission versions", async () => {
    const wrapper = mount(AdminLeaderReviewPage);
    await flushPromises();
    expect(wrapper.text()).toContain("温州市实验小学");
    expect(wrapper.text()).toContain("王老师");
    expect(wrapper.text()).toContain("第 3 版");

    await wrapper.get('[data-testid="organization-filter"]').setValue("O9");
    await wrapper.get('[data-testid="status-filter"]').setValue("pending");
    await wrapper.get('[data-testid="keyword-filter"]').setValue(" 温州 市 ");
    await wrapper.get('[data-testid="leader-filter-form"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/organization-leaders?organizationId=O9&reviewStatus=pending&q=%E6%B8%A9%E5%B7%9E+%E5%B8%82");
  });

  it("previews, downloads and closes a protected authorization document", async () => {
    const wrapper = mount(AdminLeaderReviewPage, { attachTo: document.body });
    await flushPromises();

    const opener = wrapper.get('[data-action="preview-OL-9"]');
    opener.element.focus();
    await opener.trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/organization/leaders/OL-9/authorization/OLD-9", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const dialog = wrapper.get('[data-testid="leader-document-dialog"]');
    expect(dialog.attributes("role")).toBe("dialog");
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-labelledby")).toBe("admin-leader-preview-title");
    expect(document.activeElement).toBe(wrapper.get('[data-action="close-preview"]').element);
    expect(wrapper.get('[data-testid="leader-document-preview"]').attributes("src")).toBe("blob:leader");
    expect(wrapper.get('[data-testid="leader-document-preview"]').attributes("title")).toBe("王老师的授权书预览");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(document.activeElement).toBe(opener.element);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:leader");

    await wrapper.get('[data-action="download-OL-9"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenLastCalledWith("/api/organization/leaders/OL-9/authorization/OLD-9");
    wrapper.unmount();
  });

  it("loads review history and approves or disables a leader", async () => {
    const wrapper = mount(AdminLeaderReviewPage, { attachTo: document.body });
    await flushPromises();

    const historyOpener = wrapper.get('[data-action="history-OL-9"]');
    historyOpener.element.focus();
    await historyOpener.trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/leaders/OL-9/reviews");
    const historyDialog = wrapper.get('[data-testid="leader-review-history"]');
    expect(historyDialog.attributes("role")).toBe("dialog");
    expect(historyDialog.attributes("aria-labelledby")).toBe("admin-leader-history-title");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(document.activeElement).toBe(historyOpener.element);

    await wrapper.get('[data-action="approve-OL-9"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organization-leaders/OL-9/review", {
      method: "PATCH",
      body: JSON.stringify({ decision: "approved", reason: "", submissionVersion: 3 })
    });

    await wrapper.get('[data-action="disable-OL-9"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organization-leaders/OL-9/enabled", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });
    wrapper.unmount();
  });

  it("does not submit a rejection without a reason", async () => {
    const wrapper = mount(AdminLeaderReviewPage, { attachTo: document.body });
    await flushPromises();
    const opener = wrapper.get('[data-action="reject-OL-9"]');
    opener.element.focus();
    await opener.trigger("click");
    const dialog = wrapper.get('[data-testid="reject-form"]');
    expect(dialog.attributes("role")).toBe("dialog");
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-labelledby")).toBe("admin-leader-reject-title");
    expect(document.activeElement).toBe(wrapper.get('[data-testid="reject-reason"]').element);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.find('[data-testid="reject-form"]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener.element);

    await opener.trigger("click");
    await wrapper.get('[data-testid="reject-form"]').trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-testid="reject-error"]').text()).toContain("请填写驳回原因");
    expect(apiMock.mock.calls.some(([path, options]) => path.endsWith("/OL-9/review") && options?.body?.includes("rejected"))).toBe(false);

    await wrapper.get('[data-testid="reject-reason"]').setValue("授权书缺少公章");
    await wrapper.get('[data-testid="reject-form"]').trigger("submit");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organization-leaders/OL-9/review", {
      method: "PATCH",
      body: JSON.stringify({ decision: "rejected", reason: "授权书缺少公章", submissionVersion: 3 })
    });
    wrapper.unmount();
  });

  it("maps unknown list and review failures to operation-specific Chinese messages", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const wrapper = mount(AdminLeaderReviewPage);
    await flushPromises();
    expect(wrapper.text()).toContain("领队审核列表加载失败，请稍后重试");
    expect(wrapper.text()).not.toContain("Failed to fetch");
    wrapper.unmount();

    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/organization-leaders" && !options.method) return { rows: [pendingLeader] };
      if (path === "/api/admin/organization-leaders/OL-9/review") throw new Error("Network request failed");
      return { rows: [] };
    });
    const reviewPage = mount(AdminLeaderReviewPage);
    await flushPromises();
    await reviewPage.get('[data-action="approve-OL-9"]').trigger("click");
    await flushPromises();
    expect(reviewPage.text()).toContain("领队审核失败，请稍后重试");
    expect(reviewPage.text()).not.toContain("Network request failed");
  });

  it("branches on stable pending-review codes instead of backend message text", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/organization-leaders" && !options.method) return { rows: [pendingLeader] };
      if (path === "/api/admin/organization-leaders/OL-9/review") {
        throw new ApiErrorMock("English backend text", { code: "LEADER_REVIEW_PENDING" });
      }
      return { rows: [] };
    });
    const wrapper = mount(AdminLeaderReviewPage);
    await flushPromises();
    await wrapper.get('[data-action="approve-OL-9"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("领队资料已更新，请刷新后重新审核");
    expect(wrapper.text()).not.toContain("English backend text");
  });
});
