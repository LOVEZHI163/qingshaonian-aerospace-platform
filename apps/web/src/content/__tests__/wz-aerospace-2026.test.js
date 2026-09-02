import { describe, expect, it } from "vitest";

import { WZ_AEROSPACE_2026_COPY } from "../wz-aerospace-2026.js";

describe("2026 温州赛事章程", () => {
  it("同时列出 AI 短片个人赛和团队赛", () => {
    const competitionChapter = WZ_AEROSPACE_2026_COPY.rulesDocument.chapters
      .find((chapter) => chapter.heading === "第六章 赛事内容");
    const creativeCompetition = competitionChapter.items
      .find((item) => item.includes("青少年航空航天创意创作比赛"));

    expect(creativeCompetition).toContain("AI 短片创意创作个人赛");
    expect(creativeCompetition).toContain("AI 短片创意创作团队赛");
  });
});
