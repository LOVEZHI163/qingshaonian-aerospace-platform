import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import RichTextEditor from "../RichTextEditor.vue";
import { sanitizeEditorHtml } from "../../lib/rich-text.js";

async function mountEditor(options = {}) {
  const wrapper = mount(RichTextEditor, options);
  await wrapper.vm.$nextTick();
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe("RichTextEditor", () => {
  it("formats the selected text without losing the selection to the toolbar", async () => {
    const wrapper = await mountEditor({
      attachTo: document.body,
      props: { modelValue: "<p>正文内容</p>" }
    });
    wrapper.vm.editor.commands.setTextSelection({ from: 1, to: 3 });
    await wrapper.get('[data-command="bold"]').trigger("mousedown");
    await wrapper.get('[data-command="bold"]').trigger("click");
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toContain("<strong>正文</strong>");
    wrapper.unmount();
  });

  it("supports paragraph h2 h3 lists quote links undo redo and clear formatting", async () => {
    const wrapper = await mountEditor({
      attachTo: document.body,
      props: { modelValue: "<p>正文</p>" }
    });
    const commands = ["heading-2", "heading-3", "paragraph", "bullet-list", "ordered-list", "blockquote"];
    const expectedHtml = {
      "heading-2": "<h2>正文</h2>",
      "heading-3": "<h3>正文</h3>",
      paragraph: "<p>正文</p>",
      "bullet-list": "<ul><li><p>正文</p></li></ul>",
      "ordered-list": "<ol><li><p>正文</p></li></ol>",
      blockquote: "<blockquote><p>正文</p></blockquote>"
    };
    for (const command of commands) {
      wrapper.vm.editor.commands.setContent("<p>正文</p>", { emitUpdate: false });
      wrapper.vm.editor.commands.setTextSelection({ from: 1, to: 3 });
      const button = wrapper.get(`[data-command="${command}"]`);
      expect(button.attributes("disabled"), `${command} should be enabled`).toBeUndefined();
      await button.trigger("click");
      expect(wrapper.vm.editor.getHTML(), `${command} HTML`).toContain(expectedHtml[command]);
      const editorActive = command === "heading-2"
        ? wrapper.vm.editor.isActive("heading", { level: 2 })
        : command === "heading-3"
          ? wrapper.vm.editor.isActive("heading", { level: 3 })
          : wrapper.vm.editor.isActive({
            paragraph: "paragraph",
            "bullet-list": "bulletList",
            "ordered-list": "orderedList",
            blockquote: "blockquote"
          }[command]);
      expect(editorActive, `${command} editor state`).toBe(true);
      expect(button.attributes("aria-pressed"), `${command} toolbar state`).toBe("true");
    }

    wrapper.vm.editor.commands.setContent("<p>正文</p>", { emitUpdate: false });
    wrapper.vm.editor.commands.setTextSelection({ from: 1, to: 3 });
    await wrapper.get('[data-command="bold"]').trigger("click");
    await wrapper.get('[data-command="italic"]').trigger("click");
    expect(wrapper.get('[data-command="bold"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-command="italic"]').attributes("aria-pressed")).toBe("true");

    const prompt = vi.spyOn(window, "prompt").mockReturnValue("https://example.com/article");
    await wrapper.get('[data-command="link"]').trigger("click");
    expect(wrapper.vm.editor.getHTML()).toContain('href="https://example.com/article"');
    prompt.mockRestore();

    await wrapper.get('[data-command="undo"]').trigger("click");
    expect(wrapper.get('[data-command="redo"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-command="clear-formatting"]').trigger("click");
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toContain("<p>");
    wrapper.unmount();
  });

  it("keeps the document and selection during same-revision parent writeback", async () => {
    const wrapper = await mountEditor({
      props: { modelValue: "<p>初始正文</p>", revision: 3 }
    });
    const editor = wrapper.vm.editor;
    editor.commands.setTextSelection(3);
    editor.commands.insertContent("新增");
    const emittedHtml = wrapper.emitted("update:modelValue").at(-1)[0];
    const selectionFrom = editor.state.selection.from;
    await wrapper.setProps({ modelValue: emittedHtml, revision: 3 });
    expect(wrapper.vm.editor).toBe(editor);
    expect(wrapper.vm.editor.state.selection.from).toBe(selectionFrom);
    expect(wrapper.vm.editor.getHTML()).toBe(emittedHtml);
  });

  it("reserves an internal image dialog toolbar hook without prompting for a URL", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "<p>正文</p>" } });
    const prompt = vi.spyOn(window, "prompt");
    const button = wrapper.get('[data-command="image"]');
    expect(button.attributes("type")).toBe("button");
    await button.trigger("click");
    expect(prompt).not.toHaveBeenCalled();
    expect(wrapper.emitted("open-image-dialog")).toBeUndefined();
    prompt.mockRestore();
  });

  it("cleans dangerous pasted markup while retaining semantic content", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "" } });
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
    const wrapper = await mountEditor({ props: { modelValue: "<p>第一行</p><p>第二行</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toContain("<p>第一行</p>");
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toContain("第一行");
  });

  it("preserves managed image markup in the client sanitizer while rejecting unsafe image sources", () => {
    const html = sanitizeEditorHtml('<div><p>正文</p><figure><img src="/api/public/media/M1" alt="现场" onerror="bad()"><figcaption>图注</figcaption></figure><img src="/api/public/media/../secret"><img src="data:image/png;base64,bad"><svg><image href="/api/public/media/M2"></image></svg><script>bad()</script></div>');
    expect(html).toContain('<figure><img src="/api/public/media/M1" alt="现场"><figcaption>图注</figcaption></figure>');
    expect(html).toContain("正文");
    expect(html).not.toMatch(/script|onerror|data:image|secret|svg|<div/i);
  });

  it("sanitizes HTML repair input before switching back to visual mode", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "<p>原文</p>" } });
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
    const wrapper = await mountEditor({ props: { modelValue: '<a href="javascript:bad()" data-editor-href="javascript:bad()">伪造链接</a>' } });
    const html = wrapper.vm.editor.getHTML();
    expect(html).toContain("伪造链接");
    expect(html).not.toMatch(/href|data-editor/i);
  });

  it("synchronizes sanitized HTML repair input immediately without replacing the raw textarea", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "<p>原文</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    const raw = '<h2 style="color:red">新标题</h2><script>bad()</script><a href="javascript:bad()">链接</a>';
    await wrapper.get('[data-rich-editor="html"]').setValue(raw);
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe(raw);
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toBe("<h2>新标题</h2><a>链接</a>");
  });

  it("synchronizes escaped semantic HTML from plain-text repair input immediately", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "<p>原文</p>" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    await wrapper.get('[data-rich-editor="text"]').setValue("第一行 <危险>\n第二行");
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toBe("第一行 <危险>\n第二行");
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toBe("<p>第一行 &lt;危险&gt;</p><p>第二行</p>");
  });

  it("replaces the HTML repair buffer when an external record arrives", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "<p>P1 正文</p>" } });
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
    const wrapper = await mountEditor({ props: { modelValue: "<p>P1 正文</p>" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    await wrapper.get('[data-rich-editor="text"]').setValue("P1 未保存");
    await wrapper.setProps({ modelValue: "<p>P2 第一行</p><p>P2 第二行</p>" });
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toBe("P2 第一行\nP2 第二行");
    await wrapper.get('[data-editor-mode="visual"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="visual"]').element.innerHTML).toBe("<p>P2 第一行</p><p>P2 第二行</p>");
  });

  it("preserves raw repair text during self-emitted parent writeback", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "<p>原文</p>" } });
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
    const wrapper = await mountEditor({ props: { modelValue: "<p>原文</p>" } });
    await wrapper.get('[data-editor-mode="html"]').trigger("click");
    await wrapper.get('[data-rich-editor="html"]').setValue("<h2>客户端</h2>");
    await wrapper.setProps({ modelValue: "<p>服务器规范正文</p>" });
    expect(wrapper.get('[data-rich-editor="html"]').element.value).toBe("<p>服务器规范正文</p>");
  });

  it("preserves block and line-break semantics when entering plain-text mode", async () => {
    const original = "<h2>标题</h2><p>第一段<br>换行</p><ul><li>项目一</li><li>项目二</li></ul><blockquote>引用</blockquote><figcaption>图注</figcaption>";
    const wrapper = await mountEditor({ props: { modelValue: original, revision: "P1:1" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toBe("标题\n第一段\n换行\n项目一\n项目二\n引用\n图注");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("does not rewrite canonical HTML when plain-text mode is entered and exited without edits", async () => {
    const original = "<h2>标题</h2><p>第一段</p><p><strong>第二段</strong></p>";
    const wrapper = await mountEditor({ props: { modelValue: original, revision: "P1:1" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    await wrapper.get('[data-editor-mode="visual"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.get('[data-rich-editor="visual"]').element.innerHTML).toBe(original);
  });

  it("normalizes repeated blank lines while preserving real multiline edits", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "<p>原文</p>", revision: "P1:1" } });
    await wrapper.get('[data-editor-mode="text"]').trigger("click");
    await wrapper.get('[data-rich-editor="text"]').setValue("第一行\n\n\n\n第二行");
    expect(wrapper.emitted("update:modelValue").at(-1)[0]).toBe("<p>第一行</p><p></p><p>第二行</p>");
    expect(wrapper.get('[data-rich-editor="text"]').element.value).toBe("第一行\n\n\n\n第二行");
  });

  it("keeps focus and selection during parent writeback of visual input", async () => {
    const wrapper = await mountEditor({
      attachTo: document.body,
      props: { modelValue: "<p>正文</p>", revision: "P1:1" }
    });
    const editor = wrapper.vm.editor;
    editor.view.dom.focus();
    editor.commands.setTextSelection(2);
    editor.commands.insertContent("续");
    const emitted = wrapper.emitted("update:modelValue").at(-1)[0];
    const selectionFrom = editor.state.selection.from;
    await wrapper.setProps({ modelValue: emitted, revision: "P1:1" });
    expect(editor.view.hasFocus()).toBe(true);
    expect(editor.state.selection.from).toBe(selectionFrom);
    expect(editor.getHTML()).toBe(emitted);
    wrapper.unmount();
  });

  it("resets a focused editor when a new revision arrives", async () => {
    const wrapper = await mountEditor({
      attachTo: document.body,
      props: { modelValue: "<p>原文</p>", revision: "P1:1" }
    });
    const editor = wrapper.vm.editor;
    editor.view.dom.focus();
    editor.commands.setContent("<p>中文输入</p>");
    await wrapper.setProps({ modelValue: "<p>第二篇</p>", revision: "P2:1" });
    expect(editor.getHTML()).toBe("<p>第二篇</p>");
    wrapper.unmount();
  });

  it("defers a focused external same-revision value until blur without losing selection", async () => {
    const wrapper = await mountEditor({
      attachTo: document.body,
      props: { modelValue: "<p>本地正文</p>", revision: "P1:1" }
    });
    const editor = wrapper.vm.editor;
    editor.view.dom.focus();
    editor.commands.setTextSelection(2);
    const selectionFrom = editor.state.selection.from;

    await wrapper.setProps({ modelValue: '<p onclick="bad()">外部值<script>bad()</script></p>', revision: "P1:1" });
    expect(editor.getHTML()).toBe("<p>本地正文</p>");
    expect(editor.state.selection.from).toBe(selectionFrom);

    editor.view.dom.blur();
    await wrapper.vm.$nextTick();
    expect(editor.getHTML()).toBe("<p>外部值</p>");
    wrapper.unmount();
  });

  it("rebuilds visual DOM when a new revision has identical HTML", async () => {
    const wrapper = await mountEditor({
      attachTo: document.body,
      props: { modelValue: "<p>相同正文</p>", revision: "P1:1" }
    });
    const editor = wrapper.vm.editor;
    editor.commands.setTextSelection(2);
    let revisionTransactions = 0;
    const countRevisionTransaction = () => { revisionTransactions += 1; };
    editor.on("transaction", countRevisionTransaction);

    await wrapper.setProps({ modelValue: "<p>相同正文</p>", revision: "P2:1" });
    expect(editor.getHTML()).toBe("<p>相同正文</p>");
    expect(revisionTransactions).toBeGreaterThan(0);
    editor.off("transaction", countRevisionTransaction);
    wrapper.unmount();
  });

  it("refreshes a raw HTML buffer when revision changes even if canonical HTML is equal", async () => {
    const wrapper = await mountEditor({ props: { modelValue: "<h2>标题</h2>", revision: "P1:1" } });
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
