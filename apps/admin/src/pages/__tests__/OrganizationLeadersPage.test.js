import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    constructor(message, { code = "" } = {}) { super(message); this.name = "ApiError"; this.code = code; }
  }
  return { apiMock: vi.fn(), apiBlobMock: vi.fn(), ApiErrorMock };
});
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, ApiError: ApiErrorMock }));

import OrganizationLeadersPage from "../OrganizationLeadersPage.vue";

const rejectedLeader = {
  id: "OL-1",
  organizationId: "O1",
  name: "张老师",
  phone: "13800000001",
  email: "zhang@example.com",
  notes: "负责现场联络",
  reviewStatus: "rejected",
  rejectionReason: "授权书缺少盖章",
  enabled: true,
  currentDocumentId: "OLD-1",
  document: {
    id: "OLD-1",
    originalName: "授权书.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048
  }
};
const approvedLeader = {
  ...rejectedLeader,
  id: "OL-APPROVED",
  name: "李老师",
  reviewStatus: "approved",
  rejectionReason: "",
  enabled: true
};

function installApi() {
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path === "/api/organization/leaders" && !options.method) return { rows: [rejectedLeader] };
    if (path === "/api/organization/leaders" && options.method === "POST") {
      return { row: { ...rejectedLeader, id: "OL-2", reviewStatus: "pending", rejectionReason: "", enabled: true } };
    }
    if (path === "/api/organization/leaders/OL-1" && options.method === "PATCH") {
      return { row: { ...rejectedLeader, email: "new@example.com", notes: "新备注" } };
    }
    if (path === "/api/organization/leaders/OL-1/enabled") {
      return { row: { ...rejectedLeader, enabled: false } };
    }
    if (path === "/api/organization/leaders/OL-1/reviews") {
      return {
        rows: [
          { id: "R1", action: "submitted", reason: "", createdAt: "2026-08-01T08:00:00.000Z" },
          { id: "R2", action: "rejected", reason: "授权书缺少盖章", createdAt: "2026-08-02T08:00:00.000Z" }
        ]
      };
    }
    return { rows: [] };
  });
}

function attachFile(wrapper, selector, file) {
  const input = wrapper.get(selector);
  Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
  return input.trigger("change");
}

describe("OrganizationLeadersPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    apiMock.mockReset();
    apiBlobMock.mockReset();
    installApi();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:download") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("shows leader status, rejection reason, review history and modification guidance", async () => {
    const wrapper = mount(OrganizationLeadersPage, { attachTo: document.body });
    await flushPromises();

    expect(wrapper.text()).toContain("张老师");
    expect(wrapper.text()).toContain("已驳回");
    expect(wrapper.text()).toContain("授权书缺少盖章");
    expect(wrapper.text()).toContain("姓名、手机或授权书变化会重新审核");
    expect(wrapper.text()).toContain("邮箱、备注变化不会影响已通过状态");
    expect(wrapper.text()).toContain("只要仍有其他已通过且启用的领队，报名不受影响");

    const opener = wrapper.get('[data-action="history-OL-1"]');
    opener.element.focus();
    await opener.trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/leaders/OL-1/reviews");
    const dialog = wrapper.get('[data-testid="leader-review-history"]');
    expect(dialog.attributes("role")).toBe("dialog");
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-labelledby")).toBe("organization-leader-history-title");
    expect(wrapper.get("#organization-leader-history-title").text()).toContain("张老师");
    expect(dialog.text()).toContain("提交审核");
    expect(dialog.text()).toContain("授权书缺少盖章");
    const close = wrapper.get('[data-action="close-history"]');
    expect(document.activeElement).toBe(close.element);
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.find('[data-testid="leader-review-history"]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener.element);
    wrapper.unmount();
  });

  it("summarizes the approved and enabled leader count and current registration eligibility", async () => {
    apiMock.mockResolvedValueOnce({ rows: [rejectedLeader, approvedLeader] });
    const wrapper = mount(OrganizationLeadersPage);
    await flushPromises();
    expect(wrapper.get('[data-testid="leader-eligibility-summary"]').text()).toContain("已有 1 名有效领队，可正常报名");
  });

  it("maps unknown loading failures to Chinese while preserving trusted API business errors", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const wrapper = mount(OrganizationLeadersPage);
    await flushPromises();
    expect(wrapper.text()).toContain("领队资料加载失败，请稍后重试");
    expect(wrapper.text()).not.toContain("Failed to fetch");
    wrapper.unmount();

    apiMock.mockRejectedValueOnce(new ApiErrorMock("组织访问权限已发生变化"));
    const trusted = mount(OrganizationLeadersPage);
    await flushPromises();
    expect(trusted.text()).toContain("组织访问权限已发生变化");
  });

  it("downloads a prefilled DOCX and submits all leader fields with an authorization file", async () => {
    apiBlobMock.mockResolvedValue(new Blob(["docx"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    const wrapper = mount(OrganizationLeadersPage);
    await flushPromises();

    await wrapper.get('[data-testid="leader-name"]').setValue("李老师");
    await wrapper.get('[data-testid="leader-phone"]').setValue("13900000002");
    await wrapper.get('[data-testid="leader-email"]').setValue("li@example.com");
    await wrapper.get('[data-testid="leader-notes"]').setValue("负责资料核对");
    await wrapper.get('[data-action="download-template"]').trigger("click");
    await flushPromises();

    expect(apiBlobMock).toHaveBeenCalledWith("/api/organization/leaders/authorization-template.docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "李老师", phone: "13900000002" })
    });

    const file = new File(["pdf"], "leader.pdf", { type: "application/pdf" });
    await attachFile(wrapper, '[data-testid="leader-authorization"]', file);
    await wrapper.get('[data-testid="leader-form"]').trigger("submit");
    await flushPromises();

    const [, options] = apiMock.mock.calls.find(([path, request]) => path === "/api/organization/leaders" && request?.method === "POST");
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get("name")).toBe("李老师");
    expect(options.body.get("phone")).toBe("13900000002");
    expect(options.body.get("email")).toBe("li@example.com");
    expect(options.body.get("notes")).toBe("负责资料核对");
    expect(options.body.get("authorization").name).toBe("leader.pdf");
    expect(wrapper.text()).toContain("领队资料已提交审核");
    wrapper.unmount();
  });

  it("edits optional fields without a replacement file and can disable a leader", async () => {
    const wrapper = mount(OrganizationLeadersPage);
    await flushPromises();

    await wrapper.get('[data-action="edit-OL-1"]').trigger("click");
    await wrapper.get('[data-testid="leader-email"]').setValue("new@example.com");
    await wrapper.get('[data-testid="leader-notes"]').setValue("新备注");
    await wrapper.get('[data-testid="leader-form"]').trigger("submit");
    await flushPromises();

    const [, update] = apiMock.mock.calls.find(([path, request]) => path === "/api/organization/leaders/OL-1" && request?.method === "PATCH");
    expect(update.body.get("email")).toBe("new@example.com");
    expect(update.body.get("notes")).toBe("新备注");
    expect(update.body.has("authorization")).toBe(false);

    await wrapper.get('[data-action="disable-OL-1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/leaders/OL-1/enabled", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });
    expect(wrapper.text()).toContain("已停用");
  });

  it("includes a newly selected authorization document in an edit PATCH", async () => {
    const wrapper = mount(OrganizationLeadersPage);
    await flushPromises();
    await wrapper.get('[data-action="edit-OL-1"]').trigger("click");
    await wrapper.get('[data-testid="leader-name"]').setValue("张老师（新）");
    const replacement = new File(["png"], "replacement.png", { type: "image/png" });
    await attachFile(wrapper, '[data-testid="leader-authorization"]', replacement);
    await wrapper.get('[data-testid="leader-form"]').trigger("submit");
    await flushPromises();

    const [, update] = apiMock.mock.calls.find(([path, request]) => path === "/api/organization/leaders/OL-1" && request?.method === "PATCH");
    expect(update.body.get("name")).toBe("张老师（新）");
    expect(update.body.get("authorization").name).toBe("replacement.png");
  });

  it("does not expose an unknown upload failure", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/organization/leaders" && !options.method) return { rows: [] };
      if (path === "/api/organization/leaders" && options.method === "POST") throw new Error("Failed to fetch");
      return { rows: [] };
    });
    const wrapper = mount(OrganizationLeadersPage);
    await flushPromises();
    await wrapper.get('[data-testid="leader-name"]').setValue("李老师");
    await wrapper.get('[data-testid="leader-phone"]').setValue("13900000002");
    await attachFile(wrapper, '[data-testid="leader-authorization"]', new File(["pdf"], "leader.pdf", { type: "application/pdf" }));
    await wrapper.get('[data-testid="leader-form"]').trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("领队资料提交失败，请稍后重试");
    expect(wrapper.text()).not.toContain("Failed to fetch");
  });

  it("branches on stable authorization codes instead of backend message text", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/organization/leaders" && !options.method) return { rows: [] };
      if (path === "/api/organization/leaders" && options.method === "POST") {
        throw new ApiErrorMock("English backend text", { code: "LEADER_AUTHORIZATION_REQUIRED" });
      }
      return { rows: [] };
    });
    const wrapper = mount(OrganizationLeadersPage);
    await flushPromises();
    await wrapper.get('[data-testid="leader-name"]').setValue("李老师");
    await wrapper.get('[data-testid="leader-phone"]').setValue("13900000002");
    await attachFile(wrapper, '[data-testid="leader-authorization"]', new File(["pdf"], "leader.pdf", { type: "application/pdf" }));
    await wrapper.get('[data-testid="leader-form"]').trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("请上传领队授权书后再提交");
    expect(wrapper.text()).not.toContain("English backend text");
  });
});
