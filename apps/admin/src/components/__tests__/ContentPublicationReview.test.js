import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ContentPublicationReview from "../ContentPublicationReview.vue";
import { contentPublicationState } from "../../lib/content-publication-state.js";

const content = {
  id: "P1", slug: "news", title: "新闻", bodyHtml: "<p>正文</p>",
  eventId: "E1", type: "news", status: "draft", summary: "摘要", coverMediaId: "M1"
};

describe("contentPublicationState", () => {
  it("blocks publishing content assigned to a draft event", () => {
    expect(contentPublicationState({
      content,
      event: { id: "E1", status: "draft" },
      profile: null
    })).toMatchObject({
      blockingIssues: [{ code: "event-draft" }],
      resultLabel: "暂不能公开"
    });
  });

  it("warns when a published event remains hidden on the website", () => {
    const state = contentPublicationState({
      content,
      event: { id: "E1", status: "published" },
      profile: { eventId: "E1", isVisible: false }
    });
    expect(state).toMatchObject({
      blockingIssues: [],
      warnings: [{ code: "event-hidden" }],
      eventStatusLabel: "已发布",
      websiteStatusLabel: "隐藏"
    });
    expect(state.publicOutcome).toContain("全站内容列表和直接地址仍可访问");
    expect(state.publicEntry).toContain("赛事入口及关联链接隐藏");
  });

  it("reports platform content as publishable and archived content as historical", () => {
    expect(contentPublicationState({ content: { ...content, eventId: null }, event: null, profile: null }))
      .toMatchObject({ blockingIssues: [], resultLabel: "可以发布" });
    expect(contentPublicationState({
      content,
      event: { id: "E1", status: "archived" },
      profile: { eventId: "E1", isVisible: true }
    })).toMatchObject({ warnings: [{ code: "event-archived" }], resultLabel: "可以发布" });
  });

  it("blocks incomplete content and warns about a missing cover", () => {
    expect(contentPublicationState({
      content: { ...content, eventId: null, title: " ", slug: "", bodyHtml: "<p> </p>", coverMediaId: null },
      event: null,
      profile: null
    })).toMatchObject({
      blockingIssues: [{ code: "title" }, { code: "slug" }, { code: "body" }],
      warnings: [{ code: "cover" }]
    });
  });

  it("reports body, media, placement, and scheduled publication readiness", () => {
    expect(contentPublicationState({
      content: {
        ...content,
        status: "scheduled",
        publishAt: "2099-01-02T04:30:00.000Z",
        pinned: true,
        sortOrder: 7,
        attachments: [{ mediaId: "A1" }]
      },
      event: { id: "E1", status: "published" },
      profile: { eventId: "E1", isVisible: true }
    })).toMatchObject({
      bodyReady: true,
      bodyReadinessLabel: "正文已就绪",
      mediaReadinessLabel: "封面已就绪，1 个附件",
      placementLabel: "置顶，排序 7",
      publicationModeLabel: "定时发布",
      intendedPublishAt: "2099-01-02T04:30:00.000Z",
      eventStatusLabel: "已发布",
      websiteStatusLabel: "公开"
    });
  });

  it("keeps archived and hidden wording accurate without claiming the content is private", () => {
    const state = contentPublicationState({
      content,
      event: { id: "E1", status: "archived" },
      profile: { eventId: "E1", isVisible: false }
    });

    expect(state.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "event-archived" }),
      expect.objectContaining({ code: "event-hidden" })
    ]));
    expect(state.eventStatusLabel).toBe("已归档");
    expect(state.websiteStatusLabel).toBe("隐藏");
    expect(state.publicOutcome).toContain("全站内容列表和直接地址仍可访问");
    expect(state.publicEntry).toContain("历届赛事入口及关联链接隐藏");
  });

  it.each(["<script>文字</script>", "<style>文字</style>", "<p>&nbsp;</p>"])("blocks body that is empty after editor sanitization: %s", (bodyHtml) => {
    expect(contentPublicationState({
      content: { ...content, eventId: null, bodyHtml },
      event: null,
      profile: null
    }).blockingIssues).toContainEqual(expect.objectContaining({ code: "body" }));
  });
});

describe("ContentPublicationReview", () => {
  it.each([
    ["announcement", "通知公告"],
    ["news", "新闻动态"],
    ["work", "优秀作品"],
    ["recap", "赛事回顾"],
    ["guide", "参赛指南"]
  ])("renders %s with its approved label", (type, label) => {
    const wrapper = mount(ContentPublicationReview, {
      props: { content: { ...content, type } }
    });

    expect(wrapper.findAll(".event-facts > div")[1].text()).toContain(label);
  });

  it("renders unknown inherited object keys as their original safe fallback", () => {
    const wrapper = mount(ContentPublicationReview, {
      props: { content: { ...content, type: "toString" } }
    });

    const typeFact = wrapper.findAll(".event-facts > div")[1];
    expect(typeFact.text()).toContain("toString");
    expect(typeFact.text()).not.toContain("function");
  });

  it("disables publication for a draft event and links to event settings", async () => {
    const wrapper = mount(ContentPublicationReview, {
      props: { content, event: { id: "E1", name: "2026赛事", status: "draft" } }
    });

    expect(wrapper.get('[data-action="confirm-review-publish"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("归属赛事尚未发布");
    await wrapper.get('[data-action="go-event-settings"]').trigger("click");
    expect(wrapper.emitted("navigate")).toEqual([["events"]]);
  });

  it("announces blocking issues and non-blocking warnings with explicit status semantics", () => {
    const blocked = mount(ContentPublicationReview, {
      props: { content, event: { id: "E1", name: "2026赛事", status: "draft" } }
    });
    const warned = mount(ContentPublicationReview, {
      props: {
        content,
        event: { id: "E1", name: "2026赛事", status: "published" },
        profile: { eventId: "E1", isVisible: false }
      }
    });

    expect(blocked.get('[data-review-blocking-issues]').attributes("role")).toBe("alert");
    expect(warned.get('[data-review-warnings]').attributes("role")).toBe("status");
  });

  it("emits the requested review actions for complete publishable content", async () => {
    const wrapper = mount(ContentPublicationReview, {
      props: {
        content,
        event: { id: "E1", name: "2026赛事", status: "published" },
        profile: { eventId: "E1", isVisible: true }
      }
    });

    await wrapper.get('[data-action="review-preview"]').trigger("click");
    await wrapper.get('[data-action="back-to-editor"]').trigger("click");
    await wrapper.get('[data-action="confirm-review-publish"]').trigger("click");
    expect(wrapper.emitted("preview")).toEqual([[]]);
    expect(wrapper.emitted("back")).toEqual([[]]);
    expect(wrapper.emitted("publish")).toEqual([[]]);
  });

  it("renders the complete scheduled-publication facts and actual hidden-event outcome", () => {
    const wrapper = mount(ContentPublicationReview, {
      props: {
        content: {
          ...content,
          status: "scheduled",
          publishAt: "2099-01-02T04:30:00.000Z",
          pinned: true,
          sortOrder: 7,
          attachments: [{ mediaId: "A1" }]
        },
        event: { id: "E1", name: "2026赛事", status: "published" },
        profile: { eventId: "E1", isVisible: false }
      }
    });

    expect(wrapper.get('[data-review-fact="body"]').text()).toContain("正文已就绪");
    expect(wrapper.get('[data-review-fact="media"]').text()).toContain("封面已就绪，1 个附件");
    expect(wrapper.get('[data-review-fact="placement"]').text()).toContain("置顶，排序 7");
    expect(wrapper.get('[data-review-fact="publication"]').text()).toContain("定时发布");
    expect(wrapper.get('[data-review-fact="publication"]').text()).toContain("2099");
    expect(wrapper.get('[data-review-fact="event-status"]').text()).toContain("已发布");
    expect(wrapper.get('[data-review-fact="website-status"]').text()).toContain("隐藏");
    expect(wrapper.get('[data-review-public-outcome]').text()).toContain("全站内容列表和直接地址仍可访问");
    expect(wrapper.get('[data-review-public-entry]').text()).toContain("赛事入口及关联链接隐藏");
    expect(wrapper.get('[data-action="confirm-review-publish"]').text()).toBe("确认定时发布");
  });

  it("explains the archived hidden entry without hiding global or direct content access", () => {
    const wrapper = mount(ContentPublicationReview, {
      props: {
        content,
        event: { id: "E1", name: "往届赛事", status: "archived" },
        profile: { eventId: "E1", isVisible: false }
      }
    });

    expect(wrapper.get('[data-review-fact="event-status"]').text()).toContain("已归档");
    expect(wrapper.get('[data-review-fact="website-status"]').text()).toContain("隐藏");
    expect(wrapper.get('[data-review-public-outcome]').text()).toContain("全站内容列表和直接地址仍可访问");
    expect(wrapper.get('[data-review-public-entry]').text()).toContain("历届赛事入口及关联链接隐藏");
  });
});
