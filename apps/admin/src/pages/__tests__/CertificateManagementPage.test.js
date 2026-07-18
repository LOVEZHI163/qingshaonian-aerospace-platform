import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: apiMock,
  apiBlob: apiBlobMock,
  apiUrl: (path) => path
}));

import CertificateImportPanel from "../../components/CertificateImportPanel.vue";
import ManualCertificateEntryPanel from "../../components/ManualCertificateEntryPanel.vue";
import CertificateManagementPage from "../CertificateManagementPage.vue";

const event = { id: "E1", name: "2026 青少年航空赛", isCurrent: true };
const eventTwo = { id: "E2", name: "2027 青少年航空赛", isCurrent: false };
const project = { id: "P1", eventId: "E1", name: "纸飞机", allowedGroups: ["小学低段"] };
const projectTwo = { id: "P2", eventId: "E2", name: "橡筋飞机", allowedGroups: ["中学组"] };
const registration = {
  id: "R1",
  eventId: "E1",
  group: "小学低段",
  projectId: "P1",
  projectName: "纸飞机",
  status: "approved",
  awardName: "二等奖",
  rank: "2",
  score: "96",
  athlete: { name: "张三", school: "实验小学", grade: "三年级" }
};
const certificateOne = {
  id: "C1",
  registrationId: "R1",
  slot: 1,
  title: "一等奖证书",
  status: "draft",
  fileName: "first.png",
  previewUrl: "/returned/preview-C1",
  downloadUrl: "/returned/download-C1",
  registration,
  athlete: registration.athlete,
  projectName: registration.projectName
};
const certificateTwo = {
  ...certificateOne,
  id: "C2",
  slot: 2,
  title: "优秀选手证书",
  fileName: "second.pdf",
  previewUrl: "/returned/preview-C2",
  downloadUrl: "/returned/download-C2"
};
const preview = {
  id: "B1",
  status: "preview",
  originalName: "证书导入.xlsx",
  validCount: 1,
  errorCount: 1,
  replaceCount: 1,
  candidates: [{
    rowNumber: 2,
    registrationId: "R1",
    athleteName: "张三",
    projectName: "纸飞机",
    result: { awardName: "一等奖", rank: "1", score: "99" },
    certificates: [
      { slot: 1, title: "一等奖证书", mimeType: "image/png", replacing: true, previewUrl: "/returned/import-preview-1" },
      { slot: 2, title: "优秀选手证书", mimeType: "image/png", replacing: false, previewUrl: "/returned/import-preview-2" }
    ]
  }],
  errors: [{ rowNumber: 3, registrationId: "R-UNKNOWN", message: "报名编号不存在" }]
};

function isRegistrationRequest(path) {
  return path.startsWith("/api/admin/registrations?");
}

function isCertificateRequest(path) {
  return path === "/api/admin/certificates" || path.startsWith("/api/admin/certificates?");
}

function installApi({
  certificates = [certificateOne, certificateTwo],
  previewPayload = preview,
  eventRows = [event, eventTwo],
  projectRows = [project, projectTwo]
} = {}) {
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path === "/api/admin/events") return { rows: eventRows, projects: projectRows };
    if (isRegistrationRequest(path)) return { rows: [registration], total: 1, page: 1, pageSize: 100 };
    if (isCertificateRequest(path)) return { rows: certificates, total: certificates.length, page: 1, pageSize: 20 };
    if (path.startsWith("/api/admin/certificate-imports?eventId=")) return { rows: [] };
    if (path === "/api/admin/certificate-imports/preview" && options.method === "POST") return previewPayload;
    if (path === "/api/admin/certificate-imports/B1/commit" && options.method === "POST") {
      return { id: "B1", status: "committed", createdCount: 1, replacedCount: 1 };
    }
    if (path === "/api/admin/certificates/bulk-status" && options.method === "POST") return { rows: certificates };
    return {};
  });
}

async function chooseFile(wrapper, file) {
  const input = wrapper.get("[data-import-file]");
  Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
  await input.trigger("change");
}

async function openCertificateSection(wrapper, section) {
  await wrapper.get(`[data-certificate-section="${section}"]`).trigger("click");
  await flushPromises();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("CertificateManagementPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiBlobMock.mockResolvedValue(new Blob(["file"]));
    installApi();
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows three real sections and defaults to the certificate list", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.findAll('[role="tab"]')).toHaveLength(3);
    expect(wrapper.get('[data-certificate-section="list"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[data-section-panel="list"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-section-panel="manual"]').isVisible()).toBe(false);
    expect(wrapper.get('[data-section-panel="import"]').isVisible()).toBe(false);
  });

  it("keeps list filters, manual search, and import event independent", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    await wrapper.get("[data-list-query]").setValue("张三");
    await openCertificateSection(wrapper, "manual");
    await wrapper.get("[data-manual-name]").setValue("李四");
    await openCertificateSection(wrapper, "import");
    await wrapper.get("[data-import-event]").setValue("E2");
    await openCertificateSection(wrapper, "list");

    expect(wrapper.get("[data-list-query]").element.value).toBe("张三");
    expect(wrapper.get("[data-list-event]").element.value).toBe("E1");
    expect(wrapper.get("[data-manual-name]").element.value).toBe("李四");
    expect(wrapper.get("[data-import-event]").element.value).toBe("E2");
  });

  it("opens manual entry for an initial registration", async () => {
    const wrapper = mount(CertificateManagementPage, {
      props: { initialRegistrationId: "R1", initialEventId: "E1" }
    });
    await flushPromises();

    expect(wrapper.get('[data-certificate-section="manual"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[data-section-panel="manual"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-section-panel="list"]').isVisible()).toBe(false);
    expect(wrapper.get("[data-manual-selected]").text()).toContain("R1");
  });

  it("does not preload all registrations from the parent page", async () => {
    mount(CertificateManagementPage);
    await flushPromises();

    expect(apiMock.mock.calls.some(([path]) => isRegistrationRequest(path))).toBe(false);
  });

  it("refreshes only the certificate list after manual or import changes and preserves list filters", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await wrapper.get("[data-list-query]").setValue("张三");
    await flushPromises();
    apiMock.mockClear();

    wrapper.getComponent(ManualCertificateEntryPanel).vm.$emit("changed", { message: "手动录入完成" });
    await flushPromises();
    wrapper.getComponent(CertificateImportPanel).vm.$emit("committed", { id: "B1" });
    await flushPromises();

    expect(apiMock.mock.calls.filter(([path]) => isCertificateRequest(path))).toHaveLength(2);
    expect(apiMock.mock.calls.some(([path]) => path === "/api/admin/events" || isRegistrationRequest(path))).toBe(false);
    expect(wrapper.get("[data-list-query]").element.value).toBe("张三");
  });

  it("previews import rows and refreshes the list after commit", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await openCertificateSection(wrapper, "import");
    await chooseFile(wrapper, new File(["xlsx"], "证书导入.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }));
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("有效 1");
    expect(wrapper.text()).toContain("错误 1");
    expect(wrapper.text()).toContain("替换 1");
    expect(wrapper.text()).toContain("报名编号不存在");
    expect(wrapper.get('img[src="/returned/import-preview-1"]').exists()).toBe(true);

    await wrapper.get('[data-action="download-errors"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/admin/certificate-imports/B1/errors.xlsx");
    await wrapper.get('[data-action="commit-import"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已保存为未发布证书");
  });

  it("disables import commit when the preview has no valid rows", async () => {
    installApi({ previewPayload: { ...preview, validCount: 0, candidates: [] } });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await openCertificateSection(wrapper, "import");
    await chooseFile(wrapper, new File(["xlsx"], "错误.xlsx"));
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-action="commit-import"]').attributes()).toHaveProperty("disabled");
  });

  it("publishes exactly the selected draft certificate ids", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    const checkboxes = wrapper.findAll("[data-certificate-select]");
    await checkboxes[0].setValue(true);
    await checkboxes[1].setValue(true);
    await wrapper.get('[data-action="bulk-publish"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/certificates/bulk-status", {
      method: "POST",
      body: JSON.stringify({ ids: ["C1", "C2"], status: "published" })
    });
    expect(wrapper.text()).toContain("已批量发布 2 张证书");
  });

  it("reconciles selected certificates after a list-only refresh", async () => {
    const registrations = [1, 2, 3, 4].map((id) => ({
      ...registration,
      id: `R${id}`,
      athlete: { ...registration.athlete, name: `选手${id}` }
    }));
    const initial = registrations.map((row, index) => ({
      ...certificateOne,
      id: `C${index + 1}`,
      registrationId: row.id,
      registration: row
    }));
    const refreshed = [
      { ...initial[1], status: "published" },
      { ...initial[2], cleanedAt: "2026-07-17T12:00:00.000Z" },
      initial[3]
    ];
    let certificateLoads = 0;
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path.startsWith("/api/admin/certificate-imports?")) return { rows: [] };
      if (isCertificateRequest(path)) {
        certificateLoads += 1;
        const rows = certificateLoads === 1 ? initial : refreshed;
        return { rows, total: rows.length, page: 1, pageSize: 20 };
      }
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    for (const checkbox of wrapper.findAll("[data-certificate-select]")) await checkbox.setValue(true);

    await wrapper.get('[data-action="refresh-certificates"]').trigger("click");
    await flushPromises();

    expect(wrapper.get(".bulk-actions").text()).toContain("已选 1 张");
  });

  it("keeps cleaned files visible without preview or download actions", async () => {
    installApi({
      certificates: [{ ...certificateOne, cleanedAt: "2026-07-17T12:00:00.000Z", previewUrl: undefined, downloadUrl: undefined }]
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("原文件已清理，可替换");
    expect(wrapper.find('[data-action="preview-C1"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="download-C1"]').exists()).toBe(false);
  });

  it("resets dependent list filters and requests only certificates when the list event changes", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    const selects = wrapper.findAll(".certificate-filter-grid select");
    await selects[2].setValue("小学低段");
    await selects[3].setValue("P1");
    apiMock.mockClear();
    await selects[0].setValue("E2");
    await flushPromises();

    expect(selects[2].element.value).toBe("");
    expect(selects[3].element.value).toBe("");
    expect(apiMock.mock.calls.some(([path]) => isCertificateRequest(path) && path.includes("eventId=E2"))).toBe(true);
    expect(apiMock.mock.calls.some(([path]) => isRegistrationRequest(path))).toBe(false);
  });

  it("ignores an older list response after rapid event changes", async () => {
    const oldEvent = deferred();
    let initialLoaded = false;
    apiMock.mockImplementation((path) => {
      if (path === "/api/admin/events") return Promise.resolve({ rows: [event, eventTwo], projects: [project, projectTwo] });
      if (path.startsWith("/api/admin/certificate-imports?")) return Promise.resolve({ rows: [] });
      if (isCertificateRequest(path)) {
        const params = new URL(path, "http://admin.local").searchParams;
        if (!initialLoaded) {
          initialLoaded = true;
          return Promise.resolve({ rows: [certificateOne], total: 1, page: 1, pageSize: 20 });
        }
        if (params.get("eventId") === "E2") return oldEvent.promise;
        return Promise.resolve({ rows: [{ ...certificateOne, title: "最新证书" }], total: 1, page: 1, pageSize: 20 });
      }
      return Promise.resolve({});
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    const eventSelect = wrapper.get("[data-list-event]");
    await eventSelect.setValue("E2");
    await eventSelect.setValue("E1");
    await flushPromises();
    oldEvent.resolve({ rows: [{ ...certificateOne, title: "过期证书" }], total: 1, page: 1, pageSize: 20 });
    await flushPromises();

    expect(wrapper.text()).toContain("最新证书");
    expect(wrapper.text()).not.toContain("过期证书");
  });

  it("does not show bulk success when the certificate refresh fails", async () => {
    let certificateLoads = 0;
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path.startsWith("/api/admin/certificate-imports?")) return { rows: [] };
      if (isCertificateRequest(path)) {
        certificateLoads += 1;
        if (certificateLoads > 1) throw new Error("列表刷新失败");
        return { rows: [certificateOne], total: 1, page: 1, pageSize: 20 };
      }
      if (path === "/api/admin/certificates/bulk-status" && options.method === "POST") return { rows: [] };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await wrapper.get("[data-certificate-select]").setValue(true);
    await wrapper.get('[data-action="bulk-publish"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("列表刷新失败");
    expect(wrapper.text()).not.toContain("已批量发布 1 张证书");
  });

  it("downloads only from the returned certificate URL", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="download-C1"]').trigger("click");
    await flushPromises();

    expect(apiBlobMock).toHaveBeenCalledWith("/returned/download-C1");
  });

  it("ends loading and shows a readable list error", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path.startsWith("/api/admin/certificate-imports?")) return { rows: [] };
      if (isCertificateRequest(path)) throw new Error("证书列表暂时无法加载");
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("证书列表暂时无法加载");
    expect(wrapper.text()).not.toContain("正在加载证书…");
  });
});
