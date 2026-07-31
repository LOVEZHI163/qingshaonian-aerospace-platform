import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadFileMock, apiUrlMock } = vi.hoisted(() => ({ uploadFileMock: vi.fn(), apiUrlMock: vi.fn((path) => `https://api.example${path}`) }));
vi.mock("../../lib/upload.js", () => ({ uploadFile: uploadFileMock }));
vi.mock("../../lib/api.js", () => ({ apiUrl: apiUrlMock }));

import SubmissionAssetUploader from "../SubmissionAssetUploader.vue";

const image = { id: "SA1", kind: "artwork_image", originalName: "work.png", mimeType: "image/png", sizeBytes: 1024, width: 800, height: 600, warnings: [] };
const video = { id: "SA2", kind: "creation_video", originalName: "making.mp4", mimeType: "video/mp4", sizeBytes: 2048, width: 1280, height: 720, durationMs: 12_000, warnings: [] };

function mountUploader(props = {}) {
  return mount(SubmissionAssetUploader, {
    props: { sessionId: "US1", mode: "image_video", assets: {}, ...props }
  });
}

function deferredUpload(options) {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  options.signal?.addEventListener("abort", () => reject(new DOMException("上传已取消", "AbortError")), { once: true });
  return { promise, resolve, reject };
}

async function choose(wrapper, action, file) {
  const input = wrapper.get(`[data-action="${action}"]`);
  Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
  await input.trigger("change");
  await flushPromises();
}

beforeEach(() => {
  uploadFileMock.mockReset();
  apiUrlMock.mockClear();
  URL.createObjectURL = vi.fn(() => "blob:artwork-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => vi.restoreAllMocks());

describe("SubmissionAssetUploader", () => {
  it("renders the two required cards only for image-video projects with exact file accepts", () => {
    const hidden = mountUploader({ mode: "none" });
    expect(hidden.find("[data-asset-card]").exists()).toBe(false);

    const wrapper = mountUploader();
    expect(wrapper.findAll("[data-asset-card]")).toHaveLength(2);
    expect(wrapper.get('[data-action="choose-artwork_image"]').attributes("accept")).toBe(".jpg,.jpeg,.png");
    expect(wrapper.get('[data-action="choose-creation_video"]').attributes("accept")).toBe(".mp4");
  });

  it("shows a successful image preview, dimensions and size without retaining the file", async () => {
    uploadFileMock.mockResolvedValue({ row: image });
    const wrapper = mountUploader();

    await choose(wrapper, "choose-artwork_image", new File(["image"], "work.png", { type: "image/png" }));

    expect(wrapper.get('[data-asset-card="artwork_image"] img').attributes("src")).toBe("blob:artwork-preview");
    expect(wrapper.text()).toContain("800 × 600");
    expect(wrapper.text()).toContain("1 KB");
    expect(uploadFileMock).toHaveBeenCalledWith("/api/upload-sessions/US1/artwork-image", expect.any(File), expect.objectContaining({ onProgress: expect.any(Function) }));
  });

  it("shows advisory warnings without preventing a complete pair", async () => {
    uploadFileMock.mockResolvedValue({ row: { ...image, warnings: ["作品图片长边低于建议的 780 像素"] } });
    const wrapper = mountUploader({ assets: { creation_video: video } });

    await choose(wrapper, "choose-artwork_image", new File(["image"], "work.png", { type: "image/png" }));

    expect(wrapper.text()).toContain("作品图片长边低于建议的 780 像素");
    expect(wrapper.emitted("complete").at(-1)).toEqual([true]);
  });

  it("keeps an uploaded image when video upload fails", async () => {
    uploadFileMock.mockRejectedValue(new Error("视频上传失败"));
    const wrapper = mountUploader({ assets: { artwork_image: image } });

    await choose(wrapper, "choose-creation_video", new File(["video"], "making.mp4", { type: "video/mp4" }));

    expect(wrapper.text()).toContain("work.png");
    expect(wrapper.get('[data-asset-card="creation_video"] [role="alert"]').text()).toContain("视频上传失败");
  });

  it("emits complete true only after both asset kinds succeed", async () => {
    uploadFileMock.mockResolvedValueOnce({ row: image }).mockResolvedValueOnce({ row: video });
    const wrapper = mountUploader();

    await choose(wrapper, "choose-artwork_image", new File(["image"], "work.png", { type: "image/png" }));
    expect(wrapper.emitted("complete").some(([complete]) => complete === true)).toBe(false);
    await choose(wrapper, "choose-creation_video", new File(["video"], "making.mp4", { type: "video/mp4" }));

    expect(wrapper.emitted("complete").at(-1)).toEqual([true]);
  });

  it("uses authenticated API URLs for persisted previews and revokes replaced URLs on unmount", async () => {
    const wrapper = mountUploader({ assets: { artwork_image: { ...image, previewUrl: "/api/me/events/E1/registrations/R1/assets/artwork_image" } } });
    expect(wrapper.get('[data-asset-card="artwork_image"] img').attributes("src")).toBe("https://api.example/api/me/events/E1/registrations/R1/assets/artwork_image");

    uploadFileMock.mockResolvedValue({ row: image });
    await choose(wrapper, "choose-artwork_image", new File(["image"], "work.png", { type: "image/png" }));
    wrapper.unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:artwork-preview");
  });

  it("cancels an unmounted upload so its late response cannot create a preview or completion event", async () => {
    let pending;
    uploadFileMock.mockImplementation((_path, _file, options) => {
      pending = deferredUpload(options);
      return pending.promise;
    });
    const complete = vi.fn();
    const wrapper = mountUploader({ onComplete: complete });

    await choose(wrapper, "choose-artwork_image", new File(["image"], "work.png", { type: "image/png" }));
    const completionsBeforeUnmount = complete.mock.calls.length;
    wrapper.unmount();
    pending.resolve({ row: image });
    await flushPromises();

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(completionsBeforeUnmount);
  });

  it("cancels a prior upload of the same kind and ignores its late result", async () => {
    const uploads = [];
    uploadFileMock.mockImplementation((_path, _file, options) => {
      const pending = deferredUpload(options);
      uploads.push(pending);
      return pending.promise;
    });
    const wrapper = mountUploader();

    await choose(wrapper, "choose-artwork_image", new File(["old"], "old.png", { type: "image/png" }));
    await choose(wrapper, "choose-artwork_image", new File(["new"], "new.png", { type: "image/png" }));
    uploads[0].resolve({ row: { ...image, originalName: "old.png" } });
    uploads[1].resolve({ row: { ...image, id: "SA3", originalName: "new.png" } });
    await flushPromises();

    expect(wrapper.text()).toContain("new.png");
    expect(wrapper.text()).not.toContain("old.png");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("cancels a stale session upload and clears all state when supplied assets become empty", async () => {
    let pending;
    uploadFileMock.mockImplementation((_path, _file, options) => {
      pending = deferredUpload(options);
      return pending.promise;
    });
    const wrapper = mountUploader({ assets: { artwork_image: image, creation_video: video } });
    await choose(wrapper, "choose-artwork_image", new File(["replacement"], "replacement.png", { type: "image/png" }));
    await wrapper.setProps({ sessionId: "US2", assets: {} });
    pending.resolve({ row: { ...image, originalName: "stale.png" } });
    await flushPromises();

    expect(wrapper.text()).not.toContain("work.png");
    expect(wrapper.text()).not.toContain("making.mp4");
    expect(wrapper.text()).not.toContain("stale.png");
    expect(wrapper.emitted("complete").at(-1)).toEqual([false]);
  });

  it("releases a local artwork URL when complete assets are cleared", async () => {
    uploadFileMock.mockResolvedValue({ row: image });
    const wrapper = mountUploader({ assets: { creation_video: video } });
    await choose(wrapper, "choose-artwork_image", new File(["image"], "work.png", { type: "image/png" }));

    await wrapper.setProps({ assets: {} });

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:artwork-preview");
    expect(wrapper.text()).not.toContain("work.png");
    expect(wrapper.emitted("complete").at(-1)).toEqual([false]);
  });
});
