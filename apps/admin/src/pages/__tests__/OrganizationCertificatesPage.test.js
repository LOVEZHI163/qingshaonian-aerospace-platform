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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

describe("OrganizationCertificatesPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiMock.mockResolvedValue({ rows });
    apiBlobMock.mockResolvedValue(new Blob(["certificate"]));
    let objectUrl = 0;
    URL.createObjectURL = vi.fn(() => `blob:certificate-${++objectUrl}`);
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

  it("opens a placeholder synchronously, then navigates it only after the preview blob resolves", async () => {
    const pending = deferred();
    const popup = { location: { href: "about:blank" }, close: vi.fn(), opener: {} };
    window.open.mockReturnValue(popup);
    apiBlobMock.mockReturnValueOnce(pending.promise);
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();

    await wrapper.get('[data-action="preview-organization-certificate-C1"]').trigger("click");
    expect(window.open).toHaveBeenCalledWith("", "_blank", "noopener,noreferrer");
    expect(apiBlobMock).toHaveBeenCalledWith("/api/certificates/C1/file");
    expect(popup.location.href).toBe("about:blank");
    expect(popup.opener).toBeNull();

    pending.resolve(new Blob(["certificate"]));
    await flushPromises();
    expect(popup.location.href).toBe("blob:certificate-1");

    await wrapper.get('[data-action="download-organization-certificate-C1"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/certificates/C1/file?download=1");
    expect(apiMock.mock.calls.some(([path]) => path.startsWith("/api/me/"))).toBe(false);
    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:certificate-1");
  });

  it("closes the placeholder and reports a stable restriction when controlled preview fails", async () => {
    const popup = { location: { href: "about:blank" }, close: vi.fn(), opener: {} };
    window.open.mockReturnValue(popup);
    apiBlobMock.mockRejectedValueOnce(Object.assign(new Error("stale preview"), { code: "ORGANIZATION_REJECTED" }));
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();
    await wrapper.get('[data-action="preview-organization-certificate-C1"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("access-denied")?.[0]?.[0]).toMatchObject({ code: "ORGANIZATION_REJECTED" });
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("releases the object URL and closes the placeholder if popup navigation fails", async () => {
    const location = {};
    Object.defineProperty(location, "href", { configurable: true, set: () => { throw new Error("navigation failed"); } });
    const popup = { location, close: vi.fn(), opener: {} };
    window.open.mockReturnValue(popup);
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();

    await wrapper.get('[data-action="preview-organization-certificate-C1"]').trigger("click");
    await flushPromises();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:certificate-1");
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[role="alert"]').text()).toContain("navigation failed");
  });

  it("shows an actionable message without fetching when the browser blocks the preview popup", async () => {
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();

    await wrapper.get('[data-action="preview-organization-certificate-C1"]').trigger("click");

    expect(apiBlobMock).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("允许弹窗");
    expect(wrapper.get('[role="alert"]').text()).toContain("下载按钮");
  });

  it("clears an earlier certificate error when a download starts and succeeds", async () => {
    const popup = { location: { href: "about:blank" }, close: vi.fn(), opener: {} };
    window.open.mockReturnValue(popup);
    apiBlobMock.mockRejectedValueOnce(new Error("预览暂时失败")).mockResolvedValueOnce(new Blob(["certificate"]));
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();

    await wrapper.get('[data-action="preview-organization-certificate-C1"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("预览暂时失败");

    await wrapper.get('[data-action="download-organization-certificate-C1"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
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

  it("reports a stable organization restriction to the application shell", async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("stale session"), { code: "ORGANIZATION_REVIEW_PENDING" }));
    const wrapper = mount(OrganizationCertificatesPage);
    await flushPromises();

    expect(wrapper.emitted("access-denied")?.[0]?.[0]).toMatchObject({ code: "ORGANIZATION_REVIEW_PENDING" });
  });
});
