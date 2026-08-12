import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import ContentEditorPanel from "../ContentEditorPanel.vue";
import RichTextEditor from "../RichTextEditor.vue";

const events = [{ id: "E1", name: "2026赛事", status: "published" }];
const profiles = [{ eventId: "E1", isVisible: true }];
const row = {
  id: "POST-1", slug: "first-news", eventId: "E1", type: "news", title: "第一篇",
  summary: "摘要", bodyHtml: "<p>正文</p>", status: "draft", publishAt: null,
  pinned: false, sortOrder: 0, coverMediaId: null, attachments: [], version: 1,
  previewHtml: "<p>正文</p>"
};

function installApi(overrides = {}) {
  apiMock.mockImplementation(async (path, options = {}) => {
    const method = options.method || "GET";
    const key = `${method} ${path}`;
    if (overrides[key]) return overrides[key](options);
    if (method === "POST" && path.endsWith("/publish")) return { row: { ...row, status: "published", version: 2 } };
    if (method === "POST" && path.endsWith("/offline")) return { row: { ...row, status: "offline", version: 3 } };
    if (method === "PATCH" && path === "/api/admin/content/POST-1") return { row: { ...row, ...JSON.parse(options.body), title: "服务器规范标题", version: 9 } };
    if (method === "DELETE" && path === "/api/admin/content/POST-1") return {};
    if (method === "POST" && path === "/api/admin/content") return { row: { ...row, ...JSON.parse(options.body) } };
    if (method === "GET" && path === "/api/admin/content/POST-1") return { row: { ...row } };
    return {};
  });
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mountEditor(contentId = "POST-1") {
  const wrapper = mount(ContentEditorPanel, { props: { contentId, events, profiles } });
  await flushPromises();
  return wrapper;
}

describe("ContentEditorPanel", () => {
  beforeEach(() => { apiMock.mockReset(); installApi(); });

  it("shows approved content names while retaining API type values", async () => {
    const wrapper = await mountEditor();
    const options = wrapper.get('[data-content-field="type"]').findAll("option");

    expect(options.map((option) => [option.attributes("value"), option.text()])).toEqual([
      ["announcement", "通知公告"],
      ["news", "新闻动态"],
      ["work", "优秀作品"],
      ["recap", "赛事回顾"],
      ["guide", "参赛指南"]
    ]);
    expect(wrapper.get('[data-content-field="type"]').element.value).toBe("news");
  });

  it("saves the complete draft, reloads it, and previews only server-sanitized HTML", async () => {
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="title"]').setValue("管理员修改");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();

    const save = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/content/POST-1" && options?.method === "PATCH");
    expect(JSON.parse(save[1].body)).toMatchObject({ title: "管理员修改", version: 1, status: "draft", publishAt: null });

    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/content/POST-1") return { row: { ...row, bodyHtml: '<img src=x onerror="bad()">' } };
      if (path === "/api/admin/site-preview/content" && options.method === "POST") {
        return { preview: { payload: { row: { bodyHtml: "<p>服务端安全预览</p>" } } } };
      }
      return {};
    });
    await wrapper.get('[data-action="refresh-content"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="preview-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-preview-body]').html()).toContain("服务端安全预览");
    expect(wrapper.get('[data-preview-body]').html()).not.toContain("onerror");
  });

  it("saves dirty content before opening publication review", async () => {
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="title"]').setValue("准备发布");
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await flushPromises();

    const saveIndex = apiMock.mock.calls.findIndex(([path, options]) =>
      path === "/api/admin/content/POST-1" && options?.method === "PATCH"
    );
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(wrapper.get('[data-content-publication-review]').exists()).toBe(true);
    expect(wrapper.find("form.content-editor-form").exists()).toBe(false);
  });

  it("saves before opening a sanitized preview", async () => {
    installApi({
      "POST /api/admin/site-preview/content": async () => ({
        preview: { payload: { row: { bodyHtml: "<p>服务端保存后预览</p>" } } }
      })
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="title"]').setValue("保存后预览");
    await wrapper.get('[data-action="save-and-preview-content"]').trigger("click");
    await flushPromises();

    const saveIndex = apiMock.mock.calls.findIndex(([path, options]) =>
      path === "/api/admin/content/POST-1" && options?.method === "PATCH"
    );
    const previewIndex = apiMock.mock.calls.findIndex(([path, options]) =>
      path === "/api/admin/site-preview/content" && options?.method === "POST"
    );
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(previewIndex).toBeGreaterThan(saveIndex);
    expect(wrapper.get('[data-preview-body]').html()).toContain("服务端保存后预览");
  });

  it("does not preview or enter review when saving before a transition fails", async () => {
    installApi({
      "PATCH /api/admin/content/POST-1": async () => { throw new Error("保存失败"); }
    });
    const preview = apiMock.mock.calls.filter(([path]) => path === "/api/admin/site-preview/content");
    const previewWrapper = await mountEditor();
    await previewWrapper.get('[data-content-field="title"]').setValue("无法预览");
    await previewWrapper.get('[data-action="save-and-preview-content"]').trigger("click");
    await flushPromises();
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/admin/site-preview/content")).toHaveLength(preview.length);

    const reviewWrapper = await mountEditor();
    await reviewWrapper.get('[data-content-field="title"]').setValue("无法检查");
    await reviewWrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await flushPromises();
    expect(reviewWrapper.find('[data-content-publication-review]').exists()).toBe(false);
  });

  it("renders the three editing sections as ordered siblings", async () => {
    const wrapper = await mountEditor();
    const form = wrapper.get("form.content-editor-form");
    const sections = wrapper.findAll('[data-content-section]');
    expect(sections.map((section) => section.attributes("data-content-section"))).toEqual(["basics", "body-media", "display"]);
    expect(sections.every((section) => section.element.parentElement === form.element)).toBe(true);
    expect(sections[1].find(".content-media-field").exists()).toBe(true);
  });

  it("groups the editor into labeled sections with an accessible sticky action bar", async () => {
    const wrapper = await mountEditor();

    for (const name of ["basics", "body-media", "display"]) {
      expect(wrapper.get(`[data-content-section="${name}"]`).classes()).toContain("content-editor-section");
    }
    const actions = wrapper.get('[data-content-editor-actions]');
    expect(actions.attributes("role")).toBe("group");
    expect(actions.attributes("aria-label")).toBe("内容操作");
    expect(actions.classes()).toContain("content-editor-sticky-actions");
  });

  it("auto-generates a valid slug from a new title until the administrator edits it", async () => {
    const wrapper = await mountEditor(null);
    const title = wrapper.get('[data-content-field="title"]');
    const slug = wrapper.get('[data-content-field="slug"]');

    await title.setValue("Flight Day 2026");
    expect(slug.element.value).toBe("flight-day-2026");
    await title.setValue("Flight Day Finals");
    expect(slug.element.value).toBe("flight-day-finals");

    await slug.setValue("custom-flight-day");
    await title.setValue("Closing Ceremony");
    expect(slug.element.value).toBe("custom-flight-day");
    expect(wrapper.get("[data-slug-guidance]").text()).toContain("小写字母、数字和连字符");
  });

  it("shows inline slug validation and blocks persistence until the format is valid", async () => {
    const wrapper = await mountEditor(null);
    await wrapper.get('[data-content-field="title"]').setValue("Flight Day");
    const slug = wrapper.get('[data-content-field="slug"]');
    await slug.setValue("Bad slug!");

    expect(slug.attributes("aria-invalid")).toBe("true");
    expect(wrapper.get("[data-slug-error]").text()).toContain("小写字母");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    expect(apiMock.mock.calls.some(([path, options]) =>
      path === "/api/admin/content" && options?.method === "POST"
    )).toBe(false);

    await slug.setValue("valid-flight-day");
    expect(slug.attributes("aria-invalid")).toBe("false");
    expect(wrapper.find("[data-slug-error]").exists()).toBe(false);
  });

  it("focuses the slug field and suggests a useful alternative when it conflicts", async () => {
    installApi({
      "POST /api/admin/content": async () => {
        throw Object.assign(new Error("slug已存在"), { status: 409, code: "SLUG_CONFLICT" });
      }
    });
    const wrapper = mount(ContentEditorPanel, {
      attachTo: document.body,
      props: { contentId: null, events, profiles }
    });
    await flushPromises();
    await wrapper.get('[data-content-field="title"]').setValue("Flight Day");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();

    const slug = wrapper.get('[data-content-field="slug"]');
    expect(document.activeElement).toBe(slug.element);
    expect(wrapper.get("[data-slug-error]").text()).toContain("已被使用");
    expect(wrapper.get("[data-slug-error]").text()).toContain("flight-day-2");
    wrapper.unmount();
  });

  it.each(["published", "offline"])("keeps an already-public %s slug read-only", async (status) => {
    installApi({
      "GET /api/admin/content/POST-1": async () => ({
        row: { ...row, status, publishAt: "2026-01-01T00:00:00.000Z" }
      })
    });
    const wrapper = await mountEditor();

    expect(wrapper.get('[data-content-field="slug"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-slug-guidance]").text()).toContain("已固定");
  });

  it("does not request publish from review when its event is still a draft", async () => {
    const wrapper = mount(ContentEditorPanel, {
      props: { contentId: "POST-1", events: [{ ...events[0], status: "draft" }], profiles }
    });
    await flushPromises();
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await flushPromises();

    const publish = wrapper.get('[data-action="confirm-review-publish"]');
    expect(publish.attributes("disabled")).toBeDefined();
    await publish.trigger("click");
    expect(apiMock.mock.calls.some(([path]) => path.endsWith("/publish"))).toBe(false);
  });

  it("requires two explicit confirmations for publishing and offlining", async () => {
    const wrapper = await mountEditor();
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await wrapper.get('[data-action="confirm-review-publish"]').trigger("click");
    expect(wrapper.get('[role="dialog"]').text()).toContain("确认发布");
    expect(apiMock.mock.calls.some(([path]) => path.endsWith("/publish"))).toBe(false);
    await wrapper.get('[data-action="confirm-content-action"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已发布");
    expect(wrapper.find('[data-content-publication-review]').exists()).toBe(false);
    expect(apiMock.mock.calls.filter(([path]) => path.endsWith("/publish"))).toHaveLength(1);
    expect(wrapper.get('[data-action="save-content"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-action="delete-content"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-action="offline-content"]').trigger("click");
    expect(wrapper.get('[role="dialog"]').text()).toContain("确认下线");
    await wrapper.get('[data-action="confirm-content-action"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已下线");
  });

  it("keeps unsaved input and asks for refresh after a 409 conflict", async () => {
    installApi({
      "PATCH /api/admin/content/POST-1": async () => { throw Object.assign(new Error("冲突"), { status: 409 }); }
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="title"]').setValue("不能丢失的标题");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-content-field="title"]').element.value).toBe("不能丢失的标题");
    expect(wrapper.text()).toContain("内容已被其他管理员更新，请刷新后重试");
  });

  it("focuses the body media section and preserves the draft when body media is rejected", async () => {
    const wrapper = mount(ContentEditorPanel, {
      attachTo: document.body,
      props: { contentId: "POST-1", events, profiles }
    });
    await flushPromises();
    await wrapper.get('[data-content-field="title"]').setValue("保留的标题");
    apiMock.mockRejectedValueOnce(Object.assign(new Error("正文图片无效"), {
      status: 422,
      code: "CONTENT_BODY_MEDIA_INVALID"
    }));

    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('[data-content-section="body-media"]').element);
    expect(wrapper.vm.getPreviewDraft().body).toMatchObject({
      title: "保留的标题",
      bodyHtml: "<p>正文</p>"
    });
    wrapper.unmount();
  });

  it("focuses the body media section when preview rejects body media", async () => {
    const wrapper = mount(ContentEditorPanel, {
      attachTo: document.body,
      props: { contentId: "POST-1", events, profiles }
    });
    await flushPromises();
    await wrapper.get('[data-content-field="title"]').setValue("预览时保留的标题");
    apiMock.mockRejectedValueOnce(Object.assign(new Error("正文图片无效"), {
      status: 422,
      code: "CONTENT_BODY_MEDIA_INVALID"
    }));

    await wrapper.get('[data-action="preview-content"]').trigger("click");
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('[data-content-section="body-media"]').element);
    expect(wrapper.vm.getPreviewDraft().body.title).toBe("预览时保留的标题");
    wrapper.unmount();
  });

  it("returns from publication review and focuses body media when review preview rejects an image", async () => {
    const wrapper = mount(ContentEditorPanel, {
      attachTo: document.body,
      props: { contentId: "POST-1", events, profiles }
    });
    await flushPromises();
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    expect(wrapper.get('[data-content-publication-review]').exists()).toBe(true);
    apiMock.mockRejectedValueOnce(Object.assign(new Error("正文图片无效"), {
      status: 422,
      code: "CONTENT_BODY_MEDIA_INVALID"
    }));

    await wrapper.get('[data-action="review-preview"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-content-publication-review]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('[data-content-section="body-media"]').element);
    expect(wrapper.vm.getPreviewDraft().body).toMatchObject({
      title: row.title,
      bodyHtml: "<p>正文</p>"
    });
    wrapper.unmount();
  });

  it("shows rich editor notices as non-blocking status feedback", async () => {
    const wrapper = await mountEditor();

    wrapper.getComponent(RichTextEditor).vm.$emit("notice", "图片已插入到正文末尾");
    await wrapper.vm.$nextTick();

    expect(wrapper.get(".success-message").attributes("role")).toBe("status");
    expect(wrapper.get(".success-message").text()).toBe("图片已插入到正文末尾");
  });

  it("guards content refresh and browser unload while edits are dirty", async () => {
    const wrapper = await mountEditor();
    const initialLoads = apiMock.mock.calls.filter(([path, options]) =>
      path === "/api/admin/content/POST-1" && !options?.method
    ).length;
    await wrapper.get('[data-content-field="title"]').setValue("不能被刷新覆盖");

    await wrapper.get('[data-action="refresh-content"]').trigger("click");
    expect(wrapper.get('[role="dialog"]').text()).toContain("放弃未保存修改");
    expect(apiMock.mock.calls.filter(([path, options]) =>
      path === "/api/admin/content/POST-1" && !options?.method
    )).toHaveLength(initialLoads);

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await wrapper.get('[data-action="confirm-discard-content"]').trigger("click");
    await flushPromises();
    expect(apiMock.mock.calls.filter(([path, options]) =>
      path === "/api/admin/content/POST-1" && !options?.method
    )).toHaveLength(initialLoads + 1);
  });

  it("clears stale saved feedback after later edits and reports dirty, busy, and error states", async () => {
    const pending = deferred();
    installApi({
      "PATCH /api/admin/content/POST-1": async () => pending.promise
    });
    const wrapper = await mountEditor();
    expect(wrapper.get("[data-content-save-state]").text()).toContain("已保存");

    await wrapper.get('[data-content-field="title"]').setValue("第一次修改");
    expect(wrapper.get("[data-content-save-state]").text()).toContain("有未保存修改");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    expect(wrapper.get("[data-content-save-state]").text()).toContain("处理中");

    pending.resolve({ row: { ...row, title: "第一次修改", version: 2 } });
    await flushPromises();
    expect(wrapper.get("[data-content-save-state]").text()).toContain("已保存");
    expect(wrapper.text()).toContain("内容已保存");

    await wrapper.get('[data-content-field="title"]').setValue("第二次修改");
    expect(wrapper.get("[data-content-save-state]").text()).toContain("有未保存修改");
    expect(wrapper.text()).not.toContain("内容已保存");

    installApi({
      "PATCH /api/admin/content/POST-1": async () => { throw new Error("保存服务不可用"); }
    });
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-content-save-state]").text()).toContain("保存失败");
    expect(wrapper.get('[data-content-field="title"]').element.value).toBe("第二次修改");
  });

  it("keeps a future schedule as editor intent while saving only a draft", async () => {
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="status"]').setValue("scheduled");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    expect(wrapper.text()).toContain("请选择未来的发布时间");

    await wrapper.get('[data-content-field="publishAt"]').setValue("2099-01-02T12:30");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    const saves = apiMock.mock.calls.filter(([path, options]) => path === "/api/admin/content/POST-1" && options?.method === "PATCH");
    expect(JSON.parse(saves.at(-1)[1].body)).toMatchObject({ status: "draft", publishAt: null });
    expect(wrapper.get('[data-content-field="status"]').element.value).toBe("scheduled");
    expect(wrapper.get('[data-content-field="publishAt"]').element.value).toBe("2099-01-02T12:30");
    expect(wrapper.vm.isDirty()).toBe(false);
  });

  it.each([
    ["保存并预览", "save-and-preview-content"],
    ["进入发布检查", "save-and-review-content"]
  ])("%s never persists the selected scheduled state before final confirmation", async (_label, action) => {
    installApi({
      "PATCH /api/admin/content/POST-1": async (options) => ({
        row: { ...row, ...JSON.parse(options.body), status: "draft", publishAt: null, version: 2 }
      }),
      "POST /api/admin/site-preview/content": async () => ({
        preview: { payload: { row: { bodyHtml: "<p>安全预览</p>" } } }
      })
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="status"]').setValue("scheduled");
    await wrapper.get('[data-content-field="publishAt"]').setValue("2099-01-02T12:30");

    await wrapper.get(`[data-action="${action}"]`).trigger("click");
    await flushPromises();

    const patch = apiMock.mock.calls.find(([path, options]) =>
      path === "/api/admin/content/POST-1" && options?.method === "PATCH"
    );
    expect(JSON.parse(patch[1].body)).toMatchObject({ status: "draft", publishAt: null });
    if (action === "save-and-review-content") {
      expect(wrapper.get('[data-content-publication-review]').text()).toContain("定时发布");
      await wrapper.get('[data-action="back-to-editor"]').trigger("click");
    }
    expect(wrapper.get('[data-content-field="status"]').element.value).toBe("scheduled");
  });

  it("persists a schedule only after the final review confirmation", async () => {
    installApi({
      "PATCH /api/admin/content/POST-1": async (options) => ({
        row: { ...row, ...JSON.parse(options.body), version: 2 }
      })
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="status"]').setValue("scheduled");
    await wrapper.get('[data-content-field="publishAt"]').setValue("2099-01-02T12:30");
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="confirm-review-publish"]').trigger("click");
    expect(wrapper.get('[role="dialog"]').text()).toContain("确认定时发布");

    await wrapper.get('[data-action="confirm-content-action"]').trigger("click");
    await flushPromises();

    const patches = apiMock.mock.calls.filter(([path, options]) =>
      path === "/api/admin/content/POST-1" && options?.method === "PATCH"
    );
    expect(JSON.parse(patches.at(-1)[1].body)).toMatchObject({
      version: 2,
      status: "scheduled",
      publishAt: new Date("2099-01-02T12:30").toISOString()
    });
    expect(apiMock.mock.calls.some(([path]) => path.endsWith("/publish"))).toBe(false);
    expect(wrapper.text()).toContain("已确认定时发布");
  });

  it("preserves attachment media ids, labels and current visual order", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/content/POST-1" && options.method === "PATCH") return { row: { ...row, ...JSON.parse(options.body), version: 2 } };
      if (path === "/api/admin/content/POST-1") return { row: { ...row, attachments: [
        { mediaId: "M1", label: "规程", displayOrder: 0, media: { id: "M1", originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 100 } },
        { mediaId: "M2", label: "图片", displayOrder: 1, media: { id: "M2", originalName: "b.png", mimeType: "image/png", sizeBytes: 200, width: 100, height: 80 } }
      ] } };
      return {};
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-attachment="M2"] [data-action="move-attachment-up"]').trigger("click");
    await wrapper.get('[data-attachment="M2"] [data-attachment-label]').setValue("获奖图片");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    const save = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/content/POST-1" && options?.method === "PATCH");
    expect(JSON.parse(save[1].body).attachments).toEqual([
      { mediaId: "M2", label: "获奖图片", displayOrder: 0 },
      { mediaId: "M1", label: "规程", displayOrder: 1 }
    ]);
  });

  it("does not manufacture a published state when publish fails", async () => {
    installApi({ "POST /api/admin/content/POST-1/publish": async () => { throw new Error("发布失败"); } });
    const wrapper = await mountEditor();
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await wrapper.get('[data-action="confirm-review-publish"]').trigger("click");
    await wrapper.get('[data-action="confirm-content-action"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("发布失败");
    expect(wrapper.text()).toContain("草稿");
  });

  it("deletes an offline item only after explicit confirmation", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/content/POST-1" && options.method === "DELETE") return {};
      if (path === "/api/admin/content/POST-1") return { row: { ...row, status: "offline" } };
      return {};
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-action="delete-content"]').trigger("click");
    expect(apiMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
    await wrapper.get('[data-action="confirm-content-action"]').trigger("click");
    await flushPromises();
    expect(apiMock.mock.calls.some(([path, options]) => path === "/api/admin/content/POST-1" && options?.method === "DELETE")).toBe(true);
    expect(wrapper.emitted("deleted")).toEqual([["POST-1"]]);
  });

  it("requires offline content to return to draft or scheduled before saving edits", async () => {
    apiMock.mockImplementation(async (path) => path === "/api/admin/content/POST-1"
      ? { row: { ...row, status: "offline" } }
      : {});
    const wrapper = await mountEditor();
    expect(wrapper.get('[data-action="save-content"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("请选择草稿或定时发布后再保存");
    await wrapper.get('[data-content-field="status"]').setValue("draft");
    expect(wrapper.get('[data-action="save-content"]').attributes("disabled")).toBeUndefined();
  });

  it("keeps referenced media selected when physical deletion returns 409", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/content/POST-1") return { row: { ...row, attachments: [
        { mediaId: "M1", label: "规程", displayOrder: 0, media: { id: "M1", originalName: "rules.pdf", mimeType: "application/pdf", sizeBytes: 100 } }
      ] } };
      if (path === "/api/admin/site-media/M1" && options.method === "DELETE") throw Object.assign(new Error("媒体仍在引用"), { status: 409 });
      return {};
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-attachment="M1"] [data-action="detach-attachment-media"]').trigger("click");
    await wrapper.get('[data-pending-media="M1"] [data-action="delete-pending-media"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("媒体仍被内容引用，请先解除引用并保存");
    expect(wrapper.find('[data-pending-media="M1"]').exists()).toBe(true);
  });

  it("closes confirmation with Escape and returns focus to its opener", async () => {
    const wrapper = await mount(ContentEditorPanel, { props: { contentId: "POST-1", events }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    const opener = wrapper.get('[data-action="confirm-review-publish"]');
    opener.element.focus();
    await opener.trigger("click");
    expect(document.activeElement).toBe(wrapper.get('[data-action="confirm-content-action"]').element);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener.element);
    wrapper.unmount();
  });

  it("clears stale content during loading and cannot patch it after the next load fails", async () => {
    const nextLoad = deferred();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/content/POST-1") return { row: { ...row } };
      if (path === "/api/admin/content/POST-2") return nextLoad.promise;
      return {};
    });
    const wrapper = await mountEditor();
    await wrapper.setProps({ contentId: "POST-2" });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("正在加载内容");
    expect(wrapper.find('[data-content-field="title"]').exists()).toBe(false);
    nextLoad.reject(new Error("第二篇加载失败"));
    await flushPromises();
    expect(wrapper.text()).toContain("第二篇加载失败");
    expect(wrapper.find('[data-action="save-content"]').exists()).toBe(false);
  });

  it("discards an out-of-order response when content selection changes quickly", async () => {
    const first = deferred(); const second = deferred();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/admin/content/POST-1") return first.promise;
      if (path === "/api/admin/content/POST-2") return second.promise;
      return {};
    });
    const wrapper = mount(ContentEditorPanel, { props: { contentId: "POST-1", events } });
    await wrapper.setProps({ contentId: "POST-2" });
    second.resolve({ row: { ...row, id: "POST-2", title: "第二篇" } });
    await flushPromises();
    expect(wrapper.get('[data-content-field="title"]').element.value).toBe("第二篇");
    first.resolve({ row: { ...row, id: "POST-1", title: "迟到的第一篇" } });
    await flushPromises();
    expect(wrapper.get('[data-content-field="title"]').element.value).toBe("第二篇");
  });

  it("creates only a draft, then keeps a schedule as intent until review confirmation", async () => {
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/content" && options.method === "POST") return { row: { ...row, ...JSON.parse(options.body), id: "POST-NEW", status: "draft", publishAt: null } };
      if (path === "/api/admin/content/POST-NEW" && options.method === "PATCH") return { row: { ...row, ...JSON.parse(options.body), id: "POST-NEW", version: 2 } };
      return {};
    });
    const wrapper = await mountEditor(null);
    expect(wrapper.get('[data-content-field="status"]').findAll("option").map((option) => option.attributes("value"))).toEqual(["draft"]);
    expect(wrapper.text()).toContain("先保存草稿后才能设置定时发布");
    await wrapper.get('[data-content-field="title"]').setValue("新内容");
    await wrapper.get('[data-content-field="slug"]').setValue("new-content");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    const create = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/content" && options?.method === "POST");
    expect(JSON.parse(create[1].body)).toMatchObject({ status: "draft", publishAt: null });
    expect(wrapper.get('[data-content-field="status"]').findAll("option").map((option) => option.attributes("value"))).toContain("scheduled");
    await wrapper.get('[data-content-field="status"]').setValue("scheduled");
    await wrapper.get('[data-content-field="publishAt"]').setValue("2099-01-02T12:30");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    const update = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/content/POST-NEW" && options?.method === "PATCH");
    expect(JSON.parse(update[1].body)).toMatchObject({ status: "draft", publishAt: null });
    expect(wrapper.get('[data-content-field="status"]').element.value).toBe("scheduled");
    expect(wrapper.get('[data-content-field="publishAt"]').element.value).toBe("2099-01-02T12:30");
  });

  it("exposes an unsaved content draft without applying persistence-only validation", async () => {
    const wrapper = await mountEditor(null);
    await wrapper.get('[data-content-field="title"]').setValue("尚未保存的内容");
    await wrapper.get('[data-content-field="slug"]').setValue("unsaved-content");

    expect(wrapper.vm.getPreviewDraft()).toEqual({
      kind: "content",
      body: expect.objectContaining({
        title: "尚未保存的内容",
        slug: "unsaved-content",
        status: "draft",
        publishAt: null
      }),
      context: { contentId: null }
    });
    expect(wrapper.vm.getSavedPreviewPath()).toBeNull();
    expect(wrapper.vm.getSavedPreviewState()).toEqual({
      path: null,
      reason: "新建内容尚未保存，暂无已保存官网页面。"
    });
  });

  it("uses the persisted public slug for saved preview even when the form slug changes", async () => {
    installApi({
      "GET /api/admin/content/POST-1": async () => ({
        row: { ...row, status: "published", publishAt: "2026-01-01T00:00:00.000Z" }
      })
    });
    const wrapper = await mountEditor();
    const slug = wrapper.get('[data-content-field="slug"]');
    slug.element.disabled = false;
    await slug.setValue("unsaved-route");

    expect(wrapper.vm.getPreviewDraft().body.slug).toBe("unsaved-route");
    expect(wrapper.vm.getSavedPreviewState()).toEqual({
      path: "/content/first-news",
      reason: ""
    });
  });

  it.each([
    ["draft", null, "已保存内容仍是草稿，尚未公开。"],
    ["scheduled", "2099-01-01T00:00:00.000Z", "已保存内容为定时发布，尚未公开。"],
    ["offline", "2026-01-01T00:00:00.000Z", "已保存内容已下线，官网不可访问。"],
    ["published", "2099-01-01T00:00:00.000Z", "已保存内容尚未到发布时间，官网不可访问。"]
  ])("disables saved preview for a non-public %s baseline", async (status, publishAt, reason) => {
    installApi({
      "GET /api/admin/content/POST-1": async () => ({
        row: { ...row, status, publishAt }
      })
    });
    const wrapper = await mountEditor();

    expect(wrapper.vm.getSavedPreviewState()).toEqual({ path: null, reason });
    expect(wrapper.vm.getSavedPreviewPath()).toBeNull();
  });

  it("keeps detached media reachable through save, 409, and retrying a successful DELETE", async () => {
    let deleteAttempts = 0;
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/content/POST-1" && options.method === "PATCH") return { row: { ...row, ...JSON.parse(options.body), attachments: [], version: 2 } };
      if (path === "/api/admin/content/POST-1") return { row: { ...row, coverMediaId: "C1", attachments: [{ mediaId: "M1", label: "规程", displayOrder: 0, media: { id: "M1", originalName: "rules.pdf", mimeType: "application/pdf", sizeBytes: 100 } }] } };
      if (["/api/admin/site-media/M1", "/api/admin/site-media/C1"].includes(path) && options.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw Object.assign(new Error("仍被引用"), { status: 409 });
        return {};
      }
      return {};
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-action="detach-cover-media"]').trigger("click");
    await wrapper.get('[data-attachment="M1"] [data-action="detach-attachment-media"]').trigger("click");
    expect(wrapper.findAll('[data-pending-media]')).toHaveLength(2);
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-pending-media]')).toHaveLength(2);
    await wrapper.get('[data-pending-media="M1"] [data-action="delete-pending-media"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-pending-media="M1"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("媒体仍被内容引用");
    await wrapper.get('[data-pending-media="M1"] [data-action="delete-pending-media"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-pending-media="M1"]').exists()).toBe(false);
  });

  it("locks physical deletion by media id while the request is pending", async () => {
    const deletion = deferred();
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/admin/content/POST-1") return { row: { ...row, attachments: [{ mediaId: "M1", label: "规程", displayOrder: 0, media: { id: "M1", originalName: "rules.pdf" } }] } };
      if (path === "/api/admin/site-media/M1" && options.method === "DELETE") return deletion.promise;
      return {};
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-attachment="M1"] [data-action="detach-attachment-media"]').trigger("click");
    const button = wrapper.get('[data-pending-media="M1"] [data-action="delete-pending-media"]');
    await button.trigger("click");
    await button.trigger("click");
    expect(apiMock.mock.calls.filter(([path, options]) => path === "/api/admin/site-media/M1" && options?.method === "DELETE")).toHaveLength(1);
    expect(button.attributes("disabled")).toBeDefined();
    deletion.resolve({}); await flushPromises();
    expect(wrapper.find('[data-pending-media="M1"]').exists()).toBe(false);
  });

  it("traps focus and restores stable focus after publish, offline, and delete", async () => {
    const wrapper = await mount(ContentEditorPanel, { props: { contentId: "POST-1", events }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await wrapper.get('[data-action="confirm-review-publish"]').trigger("click");
    const buttons = wrapper.get('[role="dialog"]').findAll("button");
    buttons.at(-1).element.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0].element);
    buttons[0].element.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(buttons.at(-1).element);
    await wrapper.get('[data-action="confirm-content-action"]').trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-content-editor-heading]').element);

    await wrapper.get('[data-action="offline-content"]').trigger("click");
    await wrapper.get('[data-action="confirm-content-action"]').trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-content-editor-heading]').element);

    await wrapper.get('[data-action="delete-content"]').trigger("click");
    await wrapper.get('[data-action="confirm-content-action"]').trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-content-editor-heading]').element);
    wrapper.unmount();
  });

  it("traps preview focus and restores it to the preview button", async () => {
    const wrapper = await mount(ContentEditorPanel, { props: { contentId: "POST-1", events }, attachTo: document.body });
    installApi({
      "POST /api/admin/site-preview/content": async () => ({
        preview: { payload: { row: { bodyHtml: "<p>预览</p>" } } }
      })
    });
    await flushPromises();
    const opener = wrapper.get('[data-action="preview-content"]');
    opener.element.focus();
    await opener.trigger("click"); await flushPromises();
    const close = wrapper.get('[aria-label="关闭预览"]');
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(close.element);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(close.element);
    await close.trigger("click"); await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(opener.element);
    wrapper.unmount();
  });

  it("saves sanitized HTML repair changes without requiring a mode switch", async () => {
    const wrapper = await mountEditor();
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    await wrapper.get('[data-rich-editor="html"]').setValue('<h2 onclick="bad()">实时标题</h2><script>bad()</script>');
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    const patch = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/content/POST-1" && options?.method === "PATCH");
    expect(JSON.parse(patch[1].body).bodyHtml).toBe("<h2>实时标题</h2>");
  });

  it.each([
    ["html", '[data-rich-editor="html"]', "<h2>未保存 HTML</h2>"],
    ["text", '[data-rich-editor="text"]', "未保存纯文本"]
  ])("treats %s repair input as dirty before leaving the mode", async (mode, selector, input) => {
    const wrapper = await mountEditor();
    await wrapper.get(`[data-editor-mode="${mode}"]`).trigger("click");
    await wrapper.get(selector).setValue(input);
    const leave = vi.fn();
    wrapper.vm.requestLeave(leave);
    await wrapper.vm.$nextTick();
    expect(leave).not.toHaveBeenCalled();
    expect(wrapper.get('[role="dialog"]').text()).toContain("放弃未保存修改");
  });

  it("refreshes the form from the reachable PATCH response branch", async () => {
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="title"]').setValue("客户端标题");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-content-field="title"]').element.value).toBe("服务器规范标题");
    expect(wrapper.text()).toContain("版本 9");
  });

  it("refreshes an active HTML repair buffer from the server-normalized saved body", async () => {
    installApi({
      "PATCH /api/admin/content/POST-1": async (options) => ({ row: { ...row, ...JSON.parse(options.body), bodyHtml: "<p>服务器规范正文</p>", version: 5 } })
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    await wrapper.get('[data-rich-editor="html"]').setValue("<h2>客户端正文</h2>");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe("<p>服务器规范正文</p>");
    expect(wrapper.text()).toContain("版本 5");
  });

  it("uses the server revision to refresh an equal canonical body after save", async () => {
    installApi({
      "PATCH /api/admin/content/POST-1": async (options) => ({ row: { ...row, ...JSON.parse(options.body), version: 6 } })
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    await wrapper.get('[data-rich-editor="html"]').setValue('<p style="color:red">正文</p>');
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toContain("style=");
    await wrapper.get('[data-action="save-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe("<p>正文</p>");
    expect(wrapper.text()).toContain("版本 6");
  });

  it("previews a new unsaved item through the sanitized preview API without saving", async () => {
    installApi({
      "POST /api/admin/site-preview/content": async () => ({
        preview: { payload: { row: { bodyHtml: "<p>服务端净化的新内容</p>" } } }
      })
    });
    const wrapper = await mountEditor(null);
    await wrapper.get('[data-content-field="title"]').setValue("未保存内容");
    await wrapper.get('[data-content-field="slug"]').setValue("unsaved-content");
    const previewButton = wrapper.get('[data-action="preview-content"]');
    expect(previewButton.attributes("disabled")).toBeUndefined();

    await previewButton.trigger("click");
    await flushPromises();

    const preview = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/site-preview/content" && options?.method === "POST");
    expect(JSON.parse(preview[1].body)).toMatchObject({ title: "未保存内容", slug: "unsaved-content" });
    expect(JSON.parse(preview[1].body)).not.toHaveProperty("id");
    expect(JSON.parse(preview[1].body)).not.toHaveProperty("version");
    expect(apiMock.mock.calls.some(([path, options]) => path === "/api/admin/content" && options?.method === "POST")).toBe(false);
    expect(wrapper.get('[data-preview-body]').html()).toContain("服务端净化的新内容");
    expect(wrapper.get('[data-preview-body]').html()).not.toContain("onerror");
  });

  it("previews a dirty saved item through the preview API without saving", async () => {
    installApi({
      "POST /api/admin/site-preview/content": async () => ({
        preview: { payload: { row: { bodyHtml: "<p>服务端净化的修改</p>" } } }
      })
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="title"]').setValue("尚未保存修改");
    const previewButton = wrapper.get('[data-action="preview-content"]');
    expect(wrapper.vm.isDirty()).toBe(true);
    expect(previewButton.attributes("disabled")).toBeUndefined();

    await previewButton.trigger("click");
    await flushPromises();

    const preview = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/site-preview/content" && options?.method === "POST");
    expect(JSON.parse(preview[1].body)).toMatchObject({ id: "POST-1", version: 1, title: "尚未保存修改" });
    expect(apiMock.mock.calls.some(([path, options]) => path === "/api/admin/content/POST-1" && options?.method === "PATCH")).toBe(false);
    expect(wrapper.get('[data-preview-body]').html()).toContain("服务端净化的修改");
  });

  it.each(["published", "offline"])("previews an existing %s item through the preview API without persistence or lifecycle calls", async (status) => {
    const persisted = {
      ...row,
      title: `${status} 内容`,
      bodyHtml: `<p>${status} 正文</p>`,
      status,
      publishAt: "2026-01-01T00:00:00.000Z",
      pinned: true,
      sortOrder: 4,
      version: 7
    };
    installApi({
      "GET /api/admin/content/POST-1": async () => ({ row: persisted }),
      "POST /api/admin/site-preview/content": async () => ({
        preview: { payload: { row: { bodyHtml: `<p>服务端 ${status} 预览</p>` } } }
      })
    });
    const wrapper = await mountEditor();

    await wrapper.get('[data-action="preview-content"]').trigger("click");
    await flushPromises();

    const preview = apiMock.mock.calls.find(([path, options]) => path === "/api/admin/site-preview/content" && options?.method === "POST");
    expect(JSON.parse(preview[1].body)).toEqual({
      slug: "first-news",
      eventId: "E1",
      type: "news",
      title: `${status} 内容`,
      summary: "摘要",
      bodyHtml: `<p>${status} 正文</p>`,
      status,
      publishAt: "2026-01-01T00:00:00.000Z",
      pinned: true,
      sortOrder: 4,
      coverMediaId: null,
      attachments: [],
      id: "POST-1",
      version: 7
    });
    expect(wrapper.get('[data-preview-body]').html()).toContain(`服务端 ${status} 预览`);
    expect(apiMock.mock.calls
      .filter(([, options]) => options?.method)
      .map(([path, options]) => [options.method, path]))
      .toEqual([["POST", "/api/admin/site-preview/content"]]);
  });
});
