import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import ContentImageDialog from "../ContentImageDialog.vue";

describe("ContentImageDialog", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({ rows: [] });
  });

  it("lists and searches existing image media without exposing storage fields", async () => {
    apiMock.mockResolvedValueOnce({
      rows: [{
        id: "M1",
        originalName: "飞行.png",
        mimeType: "image/png",
        sizeBytes: 3,
        width: 320,
        height: 200,
        previewUrl: "/api/admin/site-media/M1/preview",
        storedName: "secret-stored-name.png",
        filePath: "C:\\private\\secret.png"
      }]
    });
    const wrapper = mount(ContentImageDialog, { props: { open: true } });
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/site-media?kind=image&limit=100&q=");
    expect(wrapper.get('[data-media-id="M1"] img').attributes("src")).toBe("/api/admin/site-media/M1/preview");
    expect(wrapper.text()).toContain("飞行.png");
    expect(wrapper.html()).not.toContain("secret-stored-name");
    expect(wrapper.html()).not.toContain("private");

    apiMock.mockResolvedValueOnce({ rows: [] });
    await wrapper.get('[data-field="media-search"]').setValue("比赛 现场");
    await wrapper.get('[data-action="search-media"]').trigger("submit");
    await flushPromises();
    expect(apiMock).toHaveBeenLastCalledWith("/api/admin/site-media?kind=image&limit=100&q=%E6%AF%94%E8%B5%9B%20%E7%8E%B0%E5%9C%BA");
  });

  it("uploads an image and emits the chosen media with alt and caption", async () => {
    apiMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        row: {
          id: "M-UPLOADED",
          originalName: "现场.png",
          mimeType: "image/png",
          sizeBytes: 3
        }
      });
    const wrapper = mount(ContentImageDialog, { props: { open: true } });
    await flushPromises();

    const file = new File(["png"], "现场.png", { type: "image/png" });
    const fileInput = wrapper.get('input[type="file"]');
    Object.defineProperty(fileInput.element, "files", { value: [file] });
    await fileInput.trigger("change");
    await flushPromises();
    await wrapper.get('[data-field="image-alt"]').setValue("飞行器");
    await wrapper.get('[data-field="image-caption"]').setValue("比赛现场");
    await wrapper.get('[data-action="confirm-image"]').trigger("click");

    expect(apiMock).toHaveBeenLastCalledWith("/api/admin/site-media", expect.objectContaining({
      method: "POST",
      body: expect.any(FormData)
    }));
    const upload = apiMock.mock.calls.at(-1)[1].body;
    expect(upload.get("purpose")).toBe("content-body");
    expect(upload.get("file").name).toBe("现场.png");
    expect(wrapper.emitted("select")[0][0]).toEqual({
      media: expect.objectContaining({ id: "M-UPLOADED" }),
      alt: "飞行器",
      caption: "比赛现场"
    });
  });

  it("keeps the dialog open and preserves fields after list or upload errors", async () => {
    apiMock.mockRejectedValueOnce(new Error("网络错误"));
    const wrapper = mount(ContentImageDialog, {
      props: { open: true, initial: { mediaId: "", alt: "原说明", caption: "原标题" } }
    });
    await flushPromises();

    expect(wrapper.get('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toContain("网络错误");
    expect(wrapper.get('[data-field="image-alt"]').element.value).toBe("原说明");
    expect(wrapper.get('[data-field="image-caption"]').element.value).toBe("原标题");
    expect(wrapper.get('[data-action="retry-media"]').exists()).toBe(true);

    apiMock.mockResolvedValueOnce({ rows: [] });
    await wrapper.get('[data-action="retry-media"]').trigger("click");
    await flushPromises();
    apiMock.mockRejectedValueOnce(new Error("上传失败"));
    const fileInput = wrapper.get('input[type="file"]');
    Object.defineProperty(fileInput.element, "files", {
      configurable: true,
      value: [new File(["png"], "失败.png", { type: "image/png" })]
    });
    await fileInput.trigger("change");
    await flushPromises();
    expect(wrapper.get('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toContain("上传失败");
    expect(wrapper.get('[data-field="image-alt"]').element.value).toBe("原说明");
    expect(wrapper.get('[data-field="image-caption"]').element.value).toBe("原标题");
  });

  it("only confirms a selected PNG JPEG or WebP row and never invents a preview URL", async () => {
    apiMock.mockResolvedValueOnce({
      rows: [
        { id: "M1", originalName: "安全.webp", mimeType: "image/webp", previewUrl: "/safe/preview" },
        { id: "M2", originalName: "不安全.svg", mimeType: "image/svg+xml", previewUrl: "data:image/svg+xml,bad" }
      ]
    });
    const wrapper = mount(ContentImageDialog, { props: { open: true } });
    await flushPromises();

    expect(wrapper.get('[data-action="confirm-image"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-media-id="M2"]').exists()).toBe(false);
    await wrapper.get('[data-media-id="M1"]').trigger("click");
    expect(wrapper.get('[data-action="confirm-image"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-media-id="M1"] img').attributes("src")).toBe("/safe/preview");
  });
});
