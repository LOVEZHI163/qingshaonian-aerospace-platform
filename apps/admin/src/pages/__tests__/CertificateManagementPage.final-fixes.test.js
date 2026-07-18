import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: apiMock,
  apiBlob: apiBlobMock,
  apiUrl: (path) => path
}));

import CertificateManagementPage from "../CertificateManagementPage.vue";

const event = { id: "E1", name: "青少年航空赛", isCurrent: true };
const project = { id: "P1", eventId: "E1", name: "纸飞机", allowedGroups: ["小学低段"] };
const registration = {
  id: "R1",
  eventId: "E1",
  group: "小学低段",
  projectId: "P1",
  projectName: "纸飞机",
  status: "approved",
  athlete: { name: "张三", school: "实验小学" }
};
const draftCertificate = {
  id: "C-draft",
  registrationId: "R1",
  slot: 1,
  title: "未发布证书",
  status: "draft",
  fileName: "draft.pdf",
  registration,
  athlete: registration.athlete,
  projectName: registration.projectName
};
const publishedCertificate = {
  ...draftCertificate,
  id: "C-published",
  slot: 2,
  title: "已发布证书",
  status: "published",
  fileName: "published.pdf"
};

function isRegistrationRequest(path) {
  return path === "/api/admin/registrations?pageSize=100" || path.startsWith("/api/admin/registrations?eventId=");
}

function isCertificateRequest(path) {
  return path === "/api/admin/certificates" || path.startsWith("/api/admin/certificates?");
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function standardResponse(certificates = [draftCertificate, publishedCertificate]) {
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path === "/api/admin/events") return { rows: [event], projects: [project] };
    if (isRegistrationRequest(path)) return { rows: [registration], total: 1, page: 1, pageSize: 100 };
    if (isCertificateRequest(path)) return { rows: certificates, total: certificates.length, page: 1, pageSize: 20 };
    if (path === "/api/admin/certificate-imports?eventId=E1") return { rows: [] };
    if (path === "/api/admin/certificates/bulk-status" && options.method === "POST") return { rows: [] };
    return {};
  });
}

describe("CertificateManagementPage final fixes", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiBlobMock.mockResolvedValue(new Blob(["file"]));
    standardResponse();
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("按状态锁定批量选择：草稿可发布、已发布可撤回，不能混选", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    const checkboxes = wrapper.findAll('[data-certificate-select]');
    await checkboxes[0].setValue(true);
    expect(checkboxes[1].attributes()).toHaveProperty("disabled");
    expect(wrapper.get('[data-action="bulk-publish"]').exists()).toBe(true);

    await checkboxes[0].setValue(false);
    expect(checkboxes[1].attributes()).not.toHaveProperty("disabled");
    await checkboxes[1].setValue(true);
    expect(wrapper.get('[data-action="bulk-withdraw"]').exists()).toBe(true);
    await wrapper.get('[data-action="bulk-withdraw"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/certificates/bulk-status", {
      method: "POST",
      body: JSON.stringify({ ids: ["C-published"], status: "draft" })
    });
    expect(wrapper.get(".bulk-actions").text()).toContain("已选 0 张");
  });

  it("较晚返回的旧证书列表不能覆盖较新的整页刷新", async () => {
    const stale = deferred();
    const fresh = deferred();
    let certificateCalls = 0;
    apiMock.mockImplementation((path) => {
      if (path === "/api/admin/events") return Promise.resolve({ rows: [event], projects: [project] });
      if (isRegistrationRequest(path)) return Promise.resolve({ rows: [registration], total: 1, page: 1, pageSize: 100 });
      if (isCertificateRequest(path)) {
        certificateCalls += 1;
        return certificateCalls === 1 ? stale.promise : fresh.promise;
      }
      if (path === "/api/admin/certificate-imports?eventId=E1") return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    const reload = wrapper.vm.loadCertificateList || wrapper.vm.$?.setupState?.loadCertificateList;
    expect(typeof reload).toBe("function");
    const newestRefresh = reload();
    await flushPromises();

    fresh.resolve({
      rows: [{ ...draftCertificate, title: "最新证书" }],
      total: 1,
      page: 1,
      pageSize: 20
    });
    await newestRefresh;
    await flushPromises();
    stale.resolve({
      rows: [{ ...draftCertificate, title: "过期证书" }],
      total: 1,
      page: 1,
      pageSize: 20
    });
    await flushPromises();

    expect(wrapper.text()).toContain("最新证书");
    expect(wrapper.text()).not.toContain("过期证书");
  });

  it("使用服务端分页，并在筛选变化后回到第 1 页", async () => {
    const certificatePaths = [];
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (isRegistrationRequest(path)) return { rows: [registration], total: 1, page: 1, pageSize: 100 };
      if (isCertificateRequest(path)) {
        certificatePaths.push(path);
        const params = new URL(path, "http://admin.local").searchParams;
        const page = Number(params.get("page") || "1");
        return {
          rows: [{ ...draftCertificate, id: `C-${page}`, title: `第 ${page} 页证书` }],
          total: 40,
          page,
          pageSize: 20
        };
      }
      if (path === "/api/admin/certificate-imports?eventId=E1") return { rows: [] };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    await wrapper.get('[data-action="certificate-next-page"]').trigger("click");
    await flushPromises();
    expect(certificatePaths.some((path) => new URL(path, "http://admin.local").searchParams.get("page") === "2")).toBe(true);

    await wrapper.findAll(".certificate-filter-grid select")[1].setValue("draft");
    await flushPromises();
    const listRequestPaths = certificatePaths.filter((path) => !new URL(path, "http://admin.local").searchParams.has("registrationId"));
    const lastRequest = new URL(listRequestPaths.at(-1), "http://admin.local").searchParams;
    expect(lastRequest.get("page")).toBe("1");
    expect(lastRequest.get("status")).toBe("draft");
  });
});
