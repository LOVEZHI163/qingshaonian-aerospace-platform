import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock, apiUrlMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  apiBlobMock: vi.fn(),
  apiUrlMock: vi.fn((path) => path)
}));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, apiUrl: apiUrlMock }));

import OrganizationCertificatesPage from "../OrganizationCertificatesPage.vue";

const rows = [
  {
    id: "C1", eventId: "E1", eventName: "本届赛事", title: "一等奖", status: "published",
    previewUrl: "/api/certificates/C1/file", downloadUrl: "/api/certificates/C1/file?download=1",
    fileName: "一等奖.png", athlete: { name: "张三", school: "实验小学", grade: "五年级" }, projectName: "纸飞机"
  },
  {
    id: "C2", eventId: "E-ARCHIVED", eventName: "往届赛事", title: "优秀选手", status: "published",
    previewUrl: "/api/certificates/C2/file", downloadUrl: "/api/certificates/C2/file?download=1",
    fileName: "优秀选手.pdf", athlete: { name: "李四", school: "实验小学", grade: "高三" }, projectName: "航空绘画"
  }
];

describe("OrganizationCertificatesPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiMock.mockResolvedValue({ rows });
    apiBlobMock.mockResolvedValue(new Blob(["certificate"]));
    URL.createObjectURL = vi.fn(() => "blob:certificate");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("loads cross-event organization certificates immediately and filters by event", async () => {
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/organization/certificates");
    expect(wrapper.text()).toContain("本届赛事");
    expect(wrapper.text()).toContain("往届赛事");
    await wrapper.get('[data-field="organization-certificate-event"]').setValue("E-ARCHIVED");
    expect(wrapper.get("tbody").text()).not.toContain("本届赛事");
    expect(wrapper.get("tbody").text()).toContain("往届赛事");
  });

  it("previews and downloads only through the certificate file URLs", async () => {
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();

    await wrapper.get('[data-action="preview-organization-certificate-C1"]').trigger("click");
    expect(window.open).toHaveBeenCalledWith("/api/certificates/C1/file", "_blank", "noopener,noreferrer");
    await wrapper.get('[data-action="download-organization-certificate-C1"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/certificates/C1/file?download=1");
    expect(apiMock.mock.calls.some(([path]) => path.startsWith("/api/me/"))).toBe(false);
  });

  it("shows a safe error and retries the global query", async () => {
    apiMock.mockRejectedValueOnce(new Error("<!DOCTYPE html> gateway"));
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("证书加载失败，请重试");
    expect(wrapper.text()).not.toContain("<!DOCTYPE html>");
    apiMock.mockResolvedValueOnce({ rows });
    await wrapper.get('[data-action="retry-organization-certificates"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("往届赛事");
  });
});
