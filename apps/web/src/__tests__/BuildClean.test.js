import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("web build cleanup", () => {
  it("emits responsive navigation and event information rules in the production CSS bundle", { timeout: 30_000 }, () => {
    const webRoot = resolve(process.cwd());
    const styles = readFileSync(resolve(webRoot, "src", "styles.css"), "utf8");
    const navigationStyles = readFileSync(resolve(webRoot, "src", "styles", "navigation.css"), "utf8");
    const eventInformationStyles = readFileSync(resolve(webRoot, "src", "styles", "event-information.css"), "utf8");

    expect(styles).toContain('@import "./styles/navigation.css"');
    expect(styles).toContain('@import "./styles/event-information.css"');
    expect(navigationStyles).not.toMatch(/\.mobile-brand-name\s*,\s*\.menu-trigger\s*\{[^}]*display:\s*none/);
    expect(navigationStyles).toMatch(/\.menu-trigger\s*\{[^}]*display:\s*none/);
    expect(navigationStyles).toMatch(/\.site-header-inner\s*\{[^}]*grid-template-columns:\s*minmax\(14rem,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto/);
    expect(navigationStyles).toMatch(/\.brand-wordmark\s*\{[^}]*width:\s*min\(20rem,\s*22vw\)/);
    expect(navigationStyles).toMatch(/@media\s*\(max-width:\s*1280px\)[\s\S]*\.menu-trigger\s*\{[^}]*display:\s*grid/);
    expect(navigationStyles).toMatch(/@media\s*\(max-width:\s*1280px\)[\s\S]*\.public-mobile-navigation:not\(\[hidden\]\)\s*\{[^}]*display:\s*block/);
    expect(navigationStyles).not.toContain(".public-mega-drawer-featured");
    expect(navigationStyles).not.toContain(".public-mega-drawer-mobile-navigation");
    expect(eventInformationStyles).toMatch(/\.event-information-hero p\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
    expect(eventInformationStyles).toMatch(/\.event-information-hero\s*\{[^}]*position:\s*relative[^}]*overflow:\s*hidden/);
    expect(eventInformationStyles).toMatch(/\.event-information-hero-media img\s*\{[^}]*object-fit:\s*cover/);
    expect(eventInformationStyles).toMatch(/\.event-information-hero-copy\s*\{[^}]*width:\s*min\(42rem,\s*66%\)/);
    expect(eventInformationStyles).toMatch(/\.event-information-contact\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
    expect(eventInformationStyles).toMatch(/\.event-information-sections li\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
    expect(eventInformationStyles).toMatch(/\.event-information-section-wide\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(eventInformationStyles).toMatch(/\.event-information-document\s*\{[^}]*margin:\s*1\.25rem\s+0/);

    const buildCommand = process.platform === "win32"
      ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm run build"] }
      : { command: "npm", args: ["run", "build"] };
    const result = spawnSync(buildCommand.command, buildCommand.args, {
      cwd: webRoot,
      encoding: "utf8"
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Could not resolve");

    const assets = resolve(webRoot, "dist", "assets");
    const cssBundle = readdirSync(assets).find((file) => file.endsWith(".css"));
    expect(cssBundle).toBeDefined();
    const css = readFileSync(resolve(assets, cssBundle), "utf8");

    expect(css).toContain(".public-mega-drawer{position:absolute");
    expect(css).toContain("@media(max-width:1280px)");
    expect(css).toContain("prefers-reduced-motion:reduce");
    expect(css).toContain(".event-information-page{width:min(var(--content-max),calc(100% - 2.5rem))");
    expect(css).toContain(".public-mobile-navigation{display:none");
    expect(css).not.toContain(".public-mega-drawer-featured");
    expect(css).toMatch(/\.event-information-facts dd\{[^}]*min-width:0[^}]*overflow-wrap:anywhere/);
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
