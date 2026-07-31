import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api.js";
import { uploadFile } from "../upload.js";

class FakeXhr {
  static instances = [];

  constructor() {
    this.upload = {};
    this.open = vi.fn();
    this.send = vi.fn();
    this.abort = vi.fn(() => this.onabort?.());
    this.getResponseHeader = vi.fn((name) => name === "content-type" ? this.contentType || "application/json" : null);
    FakeXhr.instances.push(this);
  }

  finish({ status = 201, body = "{}", contentType = "application/json" } = {}) {
    this.status = status;
    this.responseText = body;
    this.contentType = contentType;
    this.onload?.();
  }
}

afterEach(() => {
  FakeXhr.instances = [];
  vi.unstubAllGlobals();
});

describe("uploadFile", () => {
  it("uses credentialed PUT FormData and forwards native upload progress", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress = vi.fn();
    const file = new File(["video"], "creation.mp4", { type: "video/mp4" });
    const pending = uploadFile("/api/upload-sessions/US1/creation-video", file, { onProgress: progress });
    const request = FakeXhr.instances[0];

    request.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
    request.finish({ body: JSON.stringify({ row: { id: "SA1" } }) });

    await expect(pending).resolves.toEqual({ row: { id: "SA1" } });
    expect(request.withCredentials).toBe(true);
    expect(request.open).toHaveBeenCalledWith("PUT", "/api/upload-sessions/US1/creation-video");
    expect(request.send.mock.calls[0][0]).toBeInstanceOf(FormData);
    expect(request.send.mock.calls[0][0].get("file")).toBe(file);
    expect(progress).toHaveBeenCalledWith({ loaded: 50, total: 100, percent: 50 });
  });

  it("keeps JSON business errors but hides non-JSON response bodies", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const file = new File(["image"], "artwork.png", { type: "image/png" });

    const business = uploadFile("/api/upload", file);
    FakeXhr.instances[0].finish({ status: 422, body: JSON.stringify({ error: "图片尺寸不符合要求", code: "IMAGE_INVALID" }) });
    await expect(business).rejects.toMatchObject({
      name: "ApiError", status: 422, code: "IMAGE_INVALID", message: "图片尺寸不符合要求"
    });

    const html = uploadFile("/api/upload", file);
    FakeXhr.instances[1].finish({ status: 502, body: "<html>upstream diagnostic</html>", contentType: "text/html" });
    await expect(html).rejects.toEqual(expect.objectContaining({
      name: "ApiError", status: 502, message: "服务暂时不可用，请刷新后重试 (502)", payload: {}
    }));
  });

  it("aborts the request when its signal aborts", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const controller = new AbortController();
    const pending = uploadFile("/api/upload", new File(["x"], "work.png"), { signal: controller.signal });
    const request = FakeXhr.instances[0];

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request.abort).toHaveBeenCalledTimes(1);
  });
});
