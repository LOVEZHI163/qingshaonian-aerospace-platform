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
const historicalEvent = { id: "E0", name: "2025 青少年航空赛", isCurrent: false };
const eventTwo = { id: "E2", name: "2027 青少年航空赛", isCurrent: false };
const project = { id: "P1", eventId: "E1", name: "纸飞机", allowedGroups: ["小学低段"] };
const historicalProject = { id: "P0", eventId: "E0", name: "历史纸飞机", allowedGroups: ["小学低段"] };
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
const registrationTwo = {
  ...registration,
  id: "R2",
  athlete: { name: "李四", school: "第二小学", grade: "四年级" }
};
const historicalRegistration = {
  ...registration,
  id: "R-HISTORICAL",
  eventId: "E0",
  projectId: "P0",
  projectName: "历史纸飞机",
  athlete: { name: "历史选手", school: "历史学校", grade: "六年级" }
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

function isRegistrationRequest(path) {
  return path === "/api/admin/registrations?pageSize=100" || path.startsWith("/api/admin/registrations?eventId=");
}

function isCertificateRequest(path) {
  return path === "/api/admin/certificates" || path.startsWith("/api/admin/certificates?");
}

function installApi({
  certificates = [certificateOne, certificateTwo],
  previewPayload = preview,
  registrationRows = [registration],
  eventRows = [event],
  projectRows = [project]
} = {}) {
  apiMock.mockImplementation(async (path, options = {}) => {
    if (path === "/api/admin/events") return { rows: eventRows, projects: projectRows };
    if (isRegistrationRequest(path)) return { rows: registrationRows, total: registrationRows.length, page: 1, pageSize: 100 };
    if (isCertificateRequest(path)) return { rows: certificates };
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

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
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

  it("已有预检查批次时锁定文件选择并显示该批次的服务端文件名", async () => {
    installApi({ previewPayload: { ...preview, originalName: "服务端确认批次.xlsx" } });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await chooseFile(wrapper, '[data-import-file]', new File(["xlsx"], "本地名称.xlsx"));
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-import-file]').attributes()).toHaveProperty("disabled");
    expect(wrapper.get(".selected-file-name").text()).toBe("服务端确认批次.xlsx");
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

  it("成绩三个字段清空提交后，刷新界面仍精确显示空值", async () => {
    let registrationLoads = 0;
    const clearedRegistration = { ...registration, awardName: "", rank: "", score: "" };
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (isCertificateRequest(path)) return { rows: [certificateOne, certificateTwo] };
      if (isRegistrationRequest(path)) {
        registrationLoads += 1;
        return { rows: [registrationLoads === 1 ? registration : clearedRegistration], total: 1, page: 1, pageSize: 100 };
      }
      if (path === "/api/admin/registrations/R1/result" && options.method === "POST") return { row: clearedRegistration };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    await wrapper.get('[data-result="awardName"]').setValue("");
    await wrapper.get('[data-result="rank"]').setValue("");
    await wrapper.get('[data-result="score"]').setValue("");
    await wrapper.get('[data-action="save-result"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/registrations/R1/result", {
      method: "POST",
      body: JSON.stringify({ awardName: "", rank: "", score: "" })
    });
    expect(wrapper.get('[data-result="awardName"]').element.value).toBe("");
    expect(wrapper.get('[data-result="rank"]').element.value).toBe("");
    expect(wrapper.get('[data-result="score"]').element.value).toBe("");
  });

  it("刷新后只保留仍存在、未发布且文件未清理的勾选证书", async () => {
    const registrations = [registration, ...[2, 3, 4].map((id) => ({
      ...registration,
      id: `R${id}`,
      athlete: { ...registration.athlete, name: `选手${id}` }
    }))];
    const initialCertificates = registrations.map((row, index) => ({
      ...certificateOne,
      id: `C${index + 1}`,
      registrationId: row.id,
      registration: row,
      athlete: row.athlete
    }));
    const refreshedCertificates = [
      { ...initialCertificates[1], status: "published" },
      { ...initialCertificates[2], cleanedAt: "2026-07-17T12:00:00.000Z", previewUrl: undefined, downloadUrl: undefined },
      initialCertificates[3]
    ];
    let certificateLoads = 0;
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (isRegistrationRequest(path)) return { rows: registrations, total: registrations.length, page: 1, pageSize: 100 };
      if (isCertificateRequest(path)) {
        certificateLoads += 1;
        return { rows: certificateLoads === 1 ? initialCertificates : refreshedCertificates };
      }
      if (path === "/api/admin/registrations/R1/result" && options.method === "POST") return { row: registration };
      if (path === "/api/admin/certificates/bulk-status" && options.method === "POST") return { rows: [initialCertificates[3]] };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    for (const checkbox of wrapper.findAll('[data-certificate-select]')) await checkbox.setValue(true);

    await wrapper.get('[data-action="save-result"]').trigger("click");
    await flushPromises();

    expect(wrapper.get(".bulk-actions").text()).toContain("已选 1 张");
    await wrapper.get('[data-action="bulk-publish"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/certificates/bulk-status", {
      method: "POST",
      body: JSON.stringify({ ids: ["C4"], status: "published" })
    });
  });

  it("切换报名时销毁上一报名的待上传文件、预览、删除确认和忙碌状态", async () => {
    let releaseSave;
    const pendingSave = new Promise((resolve) => { releaseSave = resolve; });
    installApi({ registrationRows: [registration, registrationTwo] });
    const originalImplementation = apiMock.getMockImplementation();
    apiMock.mockImplementation((path, options = {}) => {
      if (path === "/api/admin/certificates/C1" && options.method === "PATCH") return pendingSave;
      return originalImplementation(path, options);
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    await chooseFile(wrapper, '[data-slot-file="2"]', new File(["A"], "A报名待上传.pdf", { type: "application/pdf" }));
    const slotEditor = wrapper.get(".certificate-slot-editor");
    await slotEditor.get('[data-action="preview-C1"]').trigger("click");
    await slotEditor.get('[data-action="request-delete-C1"]').trigger("click");
    const pendingTrigger = wrapper.get('[data-action="save-slot-1"]').trigger("click");
    await flushPromises();
    const secondRegistration = wrapper.findAll(".registration-picker button").find((button) => button.text().includes("R2"));
    await secondRegistration.trigger("click");
    await flushPromises();

    expect(wrapper.find(".file-preview-dialog").exists()).toBe(false);
    expect(wrapper.find('[aria-label="删除证书确认"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("A报名待上传.pdf");
    expect(wrapper.get('[data-action="save-slot-1"]').attributes()).not.toHaveProperty("disabled");
    await wrapper.get('[data-action="save-slot-2"]').trigger("click");
    await flushPromises();
    expect(apiMock.mock.calls.some(([path, options]) => path === "/api/admin/registrations/R2/certificates/2" && options?.method === "POST")).toBe(false);

    releaseSave({ row: certificateOne });
    await pendingTrigger;
  });

  it("历史赛事跳转先选中历史赛事，再定位目标报名", async () => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event, historicalEvent], projects: [project, historicalProject] };
      if (isCertificateRequest(path)) return { rows: [] };
      if (isRegistrationRequest(path)) return { rows: path.includes("eventId=E0") ? [historicalRegistration] : [registration], total: 1, page: 1, pageSize: 100 };
      return {};
    });
    const historical = mount(CertificateManagementPage, {
      props: { initialRegistrationId: "R-HISTORICAL", initialEventId: "E0" }
    });
    await flushPromises();
    expect(historical.get(".certificate-filter-grid select").element.value).toBe("E0");
    expect(historical.get(".registration-summary").text()).toContain("R-HISTORICAL");
  });

  it("分页加载所选赛事全部报名并可定位第二页目标", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...registration,
      id: `R${String(index + 1).padStart(3, "0")}`,
      athlete: { ...registration.athlete, name: `选手${index + 1}` }
    }));
    const secondPageTarget = { ...registrationTwo, id: "R101", athlete: { ...registrationTwo.athlete, name: "第二页目标" } };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (isCertificateRequest(path)) return { rows: [] };
      if (path === "/api/admin/registrations?eventId=E1&pageSize=100") return { rows: firstPage, total: 101, page: 1, pageSize: 100 };
      if (path === "/api/admin/registrations?eventId=E1&page=2&pageSize=100") return { rows: [secondPageTarget], total: 101, page: 2, pageSize: 100 };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: firstPage, total: 101, page: 1, pageSize: 100 };
      return {};
    });
    const wrapper = mount(CertificateManagementPage, { props: { initialRegistrationId: "R101", initialEventId: "E1" } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/registrations?eventId=E1&page=2&pageSize=100");
    expect(wrapper.get(".registration-summary").text()).toContain("R101");
    expect(wrapper.get(".registration-summary").text()).toContain("第二页目标");
  });

  it("所选赛事报名超过安全上限时明确报错且不继续翻页", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (isCertificateRequest(path)) return { rows: [] };
      if (path === "/api/admin/registrations?eventId=E1&pageSize=100") return { rows: [], total: 10001, page: 1, pageSize: 100 };
      if (path === "/api/admin/registrations?pageSize=100") return { rows: [], total: 10001, page: 1, pageSize: 100 };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("报名数据过多，请缩小赛事或筛选范围后重试");
    expect(apiMock.mock.calls.some(([path]) => path.includes("page=2"))).toBe(false);
  });

  it("管理员看到原文件已清理且可替换，但没有预览或下载入口", async () => {
    const cleaned = { ...certificateOne, cleanedAt: "2026-07-17T12:00:00.000Z", previewUrl: undefined, downloadUrl: undefined };
    installApi({ certificates: [cleaned] });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("原文件已清理，可替换");
    expect(wrapper.find('[data-action="preview-C1"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="download-C1"]').exists()).toBe(false);
    expect(wrapper.get('[data-action="save-slot-1"]').text()).toContain("保存标题");
  });

  it("切换赛事时清空组别和赛项筛选并加载新赛事报名", async () => {
    installApi({ eventRows: [event, eventTwo], projectRows: [project, projectTwo] });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    const selects = wrapper.findAll(".certificate-filter-grid select");
    await selects[2].setValue("小学低段");
    await selects[3].setValue("P1");
    await selects[0].setValue("E2");
    await flushPromises();

    expect(selects[2].element.value).toBe("");
    expect(selects[3].element.value).toBe("");
    expect(apiMock.mock.calls.some(([path]) => path.includes("eventId=E2"))).toBe(true);
  });

  it("切换赛事会清除旧赛事隐藏的勾选，批量发布不提交消失 ID", async () => {
    const secondEventRegistration = { ...registrationTwo, eventId: "E2", projectId: "P2", projectName: "橡筋飞机" };
    const secondEventCertificate = {
      ...certificateTwo,
      id: "C-E2",
      registrationId: secondEventRegistration.id,
      registration: secondEventRegistration,
      athlete: secondEventRegistration.athlete,
      projectName: secondEventRegistration.projectName
    };
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events") return { rows: [event, eventTwo], projects: [project, projectTwo] };
      if (isCertificateRequest(path)) return { rows: [certificateOne, secondEventCertificate] };
      if (isRegistrationRequest(path)) {
        const rows = path.includes("eventId=E2") ? [secondEventRegistration] : [registration];
        return { rows, total: 1, page: 1, pageSize: 100 };
      }
      if (path === "/api/admin/certificates/bulk-status" && options.method === "POST") return { rows: [] };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await wrapper.get('[data-certificate-select]').setValue(true);

    await wrapper.findAll(".certificate-filter-grid select")[0].setValue("E2");
    await flushPromises();

    expect(wrapper.get(".bulk-actions").text()).toContain("已选 0 张");
    expect(wrapper.get('[data-action="bulk-publish"]').attributes()).toHaveProperty("disabled");
    await wrapper.get('[data-action="bulk-publish"]').trigger("click");
    expect(apiMock.mock.calls.some(([path]) => path === "/api/admin/certificates/bulk-status")).toBe(false);
  });

  it("快速切换赛事时，较晚返回的旧成功响应不能覆盖最新报名和加载状态", async () => {
    let resolveOldEvent;
    const oldEventResponse = new Promise((resolve) => { resolveOldEvent = resolve; });
    const secondEventRegistration = { ...registrationTwo, eventId: "E2", projectId: "P2", projectName: "橡筋飞机" };
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event, eventTwo], projects: [project, projectTwo] };
      if (isCertificateRequest(path)) return { rows: [] };
      if (path.includes("eventId=E2")) return oldEventResponse;
      if (isRegistrationRequest(path)) return { rows: [registration], total: 1, page: 1, pageSize: 100 };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    const eventSelect = wrapper.findAll(".certificate-filter-grid select")[0];

    await eventSelect.setValue("E2");
    await eventSelect.setValue("E1");
    await flushPromises();
    expect(wrapper.get(".registration-summary").text()).toContain("R1");
    expect(wrapper.text()).not.toContain("正在加载所选赛事的全部报名");

    resolveOldEvent({ rows: [secondEventRegistration], total: 1, page: 1, pageSize: 100 });
    await flushPromises();
    expect(wrapper.get(".registration-summary").text()).toContain("R1");
    expect(wrapper.text()).not.toContain("正在加载所选赛事的全部报名");
  });

  it("快速切换赛事时，较晚返回的旧失败不能覆盖最新错误和加载状态", async () => {
    let rejectOldEvent;
    const oldEventResponse = new Promise((_, reject) => { rejectOldEvent = reject; });
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/events") return { rows: [event, eventTwo], projects: [project, projectTwo] };
      if (isCertificateRequest(path)) return { rows: [] };
      if (path.includes("eventId=E2")) return oldEventResponse;
      if (isRegistrationRequest(path)) return { rows: [registration], total: 1, page: 1, pageSize: 100 };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    const eventSelect = wrapper.findAll(".certificate-filter-grid select")[0];

    await eventSelect.setValue("E2");
    await eventSelect.setValue("E1");
    await flushPromises();
    rejectOldEvent(new Error("旧赛事请求失败"));
    await flushPromises();

    expect(wrapper.get(".registration-summary").text()).toContain("R1");
    expect(wrapper.text()).not.toContain("旧赛事请求失败");
    expect(wrapper.text()).not.toContain("正在加载所选赛事的全部报名");
  });

  it("批量发布后的列表刷新失败时不保留成功提示", async () => {
    let registrationLoads = 0;
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events") return { rows: [event], projects: [project] };
      if (isCertificateRequest(path)) return { rows: [certificateOne] };
      if (isRegistrationRequest(path)) {
        registrationLoads += 1;
        if (registrationLoads > 1) throw new Error("列表刷新失败");
        return { rows: [registration], total: 1, page: 1, pageSize: 100 };
      }
      if (path === "/api/admin/certificates/bulk-status" && options.method === "POST") return { rows: [certificateOne] };
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();
    await wrapper.get('[data-certificate-select]').setValue(true);
    await wrapper.get('[data-action="bulk-publish"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("列表刷新失败");
    expect(wrapper.text()).not.toContain("已批量发布 1 张证书");
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
      if (isRegistrationRequest(path)) return { rows: [registration], total: 1, page: 1, pageSize: 100 };
      if (isCertificateRequest(path)) return { rows: [certificateOne] };
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
      if (isRegistrationRequest(path)) return { rows: [registration], total: 1, page: 1, pageSize: 100 };
      if (isCertificateRequest(path)) throw new Error("证书列表暂时无法加载");
      return {};
    });
    const wrapper = mount(CertificateManagementPage);
    await flushPromises();

    expect(wrapper.text()).toContain("证书列表暂时无法加载");
    expect(wrapper.text()).not.toContain("正在加载证书…");
  });
});
