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
  it("places the approved introduction and organization copy in full-width sections", () => {
    const model = buildPublicEventContent("about", { event: current, detail: null, site: {} });

    expect(model.sections).toEqual([
      {
        heading: "大赛介绍",
        paragraphs: [
          "温州市青少年航空航天创新比赛由温州市关心下一代工作委员会、温州市教育局、温州市体育局、共青团温州市委员会、温州市妇女联合会、温州市科学技术协会面向中小学生开展的全市竞赛活动。大赛坚持公益性、规范性、普惠性原则，将充分发挥竞赛育人功能，丰富中小学生课余生活，以提升青少年航空航天学习实践、激发创新创造思维和探索实践能力为核心目标，推动全市青少年科技体育活动的蓬勃开展，引导广大青少年树立科学志向、崇尚探索精神、勤于动手实践、勇于创新成才。"
        ],
        wide: true
      },
      {
        heading: "组织机构",
        paragraphs: [
          "大赛由温州市关心下一代工作委员会、温州市教育局、温州市体育局、共青团温州市委员会、温州市妇女联合会、温州市科学技术协会共同主办，2026年由文成县关心下一代工作委员会、文成县教育局、文成县文化和广电旅游体育局、共青团文成县委员会、文成县妇女联合会、文成县科学技术协会承办。"
        ],
        wide: true
      }
    ]);
  });

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

  it("omits project and group sections when the detail arrays are empty", () => {
    const model = buildPublicEventContent("projects", {
      event: current,
      detail: { projects: [], groups: [] },
      site: {}
    });

    expect(model.sections).toEqual([]);
  });

  it("models approved and generic contacts with normalized dial links", () => {
    const approved = buildPublicEventContent("contact", { event: current, detail: null, site: {} });
    const generic = buildPublicEventContent("contact", {
      event: {
        ...current,
        slug: "summer-cup",
        contact: "赛事组委会 0577-12345678 / 138 0013 8000"
      },
      detail: null,
      site: {}
    });

    expect(approved.sections[0].contact).toEqual({
      name: "吴老师",
      phones: [
        { label: "88968723", href: "tel:88968723" },
        { label: "15858799111", href: "tel:15858799111" }
      ]
    });
    expect(generic.sections[0].contact).toEqual({
      name: "赛事组委会",
      phones: [
        { label: "0577-12345678", href: "tel:057712345678" },
        { label: "138 0013 8000", href: "tel:13800138000" }
      ]
    });
  });

  it("keeps whitespace-separated phone numbers as distinct dial links", () => {
    const model = buildPublicEventContent("contact", {
      event: {
        ...current,
        slug: "winter-cup",
        contact: "张老师 0577-12345678 13800138000"
      },
      detail: null,
      site: {}
    });

    expect(model.sections[0].contact).toEqual({
      name: "张老师",
      phones: [
        { label: "0577-12345678", href: "tel:057712345678" },
        { label: "13800138000", href: "tel:13800138000" }
      ]
    });
  });

  it("uses safe platform copy when no public event exists", () => {
    const model = buildPublicEventContent("about", { event: null, detail: null, site: { platformIntro: "平台公开介绍" } });
    expect(model.lead).toBe("平台公开介绍");
    expect(model.actions[0]).toEqual({ label: "查看历届赛事", href: "/history" });
  });
});
