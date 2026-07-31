import { describe, expect, it, vi } from "vitest";

import { checkReleaseCompatibility } from "../release.js";

describe("checkReleaseCompatibility", () => {
  it("accepts equal release identities", async () => {
    const request = vi.fn().mockResolvedValue({ releaseSha: "abc", apiVersion: 1 });

    await expect(checkReleaseCompatibility(request, "abc")).resolves.toEqual({
      compatible: true,
      webRelease: "abc",
      apiRelease: "abc"
    });
  });

  it("rejects unequal production identities", async () => {
    const request = vi.fn().mockResolvedValue({ releaseSha: "old-api", apiVersion: 1 });

    await expect(checkReleaseCompatibility(request, "new-web")).resolves.toEqual({
      compatible: false,
      webRelease: "new-web",
      apiRelease: "old-api"
    });
  });
});
