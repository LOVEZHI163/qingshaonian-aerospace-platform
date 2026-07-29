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
    expect(contentPublicationState({
      content,
      event: { id: "E1", status: "published" },
      profile: { eventId: "E1", isVisible: false }
    })).toMatchObject({
      blockingIssues: [],
      warnings: [{ code: "event-hidden" }]
    });
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

  it.each(["<script>文字</script>", "<style>文字</style>", "<p>&nbsp;</p>"])("blocks body that is empty after editor sanitization: %s", (bodyHtml) => {
    expect(contentPublicationState({
      content: { ...content, eventId: null, bodyHtml },
      event: null,
      profile: null
    }).blockingIssues).toContainEqual(expect.objectContaining({ code: "body" }));
  });
});

describe("ContentPublicationReview", () => {
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
});
