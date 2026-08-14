import { describe, expect, it, vi } from "vitest";

import { recoverReleaseMismatch } from "../release-recovery.js";

describe("recoverReleaseMismatch", () => {
  it("reloads the same route with the API release marker", () => {
    const replace = vi.fn();
    const location = {
      href: "https://aerogp.cn/admin/?view=siteContent#media",
      replace
    };

    expect(recoverReleaseMismatch("new-api", location)).toBe(true);
    expect(replace).toHaveBeenCalledWith("/admin/?view=siteContent&releaseRefresh=new-api#media");
  });

  it("stops after one reload for the same API release", () => {
    const replace = vi.fn();
    const location = {
      href: "https://aerogp.cn/admin/?view=siteContent&releaseRefresh=new-api",
      replace
    };

    expect(recoverReleaseMismatch("new-api", location)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});
