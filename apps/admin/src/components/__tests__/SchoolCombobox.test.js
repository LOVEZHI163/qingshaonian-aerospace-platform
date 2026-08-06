import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import SchoolCombobox from "../SchoolCombobox.vue";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

describe("SchoolCombobox", () => {
  beforeEach(() => { vi.useFakeTimers(); apiMock.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it("does not let an older school search overwrite newer options", async () => {
    const oldRequest = deferred(); const newRequest = deferred();
    apiMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const wrapper = mount(SchoolCombobox, { props: { modelValue: "" } });
    await wrapper.setProps({ modelValue: "实验" });
    await vi.advanceTimersByTimeAsync(300);
    await wrapper.setProps({ modelValue: "第二实验" });
    await vi.advanceTimersByTimeAsync(300);
    newRequest.resolve({ rows: ["第二实验小学"] }); await flushPromises();
    oldRequest.resolve({ rows: ["实验小学"] }); await flushPromises();

    expect(wrapper.findAll("option").map((option) => option.attributes("value"))).toEqual(["第二实验小学"]);
  });

  it("aborts active work on unmount and ignores AbortError", async () => {
    const pending = deferred();
    apiMock.mockImplementation((_path, { signal }) => {
      signal.addEventListener("abort", () => pending.resolve(Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      return pending.promise;
    });
    const wrapper = mount(SchoolCombobox, { props: { modelValue: "实验" } });
    await vi.advanceTimersByTimeAsync(300);
    wrapper.unmount();
    await flushPromises();

    expect(wrapper.findAll("option")).toHaveLength(0);
  });
});
