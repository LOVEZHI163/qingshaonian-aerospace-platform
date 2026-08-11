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
      name: "吴琛琛",
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
