import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import ResourceCleanupPanel from "../ResourceCleanupPanel.vue";

const archivedEvent = { id: "E-OLD", name: "2025 航空赛", status: "archived", isCurrent: false };

describe("ResourceCleanupPanel", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/events/E-OLD/storage") return { certificateFiles: 3, importFiles: 2, totalBytes: 2048 };
      if (path === "/api/admin/events/E-OLD/cleanup" && options.method === "POST") return { certificateFiles: 3, importFiles: 2, totalBytes: 2048, deletedFiles: 5, failedFiles: [] };
      if (path === "/api/admin/events/E-OLD" && options.method === "DELETE") return { deletedEventId: "E-OLD", deletedFiles: 5, failedFiles: [] };
      throw new Error(`unexpected request: ${path}`);
    });
  });

  it("shows archived event storage and confirms selected cleanup categories", async () => {
    const wrapper = mount(ResourceCleanupPanel, { props: { event: archivedEvent } });
    await flushPromises();

    expect(wrapper.text()).toContain("3");
    expect(wrapper.text()).toContain("2");
    expect(wrapper.text()).toContain("2 KB");
    await wrapper.get('[data-action="open-cleanup"]').trigger("click");
    expect(wrapper.text()).toContain("保留报名、成绩和证书记录");
    await wrapper.get('[data-action="confirm-cleanup"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E-OLD/cleanup", {
      method: "POST",
      body: JSON.stringify({ categories: ["certificates", "imports"] })
    });
    expect(wrapper.emitted("cleaned")).toHaveLength(1);
  });

  it("requires the complete event name before permanent deletion", async () => {
    const wrapper = mount(ResourceCleanupPanel, { props: { event: archivedEvent } });
    await flushPromises();
    await wrapper.get('[data-action="open-delete"]').trigger("click");

    const confirm = wrapper.get('[data-action="confirm-danger"]');
    expect(confirm.attributes("disabled")).toBeDefined();
    await wrapper.get('[data-testid="danger-confirm-name"]').setValue("2025 航空赛");
    expect(wrapper.get('[data-action="confirm-danger"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-action="confirm-danger"]').trigger("click");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/events/E-OLD", {
      method: "DELETE",
      body: JSON.stringify({ confirmName: "2025 航空赛" })
    });
    expect(wrapper.emitted("deleted")).toEqual([["E-OLD"]]);
  });

  it("does not expose cleanup controls for non-archived or current events", async () => {
    const wrapper = mount(ResourceCleanupPanel, { props: { event: { ...archivedEvent, status: "published", isCurrent: true } } });
    await flushPromises();
    expect(wrapper.find('[data-action="open-cleanup"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="open-delete"]').exists()).toBe(false);
    expect(apiMock).not.toHaveBeenCalled();
  });
});
