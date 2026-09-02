import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";

import { WZ_AEROSPACE_2026_COPY } from "../wz-aerospace-2026.js";

const extractDownloadedRulesText = async () => {
  const { downloadUrl } = WZ_AEROSPACE_2026_COPY.rulesDocument;
  expect(downloadUrl).toMatch(/\.docx$/);

  const rulesFile = resolve(process.cwd(), "public", downloadUrl.replace(/^\//, ""));
  const archive = await JSZip.loadAsync(await readFile(rulesFile));
  const documentXml = await archive.file("word/document.xml").async("text");

  return documentXml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
};

describe("2026 温州赛事章程", () => {
  it("同时列出 AI 短片个人赛和团队赛", () => {
    const competitionChapter = WZ_AEROSPACE_2026_COPY.rulesDocument.chapters
      .find((chapter) => chapter.heading === "第六章 赛事内容");
    const creativeCompetition = competitionChapter.items
      .find((item) => item.includes("青少年航空航天创意创作比赛"));

    expect(creativeCompetition).toContain("AI 短片创意创作个人赛");
    expect(creativeCompetition).toContain("AI 短片创意创作团队赛");
  });

  it("下载章程同步列出 AI 短片个人赛和团队赛", async () => {
    const downloadedRulesText = await extractDownloadedRulesText();

    expect(downloadedRulesText).toContain("AI 短片创意创作个人赛");
    expect(downloadedRulesText).toContain("AI 短片创意创作团队赛");
    expect(downloadedRulesText.indexOf("（一）青少年航模比赛"))
      .toBeLessThan(downloadedRulesText.indexOf("比赛设小学低年级组"));
  });
});
