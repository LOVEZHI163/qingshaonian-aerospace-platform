import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: apiMock,
  apiBlob: apiBlobMock,
  apiUrl: (path) => path
}));

import CertificateImportPanel from "../CertificateImportPanel.vue";

const recoverablePreview = {
  id: "B-recoverable",
  status: "preview",
  originalName: "待恢复导入.xlsx",
  validCount: 1,
  errorCount: 0,
  replaceCount: 0,
  candidates: [],
  errors: []
};

async function chooseFile(wrapper, file) {
  const input = wrapper.get("[data-import-file]");
  Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
  await input.trigger("change");
}

describe("CertificateImportPanel final fixes", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events/E1/certificate-imports") return { rows: [recoverablePreview] };
      if (path === "/api/admin/events/E1/certificate-imports/preview" && options.method === "POST") {
        return { ...recoverablePreview, id: "B-new", originalName: "新导入.xlsx" };
      }
      if (path === "/api/admin/events/E1/certificate-imports/B-recoverable" && options.method === "DELETE") return {};
      return { rows: [] };
    });
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("按赛事恢复未完成预检，并可恢复到当前批次后取消", async () => {
    const wrapper = mount(CertificateImportPanel, { props: { eventId: "E1" } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/certificate-imports");
    expect(wrapper.get('[data-action="resume-import-B-recoverable"]').text()).toContain("恢复");

    await wrapper.get('[data-action="resume-import-B-recoverable"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("待恢复导入.xlsx");

    await wrapper.get('[data-action="cancel-import"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/certificate-imports/B-recoverable", { method: "DELETE" });
  });

  it("预检查随工作簿提交当前赛事 ID", async () => {
    const wrapper = mount(CertificateImportPanel, { props: { eventId: "E1" } });
    await flushPromises();
    await chooseFile(wrapper, new File(["xlsx"], "证书.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();

    const previewCall = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/events/E1/certificate-imports/preview" && options?.method === "POST");
    expect(previewCall?.[1].body).toBeInstanceOf(FormData);
    expect(previewCall?.[1].body.get("eventId")).toBe("E1");
  });

  it("团队证书预检查显示队伍编号和具体队员", async () => {
    apiMock.mockResolvedValueOnce({ rows: [{
      ...recoverablePreview,
      candidates: [{
        rowNumber: 2,
        registrationId: "R-TEAM",
        participantId: "RP-2",
        participantName: "队员乙",
        athleteName: "兼容姓名",
        teamCode: "O1-P1-01",
        projectName: "团队飞行",
        result: {},
        certificates: []
      }]
    }] });
    const wrapper = mount(CertificateImportPanel, { props: { eventId: "E1" } });
    await flushPromises();
    await wrapper.get('[data-action="resume-import-B-recoverable"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("O1-P1-01");
    expect(wrapper.text()).toContain("队员乙");
    expect(wrapper.text()).not.toContain("兼容姓名");
  });
});
