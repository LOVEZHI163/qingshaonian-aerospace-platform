import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock } = vi.hoisted(() => ({ apiMock: vi.fn(), apiBlobMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock }));

import SiteMediaManagementPanel from "../SiteMediaManagementPanel.vue";

const rows = [
  {
    id: "M1", eventId: "E1", purpose: "event-hero", visibility: "public", originalName: "赛事海报.png",
    mimeType: "image/png", sizeBytes: 2048, width: 1200, height: 400, createdAt: "2026-08-14T08:00:00.000Z",
    previewUrl: "/api/admin/site-media/M1/preview", downloadUrl: "/api/admin/site-media/M1/download",
    referenceCount: 1, canDelete: false, references: [{ kind: "event-hero", label: "赛事封面", eventName: "2026 赛事", entityId: "E1" }]
  },
  {
    id: "M2", eventId: null, purpose: "content-cover", visibility: "draft", originalName: "未使用.png",
    mimeType: "image/png", sizeBytes: 1024, width: 600, height: 400, createdAt: "2026-08-13T08:00:00.000Z",
    previewUrl: "/api/admin/site-media/M2/preview", downloadUrl: "/api/admin/site-media/M2/download",
    referenceCount: 0, canDelete: true, references: []
  }
];

function listPayload(overrides = {}) {
  return {
    rows,
    summary: { total: 2, sizeBytes: 3072, referenced: 1, unreferenced: 1 },
    pagination: { page: 1, limit: 12, total: 2, pages: 1 },
    ...overrides
  };
}

async function mountLoaded() {
  const wrapper = mount(SiteMediaManagementPanel, { props: { events: [{ id: "E1", name: "2026 赛事" }] } });
  await flushPromises();
  return wrapper;
}

describe("SiteMediaManagementPanel", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiMock.mockResolvedValue(listPayload());
    apiBlobMock.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("loads managed media with summary cards and complete reference details", async () => {
    const wrapper = await mountLoaded();
    expect(apiMock.mock.calls[0][0]).toContain("/api/admin/site-media?managed=1");
    expect(wrapper.get('[data-summary="total"]').text()).toContain("2");
    expect(wrapper.get('[data-media-card="M1"] img').attributes("src")).toBe("/api/admin/site-media/M1/preview");
    expect(wrapper.get('[data-media-card="M1"]').text()).toContain("赛事封面");
    expect(wrapper.get('[data-media-card="M1"]').text()).toContain("2026 赛事");
    expect(wrapper.get('[data-delete-media="M1"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-download-media="M2"]').element.tagName).toBe("BUTTON");
  });

  it("applies filters through the management API and resets to page one", async () => {
    const wrapper = await mountLoaded();
    await wrapper.get('[data-media-filter="q"]').setValue("海报");
    await wrapper.get('[data-media-filter="purpose"]').setValue("event-hero");
    await wrapper.get('[data-action="search-media-management"]').trigger("click");
    await flushPromises();

    const path = apiMock.mock.calls.at(-1)[0];
    expect(path).toContain("q=%E6%B5%B7%E6%8A%A5");
    expect(path).toContain("purpose=event-hero");
    expect(path).toContain("page=1");
  });

  it("deletes an unreferenced image and reports partial bulk deletion", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-media/M2" && options.method === "DELETE") return null;
      if (path === "/api/admin/site-media/bulk-delete") return { deleted: ["M2"], skipped: [{ id: "M1", code: "MEDIA_IN_USE", reason: "仍被赛事封面引用" }] };
      return listPayload();
    });
    const wrapper = await mountLoaded();
    await wrapper.get('[data-delete-media="M2"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/admin/site-media/M2", { method: "DELETE" });

    await wrapper.get('[data-select-media="M1"]').setValue(true);
    await wrapper.get('[data-select-media="M2"]').setValue(true);
    await wrapper.get('[data-action="bulk-delete-media"]').trigger("click");
    await flushPromises();
    const bulk = apiMock.mock.calls.find(([path]) => path === "/api/admin/site-media/bulk-delete");
    expect(JSON.parse(bulk[1].body).ids.sort()).toEqual(["M1", "M2"]);
    expect(wrapper.get('[data-media-feedback]').text()).toContain("删除 1 张");
    expect(wrapper.get('[data-media-feedback]').text()).toContain("跳过 1 张");
    expect(wrapper.get('[data-media-skipped]').text()).toContain("仍被赛事封面引用");
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("预计删除 1 张，跳过 1 张正在使用图片"));
  });

  it("selects the current page and downloads through the authenticated blob API", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const wrapper = await mountLoaded();
    await wrapper.get('[data-action="select-page-media"]').trigger("click");
    expect(wrapper.text()).toContain("已选 2 张");
    await wrapper.get('[data-download-media="M2"]').trigger("click");
    await flushPromises();
    expect(apiBlobMock).toHaveBeenCalledWith("/api/admin/site-media/M2/download");
    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
    await wrapper.get('[data-action="select-page-media"]').trigger("click");
    expect(wrapper.text()).toContain("已选 0 张");
  });

  it("shows authenticated download failures instead of downloading an error payload", async () => {
    apiBlobMock.mockRejectedValueOnce(new Error("会话已失效"));
    const wrapper = await mountLoaded();
    await wrapper.get('[data-download-media="M2"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("会话已失效");
  });

  it("replaces a referenced image after confirmation", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/site-media/M1/replace") return { row: { ...rows[0], id: "M3" }, migratedReferences: 1 };
      return listPayload();
    });
    const wrapper = await mountLoaded();
    const input = wrapper.get('[data-replace-media="M1"]');
    const file = new File([new Uint8Array([1, 2, 3])], "new.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await flushPromises();

    const replace = apiMock.mock.calls.find(([path]) => path === "/api/admin/site-media/M1/replace");
    expect(replace[1].method).toBe("POST");
    expect(replace[1].body).toBeInstanceOf(FormData);
    expect(wrapper.get('[data-media-feedback]').text()).toContain("迁移 1 处引用");
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("赛事封面：2026 赛事"));
  });
});
