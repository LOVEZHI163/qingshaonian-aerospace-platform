import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import RichTextEditor from "../RichTextEditor.vue";

describe("RichTextEditor", () => {
  it("exposes an accessible fixed toolbar and synchronizes visual edits", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>原文</p>" } });

    for (const label of ["标题", "粗体", "斜体", "无序列表", "链接", "引用", "图片"]) {
      expect(wrapper.get(`[aria-label="${label}"]`).attributes("type")).toBe("button");
    }
    const editor = wrapper.get('[data-rich-editor="visual"]');
    editor.element.innerHTML = "<p>修改后</p>";
    await editor.trigger("input");
    expect(wrapper.emitted("update:modelValue").at(-1)).toEqual(["<p>修改后</p>"]);
  });

  it("cleans dangerous pasted markup while retaining semantic content", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "" } });
    const editor = wrapper.get('[data-rich-editor="visual"]');
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type) => type === "text/html"
        ? '<p style="color:red" onclick="alert(1)"><strong>安全文字</strong><script>alert(1)</script></p>'
        : "安全文字" }
    });
    editor.element.dispatchEvent(paste);
    await wrapper.vm.$nextTick();

    const html = wrapper.emitted("update:modelValue").at(-1)[0];
    expect(html).toContain("<strong>安全文字</strong>");
    expect(html).not.toMatch(/style=|onclick=|script/i);
  });

  it("supports HTML and plain-text repair modes", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>第一行</p><p>第二行</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toContain("<p>第一行</p>");
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toContain("第一行");
  });

  it("never inserts unsafe saved draft HTML into the visual DOM", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: '<div><p style="color:red" onclick="bad()">正文<a href="javascript:bad()">链接</a><img src="/api/public/media/M1" onerror="bad()"></p><script>bad()</script><style>body{display:none}</style></div>' } });
    await wrapper.vm.$nextTick();
    const html = wrapper.get('[data-rich-editor="visual"]').element.innerHTML;
    expect(html).toContain("正文");
    expect(html).toContain("/api/public/media/M1");
    expect(html).not.toMatch(/script|style=|onclick|onerror|javascript:|<div/i);
  });

  it("sanitizes HTML repair input before switching back to visual mode", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>原文</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    await wrapper.get('[data-rich-editor="html"]').setValue('<h2 style="color:red">标题</h2><img src="javascript:bad" onerror="bad()"><script>bad()</script><a href="javascript:bad()">坏链接</a>');
    await wrapper.get('[data-editor-mode="visual"]').trigger("click");
    const html = wrapper.get('[data-rich-editor="visual"]').element.innerHTML;
    expect(html).toContain("<h2>标题</h2>");
    expect(html).toContain("坏链接");
    expect(html).not.toMatch(/script|style=|onerror|javascript:/i);
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toBe(wrapper.get('[data-rich-editor="visual"]').element.innerHTML);
  });

  it("does not trust internal sanitizer marker attributes supplied by content", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: '<a href="javascript:bad()" data-editor-href="javascript:bad()">伪造链接</a>' } });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-rich-editor="visual"]').element.innerHTML).toBe("<a>伪造链接</a>");
  });

  it("synchronizes sanitized HTML repair input immediately without replacing the raw textarea", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>原文</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    const raw = '<h2 style="color:red">新标题</h2><script>bad()</script><a href="javascript:bad()">链接</a>';
    await wrapper.get('[data-rich-editor="html"]').setValue(raw);
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe(raw);
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toBe("<h2>新标题</h2><a>链接</a>");
  });

  it("synchronizes escaped semantic HTML from plain-text repair input immediately", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>原文</p>" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    await wrapper.get('[data-rich-editor="text"]').setValue("第一行 <危险>\n第二行");
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toBe("第一行 <危险>\n第二行");
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toBe("<p>第一行 &lt;危险&gt;</p><p>第二行</p>");
  });
});
