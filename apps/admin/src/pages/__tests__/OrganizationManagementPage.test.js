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
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path === "/api/admin/organizations" && !options.method) return { rows: [organization] };
    if (path === "/api/admin/organizations/O1/review") return { organization: { ...organization, reviewStatus: JSON.parse(options.body).status } };
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
});
