import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("web build cleanup", () => {
  it("imports the responsive navigation and event information stylesheet modules", () => {
    const webRoot = resolve(process.cwd());
    const styles = readFileSync(resolve(webRoot, "src", "styles.css"), "utf8");
    const navigation = readFileSync(resolve(webRoot, "src", "styles", "navigation.css"), "utf8");
    const eventInformation = readFileSync(resolve(webRoot, "src", "styles", "event-information.css"), "utf8");

    expect(styles).toContain('@import "./styles/navigation.css"');
    expect(styles).toContain('@import "./styles/event-information.css"');
    expect(navigation).toContain(".public-mega-drawer");
    expect(navigation).toContain("@media (max-width: 1120px)");
    expect(navigation).toContain("prefers-reduced-motion");
    expect(eventInformation).toContain(".event-information-page");
  });

  it("executes the prebuild cleaner and removes a stale dist sentinel", () => {
    const webRoot = resolve(process.cwd());
    const dist = resolve(webRoot, "dist");
    const cleaner = resolve(webRoot, "scripts", "clean-dist.mjs");
    const sentinel = join(dist, "stale-build-sentinel.txt");
    const hadDist = existsSync(dist);
    const backup = resolve(webRoot, `.dist-clean-test-${process.pid}-${Date.now()}`);

    expect(dirname(dist)).toBe(webRoot);
    if (hadDist) renameSync(dist, backup);

    try {
      mkdirSync(dist, { recursive: true });
      writeFileSync(sentinel, "stale build output", "utf8");

      const result = spawnSync(process.execPath, [cleaner], {
        cwd: webRoot,
        encoding: "utf8"
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(dist)).toBe(false);
    } finally {
      rmSync(dist, { recursive: true, force: true });
      if (hadDist && existsSync(backup)) renameSync(backup, dist);
      else rmSync(backup, { recursive: true, force: true });
    }
  });
});
