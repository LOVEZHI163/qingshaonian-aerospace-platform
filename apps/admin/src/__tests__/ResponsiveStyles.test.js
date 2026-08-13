import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("small-screen touch targets", () => {
  it("gives the leader review entry a visible icon in the collapsed admin rail", () => {
    const css = readFileSync("src/styles/admin.css", "utf8");

    expect(css).toMatch(/\.admin-sidebar \[data-nav="leaders"\]::before\s*\{\s*content:\s*"领";/);
  });

  it("keeps every button and actionable credential link at least 44px tall at 320px", () => {
    const css = readFileSync("src/styles/admin.css", "utf8");
    const compactRules = css.match(/@media \(max-width: 480px\) \{([\s\S]*)$/)?.[1] || "";

    expect(compactRules).toMatch(/(?:^|\n)\s*button\s*\{[^}]*min-height:\s*44px;/);
    expect(compactRules).toMatch(/\.credential-link,[\s\S]*?\.site-preview-fallback,[\s\S]*?\.file-action\s*\{[^}]*min-height:\s*44px;/);
    expect(compactRules).toMatch(/\.content-list-row-actions a\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*44px;[^}]*align-items:\s*center;/);
  });
});
