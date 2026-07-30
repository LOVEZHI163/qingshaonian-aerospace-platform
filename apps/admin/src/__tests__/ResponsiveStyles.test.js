import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("small-screen touch targets", () => {
  it("keeps every button and actionable credential link at least 44px tall at 320px", () => {
    const css = readFileSync("src/styles/admin.css", "utf8");
    const compactRules = css.match(/@media \(max-width: 480px\) \{([\s\S]*)$/)?.[1] || "";

    expect(compactRules).toMatch(/(?:^|\n)\s*button\s*\{[^}]*min-height:\s*44px;/);
    expect(compactRules).toMatch(/\.credential-link,[\s\S]*?\.site-preview-fallback,[\s\S]*?\.file-action\s*\{[^}]*min-height:\s*44px;/);
  });
});
