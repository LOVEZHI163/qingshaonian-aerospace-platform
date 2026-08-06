import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBlobDownloadManager, createBlobPreviewManager } from "../download.js";

describe("createBlobDownloadManager", () => {
  beforeEach(() => { vi.useFakeTimers(); URL.createObjectURL = vi.fn((blob) => `blob:${blob.name}`); URL.revokeObjectURL = vi.fn(); vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("attaches links before click and releases each download after a delay", () => {
    const manager = createBlobDownloadManager();
    const clicked = vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function click() { expect(this.isConnected).toBe(true); });
    manager.save({ name: "one" }, "one.xlsx");
    vi.advanceTimersByTime(500);
    manager.save({ name: "two" }, "two.xlsx");

    expect(clicked).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:one");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:two");
    vi.advanceTimersByTime(500);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:two");
  });

  it("cleans all pending links immediately when disposed", () => {
    const manager = createBlobDownloadManager();
    manager.save({ name: "one" }, "one.xlsx"); manager.save({ name: "two" }, "two.xlsx");
    manager.dispose(); vi.advanceTimersByTime(1_000);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:one");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:two");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("prefers the safe server filename attached to a downloaded blob", () => {
    const manager = createBlobDownloadManager();
    const blob = { name: "fallback", fileName: "张三_纸飞机_一等奖.pdf" };
    const clicked = vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function click() {
      expect(this.download).toBe("张三_纸飞机_一等奖.pdf");
    });

    manager.save(blob, "fallback.pdf");

    expect(clicked).toHaveBeenCalledTimes(1);
  });
});

describe("createBlobPreviewManager", () => {
  let popup;

  beforeEach(() => {
    vi.useFakeTimers();
    popup = { location: { href: "about:blank" }, close: vi.fn(), opener: {} };
    vi.spyOn(window, "open").mockReturnValue(popup);
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens and registers a pending popup without noopener features, then disposes it", () => {
    const manager = createBlobPreviewManager();
    const reservation = manager.reserve();

    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(reservation).not.toBeNull();
    expect(popup.opener).toBeNull();

    manager.dispose();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("releases a navigated preview after 60 seconds without closing its window", () => {
    const manager = createBlobPreviewManager();
    const reservation = manager.reserve();
    manager.navigate(reservation, new Blob(["preview"]));

    vi.advanceTimersByTime(59_999);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("allows each reservation to navigate only once without replacing its URL or timer", () => {
    let created = 0;
    URL.createObjectURL.mockImplementation(() => `blob:preview-${++created}`);
    const manager = createBlobPreviewManager();
    const reservation = manager.reserve();

    expect(manager.navigate(reservation, new Blob(["first"]))).toBe(true);
    expect(manager.navigate(reservation, new Blob(["second"]))).toBe(false);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe("blob:preview-1");

    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  });

  it("clears a navigated preview timer on dispose", () => {
    const manager = createBlobPreviewManager();
    const reservation = manager.reserve();
    manager.navigate(reservation, new Blob(["preview"]));

    manager.dispose();
    vi.advanceTimersByTime(60_000);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    expect(popup.close).not.toHaveBeenCalled();
  });
});
