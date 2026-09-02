import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));

import CertificateSlotEditor from "../CertificateSlotEditor.vue";

const registration = {
  id: "R1",
  eventId: "E1",
  athlete: { name: "张三", school: "实验小学" },
  group: "小学低段",
  projectName: "纸飞机"
};
const certificates = [
  { id: "C1", registrationId: "R1", slot: 1, title: "证书一", status: "draft", fileName: "one.pdf" },
  { id: "C2", registrationId: "R1", slot: 2, title: "证书二", status: "draft", fileName: "two.pdf" }
];

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

describe("CertificateSlotEditor final fixes", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("默认保留独立编辑器的证书状态操作", () => {
    const wrapper = mount(CertificateSlotEditor, { props: { registration, certificates } });
    expect(wrapper.findAll("button").map((button) => button.text()).filter((text) => text === "发布")).toHaveLength(2);
  });

  it("并发保存两个位置时，一个完成不会提前解除另一个位置的忙碌状态", async () => {
    const slotOne = deferred();
    const slotTwo = deferred();
    apiMock.mockImplementation((path, options = {}) => {
      if (path === "/api/admin/events/E1/certificates/C1" && options.method === "PATCH") return slotOne.promise;
      if (path === "/api/admin/events/E1/certificates/C2" && options.method === "PATCH") return slotTwo.promise;
      return Promise.resolve({});
    });
    const wrapper = mount(CertificateSlotEditor, { props: { registration, certificates } });
    await flushPromises();

    const saveOne = wrapper.get('[data-action="save-slot-1"]');
    const saveTwo = wrapper.get('[data-action="save-slot-2"]');
    await saveOne.trigger("click");
    await saveTwo.trigger("click");
    await flushPromises();
    expect(saveOne.attributes()).toHaveProperty("disabled");
    expect(saveTwo.attributes()).toHaveProperty("disabled");

    slotOne.resolve({ row: certificates[0] });
    await flushPromises();
    expect(saveOne.attributes()).not.toHaveProperty("disabled");
    expect(saveTwo.attributes()).toHaveProperty("disabled");

    slotTwo.resolve({ row: certificates[1] });
    await flushPromises();
    expect(saveTwo.attributes()).not.toHaveProperty("disabled");
  });

  it("第二位置使用 multipart 上传文件且不要求证书编号", async () => {
    apiMock.mockResolvedValue({ row: certificates[1] });
    const wrapper = mount(CertificateSlotEditor, { props: { registration, certificates } });
    const input = wrapper.get('[data-slot-file="2"]');
    const file = new File(["pdf"], "第二张.pdf", { type: "application/pdf" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await wrapper.get('[data-action="save-slot-2"]').trigger("click");
    await flushPromises();

    const upload = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/events/E1/registrations/R1/certificates/2" && options?.method === "POST");
    expect(upload?.[1].body).toBeInstanceOf(FormData);
    expect(upload?.[1].body.get("certificate").name).toBe("第二张.pdf");
    expect(wrapper.find('input[placeholder="证书编号"]').exists()).toBe(false);
  });

  it("团队证书上传携带当前选择的证书对象编号", async () => {
    apiMock.mockResolvedValue({ row: { ...certificates[0], participantId: "RP-2" } });
    const wrapper = mount(CertificateSlotEditor, {
      props: { registration: { ...registration, projectType: "team" }, certificates: [], participantId: "RP-2" }
    });
    const input = wrapper.get('[data-slot-file="1"]');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [new File(["pdf"], "队员乙.pdf", { type: "application/pdf" })]
    });
    await input.trigger("change");
    await wrapper.get('[data-action="save-slot-1"]').trigger("click");
    await flushPromises();

    const upload = apiMock.mock.calls.find(([path, options]) => path.endsWith("/registrations/R1/certificates/1") && options?.method === "POST");
    expect(upload?.[1].body.get("participantId")).toBe("RP-2");
  });

  it("删除使用页面内确认，失败时保留错误且不调用 window.confirm", async () => {
    apiMock.mockRejectedValue(new Error("删除失败，请稍后重试"));
    const nativeConfirm = vi.spyOn(window, "confirm");
    const wrapper = mount(CertificateSlotEditor, { props: { registration, certificates } });

    await wrapper.get('[data-action="request-delete-C1"]').trigger("click");
    expect(wrapper.text()).toContain("确认删除证书一？");
    expect(nativeConfirm).not.toHaveBeenCalled();
    await wrapper.get('[data-action="cancel-delete"]').trigger("click");
    expect(apiMock).not.toHaveBeenCalled();

    await wrapper.get('[data-action="request-delete-C1"]').trigger("click");
    await wrapper.get('[data-action="confirm-delete"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E1/certificates/C1", { method: "DELETE" });
    expect(wrapper.get('[role="alert"]').text()).toContain("删除失败，请稍后重试");
  });
});
