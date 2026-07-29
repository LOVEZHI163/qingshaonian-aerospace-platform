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
    expect(editor.attributes("role")).toBe("textbox");
    expect(editor.attributes("aria-label")).toBe("正文编辑区");
    expect(editor.attributes("aria-multiline")).toBe("true");
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

  it("replaces the HTML repair buffer when an external record arrives", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>P1 正文</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    await wrapper.get('[data-rich-editor="html"]').setValue("<h2>P1 未保存</h2>");
    const emissionCount = wrapper.emitted("update:modelValue").length;
    await wrapper.setProps({ modelValue: "<p>P2 正文</p>" });
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe("<p>P2 正文</p>");
    await wrapper.get('[data-editor-mode="visual"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="visual"]').element.innerHTML).toBe("<p>P2 正文</p>");
    expect(wrapper.emitted("update:modelValue").slice(emissionCount).some(([html]) => html.includes("P1 未保存"))).toBe(false);
  });

  it("replaces the plain-text repair buffer when an external record arrives", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>P1 正文</p>" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    await wrapper.get('[data-rich-editor="text"]').setValue("P1 未保存");
    await wrapper.setProps({ modelValue: "<p>P2 第一行</p><p>P2 第二行</p>" });
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toBe("P2 第一行\nP2 第二行");
    await wrapper.get('[data-editor-mode="visual"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="visual"]').element.innerHTML).toBe("<p>P2 第一行</p><p>P2 第二行</p>");
  });

  it("preserves raw repair text during self-emitted parent writeback", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>原文</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    const textarea = wrapper.get('[data-rich-editor="html"]');
    const raw = '<h2 style="color:red">连续输入</h2>';
    await textarea.setValue(raw);
    const safe = wrapper.emitted("update:modelValue").at(-1)[0];
    await wrapper.setProps({ modelValue: safe });
    expect(textarea.element.value).toBe(raw);

    const continued = `${raw}<p onclick="bad()">第二段</p>`;
    await textarea.setValue(continued);
    await wrapper.setProps({ modelValue: wrapper.emitted("update:modelValue").at(-1)[0] });
    expect(textarea.element.value).toBe(continued);
  });

  it("refreshes the active repair buffer from a server-normalized value", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>原文</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    await wrapper.get('[data-rich-editor="html"]').setValue("<h2>客户端</h2>");
    await wrapper.setProps({ modelValue: "<p>服务器规范正文</p>" });
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe("<p>服务器规范正文</p>");
  });

  it("preserves block and line-break semantics when entering plain-text mode", async () => {
    const original = "<h2>标题</h2><p>第一段<br>换行</p><ul><li>项目一</li><li>项目二</li></ul><blockquote>引用</blockquote><figcaption>图注</figcaption>";
    const wrapper = mount(RichTextEditor, { props: { modelValue: original, revision: "P1:1" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toBe("标题\n第一段\n换行\n项目一\n项目二\n引用\n图注");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("does not rewrite canonical HTML when plain-text mode is entered and exited without edits", async () => {
    const original = "<h2>标题</h2><p>第一段</p><p><strong>第二段</strong></p>";
    const wrapper = mount(RichTextEditor, { props: { modelValue: original, revision: "P1:1" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    await wrapper.get('[data-editor-mode="visual"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.get('[data-rich-editor="visual"]').element.innerHTML).toBe(original);
  });

  it("normalizes repeated blank lines while preserving real multiline edits", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>原文</p>", revision: "P1:1" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    await wrapper.get('[data-rich-editor="text"]').setValue("第一行\n\n\n\n第二行");
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toBe("<p>第一行</p><p></p><p>第二行</p>");
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toBe("第一行\n\n\n\n第二行");
  });

  it("keeps focus and selection during parent writeback of visual input", async () => {
    const wrapper = mount(RichTextEditor, {
      attachTo: document.body,
      props: { modelValue: "<p>正文</p>", revision: "P1:1" }
    });
    const editor = wrapper.get('[data-rich-editor="visual"]');
    editor.element.focus();
    const text = editor.element.querySelector("p").firstChild;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    editor.element.querySelector("p").append("续");
    await editor.trigger("input");
    const emitted = wrapper.emitted("update:modelValue").at(-1)[0];
    await wrapper.setProps({ modelValue: emitted, revision: "P1:1" });
    expect(document.activeElement).toBe(editor.element);
    expect(window.getSelection().anchorNode).toBe(text);
    expect(window.getSelection().anchorOffset).toBe(1);
    wrapper.unmount();
  });

  it("does not replace visual DOM during composition but resets it for a new revision", async () => {
    const wrapper = mount(RichTextEditor, {
      attachTo: document.body,
      props: { modelValue: "<p>原文</p>", revision: "P1:1" }
    });
    const editor = wrapper.get('[data-rich-editor="visual"]');
    editor.element.focus();
    await editor.trigger("compositionstart");
    editor.element.innerHTML = "<p>中文输入</p>";
    await editor.trigger("input");
    await wrapper.setProps({ modelValue: "<p>中文输入</p>", revision: "P1:1" });
    expect(editor.element.innerHTML).toBe("<p>中文输入</p>");
    await editor.trigger("compositionend");
    await wrapper.setProps({ modelValue: "<p>第二篇</p>", revision: "P2:1" });
    expect(editor.element.innerHTML).toBe("<p>第二篇</p>");
    wrapper.unmount();
  });

  it("defers a focused external same-revision value until blur without losing selection", async () => {
    const wrapper = mount(RichTextEditor, {
      attachTo: document.body,
      props: { modelValue: "<p>本地正文</p>", revision: "P1:1" }
    });
    const editor = wrapper.get('[data-rich-editor="visual"]');
    editor.element.focus();
    const text = editor.element.querySelector("p").firstChild;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    await wrapper.setProps({ modelValue: '<p onclick="bad()">外部值<script>bad()</script></p>', revision: "P1:1" });
    expect(editor.element.innerHTML).toBe("<p>本地正文</p>");
    expect(window.getSelection().anchorNode).toBe(text);
    expect(window.getSelection().anchorOffset).toBe(1);

    await editor.trigger("blur");
    expect(editor.element.innerHTML).toBe("<p>外部值</p>");
    wrapper.unmount();
  });

  it("rebuilds visual DOM when a new revision has identical HTML", async () => {
    const wrapper = mount(RichTextEditor, {
      attachTo: document.body,
      props: { modelValue: "<p>相同正文</p>", revision: "P1:1" }
    });
    const editor = wrapper.get('[data-rich-editor="visual"]');
    const text = editor.element.querySelector("p").firstChild;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    await wrapper.setProps({ modelValue: "<p>相同正文</p>", revision: "P2:1" });
    expect(editor.element.querySelector("p").firstChild).not.toBe(text);
    expect(window.getSelection().anchorNode).not.toBe(text);
    wrapper.unmount();
  });

  it("refreshes a raw HTML buffer when revision changes even if canonical HTML is equal", async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: "<h2>标题</h2>", revision: "P1:1" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    const raw = '<h2 style="color:red">标题</h2>';
    await wrapper.get('[data-rich-editor="html"]').setValue(raw);
    const safe = wrapper.emitted("update:modelValue").at(-1)[0];
    await wrapper.setProps({ modelValue: safe, revision: "P1:1" });
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe(raw);
    await wrapper.setProps({ modelValue: safe, revision: "P1:2" });
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe("<h2>标题</h2>");
  });
});
