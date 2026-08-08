import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, apiUrl: (path) => path }));

import OrganizationManagementPage from "../OrganizationManagementPage.vue";

const organization = {
  id: "O1", name: "航空少年宫", creditCode: "913301001234567890", ownerUserId: "U1",
  reviewStatus: "pending", status: "active", createdAt: "2026-07-01T00:00:00.000Z",
  documents: [{ id: "D1", originalName: "license.pdf", mimeType: "application/pdf", sizeBytes: 1024, isCurrent: true }]
};

function mockOrganizations() {
  let mustChangePassword = false;
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path === "/api/admin/organizations" && !options.method) return { rows: [organization] };
    if (path === "/api/users") return { rows: [{ id: "U1", name: "负责人", phone: "13800000001", mustChangePassword }] };
    if (path === "/api/admin/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
    if (path === "/api/admin/organizations/O1/review") return { organization: { ...organization, reviewStatus: JSON.parse(options.body).status } };
    if (path === "/api/admin/users/U1/reset-password") {
      mustChangePassword = true;
      return { user: { id: "U1", mustChangePassword: true }, temporaryPassword: "GeneratedPass2" };
    }
    if (path === "/api/admin/users/U1/temporary-password") return { temporaryPassword: "GeneratedPass2" };
    if (path === "/api/admin/organizations/O1" && options.method === "DELETE") return { ok: true };
    return { rows: [] };
  });
}

function deferred() {
  let resolve;
  let reject;
  return { promise: new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; }), resolve, reject };
}

describe("OrganizationManagementPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    apiMock.mockReset();
    apiBlobMock.mockReset();
    mockOrganizations();
  });

  it("loads pending organizations and approves the selected organization", async () => {
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    expect(wrapper.text()).toContain("航空少年宫");

    await wrapper.get('[data-action="approve-O1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organizations/O1/review", {
      method: "PATCH", body: JSON.stringify({ status: "approved", reason: "" })
    });
  });

  it("collects a rejection reason in an in-page dialog instead of window.prompt", async () => {
    const prompt = vi.spyOn(window, "prompt");
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="reject-O1"]').trigger("click");
    await wrapper.get('[data-testid="reject-reason"]').setValue("请补充有效资质");
    await wrapper.get("form.organization-dialog").trigger("submit");
    await flushPromises();

    expect(prompt).not.toHaveBeenCalled();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organizations/O1/review", {
      method: "PATCH", body: JSON.stringify({ status: "rejected", reason: "请补充有效资质" })
    });
  });

  it("updates organization status without changing the owner account", async () => {
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="disable-O1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organizations/O1/status", {
      method: "PATCH", body: JSON.stringify({ status: "disabled" })
    });
  });

  it("generates a copyable temporary password and reopens it through the read endpoint", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();

    await wrapper.get('[data-action="reset-password-O1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/users/U1/reset-password", { method: "POST", body: "{}", cache: "no-store" });
    expect(wrapper.get('[data-testid="temporary-password-dialog"]').text()).toContain("GeneratedPass2");
    await wrapper.get('[data-action="copy-temporary-password"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("GeneratedPass2");
    await wrapper.get('[data-action="close-temporary-password"]').trigger("click");

    await wrapper.get('[data-action="view-temporary-password-O1"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/users/U1/temporary-password", { cache: "no-store" });
    expect(wrapper.get('[data-testid="temporary-password-dialog"]').text()).toContain("GeneratedPass2");
  });

  it("deletes an organization only after a yes-or-no retained-history confirmation", async () => {
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="delete-O1"]').trigger("click");

    const dialog = wrapper.get('[data-testid="delete-organization-dialog"]');
    expect(dialog.text()).toContain("负责人账号、组织资料、成员关系和资质将删除");
    expect(dialog.text()).toContain("历史报名、成绩和证书保留组织名称快照");
    expect(dialog.text()).toContain("操作不可恢复");
    await dialog.get('[data-action="cancel-delete-organization"]').trigger("click");
    expect(apiMock).not.toHaveBeenCalledWith("/api/admin/organizations/O1", expect.anything());

    await wrapper.get('[data-action="delete-O1"]').trigger("click");
    await wrapper.get('[data-action="confirm-delete-organization"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/organizations/O1", { method: "DELETE" });
  });

  it("previews a credential through an authenticated blob and revokes it on close", async () => {
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:credential");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    apiBlobMock.mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="preview-O1"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/organizations/O1/credential/D1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(wrapper.get('[data-testid="credential-preview"]').attributes("src")).toBe("blob:credential");
    await wrapper.get('[data-action="close-preview"]').trigger("click");
    expect(revoke).toHaveBeenCalledWith("blob:credential");
  });

  it("revokes a late credential URL when the preview closes before its request resolves", async () => {
    const request = deferred();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    apiBlobMock.mockReturnValue(request.promise);
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="preview-O1"]').trigger("click");
    await wrapper.get('[data-action="close-preview"]').trigger("click");
    request.resolve(new Blob(["late"], { type: "application/pdf" }));
    await flushPromises();

    expect(wrapper.find('[data-testid="credential-preview"]').exists()).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:late");
  });

  it("keeps only the newest credential preview when earlier requests resolve later", async () => {
    const first = deferred();
    const second = deferred();
    vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:new").mockReturnValueOnce("blob:old");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    apiBlobMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="preview-O1"]').trigger("click");
    await wrapper.get('[data-action="preview-O1"]').trigger("click");
    second.resolve(new Blob(["new"], { type: "application/pdf" }));
    await flushPromises();
    first.resolve(new Blob(["old"], { type: "application/pdf" }));
    await flushPromises();

    expect(wrapper.get('[data-testid="credential-preview"]').attributes("src")).toBe("blob:new");
    expect(revoke).toHaveBeenCalledWith("blob:old");
  });

  it("cancels pending previews on unmount and ignores AbortError", async () => {
    const request = deferred();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    apiBlobMock.mockReturnValue(request.promise);
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="preview-O1"]').trigger("click");
    wrapper.unmount();
    request.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    await flushPromises();

    expect(revoke).not.toHaveBeenCalled();
  });

  it("allows credential cleanup only from a disabled organization detail with exact-name confirmation", async () => {
    const disabled = { ...organization, status: "disabled", reviewStatus: "approved" };
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/organizations" && !options.method) return { rows: [disabled] };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
      if (path === "/api/users") return { rows: [] };
      if (path === "/api/admin/organizations/O1/credential-cleanup") return { deletedFiles: 1, failedFiles: [] };
      return { rows: [] };
    });
    const wrapper = mount(OrganizationManagementPage);
    await flushPromises();
    await wrapper.get("button.mini").trigger("click");
    await wrapper.get('[data-action="open-credential-cleanup"]').trigger("click");
    await wrapper.get('[data-testid="danger-confirm-name"]').setValue(disabled.name);
    await wrapper.get('[data-action="confirm-danger"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/organizations/O1/credential-cleanup", {
      method: "POST",
      body: JSON.stringify({ confirmName: disabled.name })
    });
  });
});
