import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));

import CertificateSlotEditor from "../CertificateSlotEditor.vue";

const registration = {
  id: "R1",
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

  it("并发保存两个位置时，一个完成不会提前解除另一个位置的忙碌状态", async () => {
    const slotOne = deferred();
    const slotTwo = deferred();
    apiMock.mockImplementation((path, options = {}) => {
      if (path === "/api/admin/certificates/C1" && options.method === "PATCH") return slotOne.promise;
      if (path === "/api/admin/certificates/C2" && options.method === "PATCH") return slotTwo.promise;
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
});
