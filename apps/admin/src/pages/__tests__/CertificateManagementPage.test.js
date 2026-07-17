import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: apiMock,
  apiBlob: apiBlobMock,
  apiUrl: (path) => path
}));

import CertificateManagementPage from "../CertificateManagementPage.vue";

const event = { id: "E1", name: "2026 青少年航空赛", isCurrent: true };
const project = { id: "P1", eventId: "E1", name: "纸飞机", allowedGroups: ["小学低段"] };
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
  id: "C2",
  registrationId: "R1",
  slot: 2,
  title: "优秀选手证书",
  status: "draft",
  fileName: "second.pdf",
  previewUrl: "/returned/preview-C2",
  downloadUrl: "/returned/download-C2",
  registration,
  athlete: registration.athlete,
  projectName: registration.projectName
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

function installApi({ certificates = [certificateOne, certificateTwo], previewPayload = preview } = {}) {
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path === "/api/admin/events") return { rows: [event], projects: [project] };
    if (path === "/api/admin/registrations?pageSize=100") return { rows: [registration], total: 1 };
    if (path === "/api/admin/certificates") return { rows: certificates };
    if (path === "/api/admin/certificate-imports/preview" && options.method === "POST") return previewPayload;
    if (path === "/api/admin/certificate-imports/B1/commit" && options.method === "POST") {
      return { id: "B1", status: "committed", createdCount: 1, replacedCount: 1 };
    }
    if (path === "/api/admin/certificates/bulk-status" && options.method === "POST") return { rows: certificates };
    if (path === "/api/admin/registrations/R1/result" && options.method === "POST") return { row: registration };
    if (path === "/api/admin/registrations/R1/certificates/2" && options.method === "POST") return { row: certificateTwo };
    if (path === "/api/admin/certificates/C1" && options.method === "DELETE") return {};
    return { row: certificateOne };
  });
}

async function chooseFile(wrapper, selector, file) {
  const input = wrapper.get(selector);
  Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
  await input.trigger("change");
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

  it("预检查逐行展示有效、错误和替换信息，并可下载错误报告后确认导入", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.get('[data-import-file]').attributes("accept")).toContain(".xlsx");
    await chooseFile(wrapper, '[data-import-file]', new File(["xlsx"], "证书导入.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("有效 1");
    expect(wrapper.text()).toContain("错误 1");
    expect(wrapper.text()).toContain("替换 1");
    expect(wrapper.text()).toContain("将替换");
    expect(wrapper.text()).toContain("R1");
    expect(wrapper.text()).toContain("张三");
    expect(wrapper.text()).toContain("纸飞机");
    expect(wrapper.text()).toContain("一等奖");
    expect(wrapper.text()).toContain("一等奖证书");
    expect(wrapper.text()).toContain("Excel 第 3 行");
    expect(wrapper.text()).toContain("报名编号不存在");
    expect(wrapper.get('img[src="/returned/import-preview-1"]').exists()).toBe(true);

    await wrapper.get('[data-action="download-errors"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/admin/certificate-imports/B1/errors.xlsx");

    await wrapper.get('[data-action="commit-import"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/certificate-imports/B1/commit", { method: "POST" });
    expect(wrapper.text()).toContain("已保存为未发布证书");
  });

  it("预检查没有有效行时禁用确认导入", async () => {
    installApi({ previewPayload: { ...preview, validCount: 0, candidates: [] } });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await chooseFile(wrapper, '[data-import-file]', new File(["xlsx"], "错误.xlsx"));
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-action="commit-import"]').attributes()).toHaveProperty("disabled");
  });

  it("选择两张未发布证书后批量发布，并严格提交两个证书 ID", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    const checkboxes = wrapper.findAll('[data-certificate-select]');
    expect(checkboxes).toHaveLength(2);
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

  it("报名详情提供两个证书位置、三个独立成绩字段和第二位置上传，且没有证书编号", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("证书位置 1");
    expect(wrapper.text()).toContain("证书位置 2");
    expect(wrapper.find('input[placeholder="证书编号"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("证书编号");
    expect(wrapper.get('[data-result="awardName"]').element.value).toBe("二等奖");
    expect(wrapper.get('[data-result="rank"]').element.value).toBe("2");
    expect(wrapper.get('[data-result="score"]').element.value).toBe("96");

    await wrapper.get('[data-result="awardName"]').setValue("一等奖");
    await wrapper.get('[data-result="rank"]').setValue("1");
    await wrapper.get('[data-result="score"]').setValue("99.5");
    await wrapper.get('[data-action="save-result"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/registrations/R1/result", {
      method: "POST",
      body: JSON.stringify({ awardName: "一等奖", rank: "1", score: "99.5" })
    });

    expect(wrapper.get('[data-slot-file="2"]').attributes("accept")).toContain("application/pdf");
    await chooseFile(wrapper, '[data-slot-file="2"]', new File(["pdf"], "第二张.pdf", { type: "application/pdf" }));
    await wrapper.get('[data-action="save-slot-2"]').trigger("click");
    await flushPromises();
    const uploadCall = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/registrations/R1/certificates/2" && options.method === "POST");
    expect(uploadCall[1].body).toBeInstanceOf(FormData);
    expect(uploadCall[1].body.get("certificate").name).toBe("第二张.pdf");
  });

  it("证书下载只使用接口返回的 downloadUrl", async () => {
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await wrapper.get('[data-action="download-C1"]').trigger("click");
    await flushPromises();

    expect(apiBlobMock).toHaveBeenCalledWith("/returned/download-C1");
  });

  it("删除使用页面内确认，接口失败时保留清晰错误且不调用 window.confirm", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: [registration], total: 1 };
      if (path === "/api/admin/certificates") return { rows: [certificateOne] };
      if (path === "/api/admin/certificates/C1" && options.method === "DELETE") throw new Error("删除失败，请稍后重试");
      return {};
    });
    const nativeConfirm = vi.spyOn(window, "confirm");
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    await wrapper.get('[data-action="request-delete-C1"]').trigger("click");
    expect(wrapper.text()).toContain("确认删除一等奖证书？");
    expect(nativeConfirm).not.toHaveBeenCalled();
    await wrapper.get('[data-action="cancel-delete"]').trigger("click");
    expect(apiMock.mock.calls.some(([path, options]) => path === "/api/admin/certificates/C1" && options?.method === "DELETE")).toBe(false);

    await wrapper.get('[data-action="request-delete-C1"]').trigger("click");
    await wrapper.get('[data-action="confirm-delete"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("删除失败，请稍后重试");
  });

  it("列表接口失败时结束加载并显示可理解的错误", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: [registration], total: 1 };
      if (path === "/api/admin/certificates") throw new Error("证书列表暂时无法加载");
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("证书列表暂时无法加载");
    expect(wrapper.text()).not.toContain("正在加载证书…");
  });
});
