import { describe, expect, it } from "vitest";
import { buildPublicEventContent } from "../public-event-content.js";

const current = {
  id: "E1",
  slug: "wz-aerospace-2026",
  name: "2026年温州市青少年航空航天创新比赛",
  theme: "科技强国 未来有我",
  dateLabel: "2026年11月21-22日",
  venue: "温州市文成县东方职业技术学院",
  contact: "吴君玲 88968723 / 15858799111"
};

describe("public event content", () => {
  it("maps the approved document copy onto the current event", () => {
    const model = buildPublicEventContent("registration", { event: current, detail: null, site: {} });
    expect(model.title).toBe("报名流程");
    expect(model.sections.map((section) => section.heading)).toContain("报名资格与方式");
    expect(JSON.stringify(model)).toContain("2026年11月1日");
  });

  it("renders live projects and groups without hard-coding deleted projects", () => {
    const model = buildPublicEventContent("projects", {
      event: current,
      detail: { projects: [{ id: "P1", name: "无人机竞速", category: "飞行类" }], groups: ["小学高段"] },
      site: {}
    });
    expect(JSON.stringify(model)).toContain("无人机竞速");
    expect(JSON.stringify(model)).not.toContain("已删除赛项");
  });

  it("uses safe platform copy when no public event exists", () => {
    const model = buildPublicEventContent("about", { event: null, detail: null, site: { platformIntro: "平台公开介绍" } });
    expect(model.lead).toBe("平台公开介绍");
    expect(model.actions[0]).toEqual({ label: "查看历届赛事", href: "/history" });
  });
});
