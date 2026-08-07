import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));

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
    const wrapper = mount(OrganizationLeadersPage);
    await flushPromises();

    expect(wrapper.text()).toContain("张老师");
    expect(wrapper.text()).toContain("已驳回");
    expect(wrapper.text()).toContain("授权书缺少盖章");
    expect(wrapper.text()).toContain("姓名、手机或授权书变化会重新审核");
    expect(wrapper.text()).toContain("邮箱、备注变化不会影响已通过状态");
    expect(wrapper.text()).toContain("只要仍有其他已通过且启用的领队，报名不受影响");

    await wrapper.get('[data-action="history-OL-1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/organization/leaders/OL-1/reviews");
    expect(wrapper.get('[data-testid="leader-review-history"]').text()).toContain("提交审核");
    expect(wrapper.get('[data-testid="leader-review-history"]').text()).toContain("授权书缺少盖章");
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
});
