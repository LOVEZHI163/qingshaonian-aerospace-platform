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
});
