import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiBlobMock, apiUrlMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  apiBlobMock: vi.fn(),
  apiUrlMock: vi.fn((path) => `https://api.example${path}`)
}));

vi.mock("../../lib/api.js", () => ({ api: apiMock, apiBlob: apiBlobMock, apiUrl: apiUrlMock }));
vi.mock("../SubmissionAssetUploader.vue", () => ({
  default: {
    props: ["sessionId", "mode", "assets"],
    emits: ["complete"],
    template: '<button type="button" data-testid="submission-uploader" @click="$emit(\'complete\', true)">素材已完成</button>'
  }
}));

import SubmissionAssetReview from "../SubmissionAssetReview.vue";

const registration = {
  id: "R1",
  projectId: "P1",
  submission: {
    required: true,
    complete: true,
    warnings: ["作画视频低于建议的 720P"],
    assets: {
      artwork_image: {
        kind: "artwork_image", originalName: "作品.png", mimeType: "image/png", sizeBytes: 1536,
        width: 800, height: 600, uploadedAt: "2026-07-31T08:00:00.000Z", warnings: []
      },
      creation_video: {
        kind: "creation_video", originalName: "作画.mp4", mimeType: "video/mp4", sizeBytes: 2048,
        width: 1280, height: 720, durationMs: 12_000, uploadedAt: "2026-07-31T08:01:00.000Z",
        warnings: ["作画视频低于建议的 720P"]
      }
    }
  }
};

function mountReview(props = {}) {
  return mount(SubmissionAssetReview, { props: { eventId: "E1", registration, ...props } });
}

describe("SubmissionAssetReview", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiBlobMock.mockReset();
    apiUrlMock.mockClear();
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
  });

  it("uses cookie-authenticated admin URLs for image and Range-capable video previews", () => {
    const wrapper = mountReview();

    expect(wrapper.get('[data-asset-kind="artwork_image"] img').attributes("src")).toBe("https://api.example/api/admin/events/E1/registrations/R1/assets/artwork_image");
    const video = wrapper.get('[data-asset-kind="creation_video"] video');
    expect(video.attributes("src")).toBe("https://api.example/api/admin/events/E1/registrations/R1/assets/creation_video");
    expect(video.attributes("controls")).toBeDefined();
    expect(video.attributes("preload")).toBe("metadata");
    expect(apiUrlMock.mock.calls.flat()).not.toContain(expect.stringMatching(/token/i));
  });

  it("shows metadata and warnings for both required assets", () => {
    const wrapper = mountReview();

    expect(wrapper.text()).toContain("1.5 KB");
    expect(wrapper.text()).toContain("800 × 600");
    expect(wrapper.text()).toContain("0:12");
    expect(wrapper.text()).toContain("上传时间");
    expect(wrapper.text()).toContain("作画视频低于建议的 720P");
  });

  it("does not render playback or download for a cleaned video", () => {
    const wrapper = mountReview({
      registration: {
        ...registration,
        submission: {
          ...registration.submission,
          complete: false,
          assets: {
            ...registration.submission.assets,
            creation_video: { ...registration.submission.assets.creation_video, cleanedAt: "2026-07-31T09:00:00.000Z" }
          }
        }
      }
    });

    const videoCard = wrapper.get('[data-asset-kind="creation_video"]');
    expect(videoCard.text()).toContain("视频文件已由管理员清理");
    expect(videoCard.find("video").exists()).toBe(false);
    expect(videoCard.find('[data-action="download-creation_video"]').exists()).toBe(false);
  });

  it("removes playback and download controls after a private asset reports a missing-file error", async () => {
    const wrapper = mountReview();
    const videoCard = wrapper.get('[data-asset-kind="creation_video"]');

    await videoCard.get("video").trigger("error");

    expect(videoCard.text()).toContain("文件缺失或损坏，无法播放或下载");
    expect(videoCard.find("video").exists()).toBe(false);
    expect(videoCard.find('[data-action="download-creation_video"]').exists()).toBe(false);
  });

  it("downloads an available original through apiBlob", async () => {
    apiBlobMock.mockResolvedValue(new Blob(["image"]));
    const wrapper = mountReview();

    await wrapper.get('[data-action="download-artwork_image"]').trigger("click");
    await flushPromises();

    expect(apiBlobMock).toHaveBeenCalledWith("/api/admin/events/E1/registrations/R1/assets/artwork_image");
  });

  it("creates an admin upload session, resumes replacement after an error, and asks the parent to refresh", async () => {
    let videoAttempts = 0;
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/admin/events/E1/projects/P1/upload-sessions") return { row: { id: "US1", assets: {} } };
      if (path.endsWith("/assets/artwork_image")) return { registration };
      if (path.endsWith("/assets/creation_video")) {
        videoAttempts += 1;
        if (videoAttempts === 1) throw new Error("video failed");
        return { registration };
      }
      throw new Error(`unexpected ${path} ${options?.method || ""}`);
    });
    const wrapper = mountReview();

    await wrapper.get('[data-action="replace-materials"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="submission-uploader"]').trigger("click");
    await wrapper.get('[data-action="confirm-replacement"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("作品图片已替换，作画视频仍待替换");
    await wrapper.get('[data-action="retry-replacement"]').trigger("click");
    await flushPromises();

    expect(apiMock.mock.calls.filter(([, options]) => options?.method === "PUT").map(([path]) => path)).toEqual([
      "/api/admin/events/E1/registrations/R1/assets/artwork_image",
      "/api/admin/events/E1/registrations/R1/assets/creation_video",
      "/api/admin/events/E1/registrations/R1/assets/creation_video"
    ]);
    expect(wrapper.emitted("refresh")?.length).toBeGreaterThan(0);
  });
});
