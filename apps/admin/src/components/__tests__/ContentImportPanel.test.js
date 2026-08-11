import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock, apiUrl: (path) => path }));

import ContentImportPanel from "../ContentImportPanel.vue";

const events = [{ id: "E1", name: "2026赛事" }];
const batch = {
  id: "SCI-1", sourceUrl: "https://example.com/news", sourceName: "温州发布", sourceAuthor: "作者甲",
  sourcePublishedAt: "2026-08-10T00:00:00.000Z", title: "文章标题", summary: "文章摘要",
  previewHtml: '<p>正文<img src="/api/admin/content-imports/SCI-1/images/IMG-1"></p>',
  warnings: [{ code: "IMPORT_STORAGE_WARNING", message: "磁盘空间不足" }],
  images: [
    { id: "IMG-1", status: "ready", originalName: "one.png", coverCandidate: true },
    { id: "IMG-2", status: "failed", originalName: "two.png", reason: "下载失败" }
  ]
};

describe("ContentImportPanel", () => {
  beforeEach(() => apiMock.mockReset());

  it("guides URL inspection then shows editable preview and image actions", async () => {
    apiMock.mockResolvedValueOnce({ row: batch }).mockResolvedValueOnce({ row: { ...batch.images[1], status: "ready" } });
    const wrapper = mount(ContentImportPanel, { props: { events } });
    expect(wrapper.text()).toContain("粘贴微信公众号或新闻网页链接");
    expect(wrapper.find("[data-import-preview]").exists()).toBe(false);

    await wrapper.get('[data-field="sourceUrl"]').setValue(batch.sourceUrl);
    await wrapper.get('[data-action="inspect-import"]').trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-field="importTitle"]').element.value).toBe("文章标题");
    expect(wrapper.text()).toContain("作者甲");
    expect(wrapper.text()).toContain("磁盘空间不足");
    expect(wrapper.get('[data-import-preview]').html()).toContain("正文");
    expect(wrapper.get('[data-image="IMG-2"]').text()).toContain("下载失败");
    await wrapper.get('[data-image="IMG-2"] [data-action="retry-image"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenLastCalledWith("/api/admin/content-imports/SCI-1/images/IMG-2/retry", { method: "POST" });
  });

  it("commits only as a draft and emits the new content id", async () => {
    apiMock.mockResolvedValueOnce({ row: batch }).mockResolvedValueOnce({ row: { id: "POST-1", status: "draft" } });
    const wrapper = mount(ContentImportPanel, { props: { events } });
    await wrapper.get('[data-field="sourceUrl"]').setValue(batch.sourceUrl);
    await wrapper.get('[data-action="inspect-import"]').trigger("submit");
    await flushPromises();
    await wrapper.get('[data-field="importSlug"]').setValue("article-title");
    await wrapper.get('[data-action="commit-import"]').trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("仅保存为草稿，不会直接发布");
    expect(apiMock).toHaveBeenLastCalledWith("/api/admin/content-imports/SCI-1/commit", expect.objectContaining({ method: "POST" }));
    expect(wrapper.emitted("committed")).toEqual([["POST-1"]]);
  });

  it("opens an existing content item when the source is duplicated", async () => {
    apiMock.mockRejectedValueOnce({ code: "IMPORT_DUPLICATE_SOURCE", message: "重复", payload: { details: { contentId: "POST-OLD" } } });
    const wrapper = mount(ContentImportPanel, { props: { events } });
    await wrapper.get('[data-field="sourceUrl"]').setValue(batch.sourceUrl);
    await wrapper.get('[data-action="inspect-import"]').trigger("submit");
    await flushPromises();
    await wrapper.get('[data-action="open-existing-content"]').trigger("click");
    expect(wrapper.emitted("committed")).toEqual([["POST-OLD"]]);
  });

  it("cancels an active uncommitted batch before leaving", async () => {
    apiMock.mockResolvedValueOnce({ row: batch }).mockResolvedValueOnce({ row: { ...batch, status: "cancelled" } });
    const wrapper = mount(ContentImportPanel, { props: { events } });
    await wrapper.get('[data-field="sourceUrl"]').setValue(batch.sourceUrl);
    await wrapper.get('[data-action="inspect-import"]').trigger("submit");
    await flushPromises();
    await wrapper.get('[data-action="cancel-import"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenLastCalledWith("/api/admin/content-imports/SCI-1", { method: "DELETE" });
    expect(wrapper.emitted("cancel")).toEqual([[]]);
  });
});
