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

  it("accepts a development web build with a production API", async () => {
    const request = vi.fn().mockResolvedValue({ releaseSha: "a".repeat(40), apiVersion: 1 });

    await expect(checkReleaseCompatibility(request, "development")).resolves.toEqual({
      compatible: true,
      webRelease: "development",
      apiRelease: "a".repeat(40)
    });
  });

  it("accepts a production web build with a development API", async () => {
    const request = vi.fn().mockResolvedValue({ releaseSha: "development", apiVersion: 1 });

    await expect(checkReleaseCompatibility(request, "b".repeat(40))).resolves.toEqual({
      compatible: true,
      webRelease: "b".repeat(40),
      apiRelease: "development"
    });
  });
});
