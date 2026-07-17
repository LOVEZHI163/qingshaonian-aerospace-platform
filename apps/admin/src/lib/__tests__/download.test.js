import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBlobDownloadManager } from "../download.js";

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
});
