<script setup>
import { isActive as isStateActive } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import { computed, nextTick, onMounted, ref, watch } from "vue";

import { sanitizeEditorHtml } from "../lib/rich-text.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  revision: { type: [String, Number], default: "" }
});
const emit = defineEmits(["update:modelValue", "normalized", "notice"]);

const mode = ref("visual");
const value = ref(sanitizeEditorHtml(props.modelValue));
const repairValue = ref("");
const textRepair = ref("");
const pendingWriteback = ref(null);
const pendingExternal = ref(null);
const toolbarState = ref({
  paragraph: false,
  "heading-2": false,
  "heading-3": false,
  bold: false,
  italic: false,
  "bullet-list": false,
  "ordered-list": false,
  blockquote: false,
  link: false,
  canUndo: false,
  canRedo: false
});

function htmlPlainText(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  const blockTags = new Set(["P", "H2", "H3", "H4", "LI", "BLOCKQUOTE", "FIGCAPTION"]);
  function textOf(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(textOf).join("");
    return blockTags.has(node.tagName) && !text.endsWith("\n") ? `${text}\n` : text;
  }
  return [...container.childNodes].map(textOf).join("")
    .replaceAll("\u00a0", " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

function syncToolbar(current) {
  if (!current) return;
  const state = current.view.state;
  toolbarState.value = {
    paragraph: isStateActive(state, "paragraph"),
    "heading-2": isStateActive(state, "heading", { level: 2 }),
    "heading-3": isStateActive(state, "heading", { level: 3 }),
    bold: isStateActive(state, "bold"),
    italic: isStateActive(state, "italic"),
    "bullet-list": isStateActive(state, "bulletList"),
    "ordered-list": isStateActive(state, "orderedList"),
    blockquote: isStateActive(state, "blockquote"),
    link: isStateActive(state, "link"),
    canUndo: current.can().undo(),
    canRedo: current.can().redo()
  };
}

function replaceEditorContent(html, emitUpdate = false) {
  if (!editor.value) return;
  editor.value.commands.setContent(html, { emitUpdate });
}

function applyExternalValue(safe) {
  value.value = safe;
  replaceEditorContent(safe, false);
}

const editor = useEditor({
  content: value.value,
  editable: !props.disabled,
  extensions: [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      code: false,
      codeBlock: false,
      horizontalRule: false,
      link: false,
      trailingNode: false
    }),
    Link.configure({
      openOnClick: false,
      autolink: false,
      protocols: ["http", "https", "mailto"],
      HTMLAttributes: { target: null, rel: null }
    })
  ],
  editorProps: {
    attributes: {
      class: "rich-editor-surface",
      "data-rich-editor": "visual",
      role: "textbox",
      "aria-label": "正文编辑区",
      "aria-multiline": "true"
    }
  },
  onUpdate({ editor: current }) {
    const raw = current.getHTML();
    const safe = sanitizeEditorHtml(raw);
    if (raw !== safe) current.commands.setContent(safe, { emitUpdate: false });
    value.value = safe;
    pendingWriteback.value = { html: safe, revision: props.revision };
    pendingExternal.value = null;
    emit("update:modelValue", safe);
    syncToolbar(current);
  },
  onCreate({ editor: current }) {
    syncToolbar(current);
  },
  onSelectionUpdate({ editor: current }) {
    syncToolbar(current);
  },
  onTransaction({ editor: current }) {
    syncToolbar(current);
  },
  onFocus({ editor: current }) {
    syncToolbar(current);
  },
  onBlur() {
    if (pendingExternal.value === null) return;
    const safe = pendingExternal.value;
    pendingExternal.value = null;
    applyExternalValue(safe);
  }
});

defineExpose({ editor });

watch([() => props.modelValue, () => props.revision], ([next, revision], [, previousRevision]) => {
  const safe = sanitizeEditorHtml(next);
  const revisionChanged = revision !== previousRevision;
  const marker = pendingWriteback.value;
  const isSelfWriteback = !revisionChanged
    && marker?.revision === revision
    && marker.html === safe;
  pendingWriteback.value = null;

  if (isSelfWriteback) {
    pendingExternal.value = null;
    value.value = safe;
    return;
  }
  if (!revisionChanged && safe === value.value) {
    pendingExternal.value = null;
    return;
  }

  if (revisionChanged) pendingExternal.value = null;
  if (!revisionChanged && mode.value === "visual" && editor.value?.isFocused) {
    pendingExternal.value = safe;
    if (safe !== next) emit("normalized", safe);
    return;
  }

  value.value = safe;
  if (mode.value === "html") repairValue.value = safe;
  if (mode.value === "text") textRepair.value = htmlPlainText(safe);
  replaceEditorContent(safe, false);
  if (safe !== next) emit("normalized", safe);
});

watch(() => props.disabled, (disabled) => {
  editor.value?.setEditable(!disabled);
}, { immediate: true });

onMounted(() => {
  if (value.value !== props.modelValue) emit("normalized", value.value);
});

const plainText = computed(() => htmlPlainText(value.value));

function plainTextHtml(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => `<p>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`)
    .join("");
}

function updateHtmlRepair(event) {
  repairValue.value = event.target.value;
  const safe = sanitizeEditorHtml(repairValue.value);
  value.value = safe;
  pendingWriteback.value = { html: safe, revision: props.revision };
  emit("update:modelValue", safe);
}

function updateTextRepair(event) {
  textRepair.value = event.target.value;
  const safe = plainTextHtml(textRepair.value);
  value.value = safe;
  pendingWriteback.value = { html: safe, revision: props.revision };
  emit("update:modelValue", safe);
}

async function setMode(next) {
  mode.value = next;
  if (next === "html") repairValue.value = value.value;
  if (next === "text") textRepair.value = plainText.value;
  await nextTick();
  if (next !== "visual") return;
  const safe = sanitizeEditorHtml(value.value);
  value.value = safe;
  if (sanitizeEditorHtml(editor.value?.getHTML() || "") !== safe) replaceEditorContent(safe, true);
}

function run(command) {
  if (props.disabled || !editor.value) return;
  const chain = editor.value.chain().focus(null, { scrollIntoView: false });
  if (command === "paragraph") chain.setParagraph().run();
  if (command === "heading-2") chain.toggleHeading({ level: 2 }).run();
  if (command === "heading-3") chain.toggleHeading({ level: 3 }).run();
  if (command === "bold") chain.toggleBold().run();
  if (command === "italic") chain.toggleItalic().run();
  if (command === "bullet-list") chain.toggleBulletList().run();
  if (command === "ordered-list") chain.toggleOrderedList().run();
  if (command === "blockquote") chain.toggleBlockquote().run();
  if (command === "undo") chain.undo().run();
  if (command === "redo") chain.redo().run();
  if (command === "clear-formatting") chain.unsetAllMarks().clearNodes().run();
}

function promptLink() {
  if (props.disabled || !editor.value) return;
  const previous = editor.value.getAttributes("link").href || "";
  const answer = window.prompt?.("请输入链接地址", previous);
  if (answer === null || answer === undefined) return;
  const href = answer.trim();
  if (!href) {
    editor.value.chain().focus(null, { scrollIntoView: false }).extendMarkRange("link").unsetLink().run();
    return;
  }
  if (!/^(https?:|mailto:)/i.test(href)) {
    emit("notice", "链接地址仅支持 http、https 或 mailto");
    return;
  }
  editor.value.chain().focus(null, { scrollIntoView: false }).extendMarkRange("link").setLink({ href }).run();
}

function openImageDialog() {
  if (props.disabled) return;
}

function isActive(command) {
  return Boolean(toolbarState.value[command]);
}

function isDisabled(command) {
  if (props.disabled || !editor.value) return true;
  if (command === "undo") return !toolbarState.value.canUndo;
  if (command === "redo") return !toolbarState.value.canRedo;
  return false;
}
</script>

<template>
  <section class="rich-text-editor" :class="{ disabled }">
    <div class="rich-editor-modes" role="tablist" aria-label="正文编辑模式">
      <button v-for="item in [['visual','可视化'],['html','HTML'],['text','纯文本']]" :key="item[0]" type="button" role="tab" :data-editor-mode="item[0]" :aria-selected="mode === item[0]" :disabled="disabled" @click="setMode(item[0])">{{ item[1] }}</button>
    </div>
    <div v-if="mode === 'visual'" class="rich-editor-toolbar" role="toolbar" aria-label="正文格式工具栏" @mousedown.prevent>
      <button type="button" data-command="paragraph" aria-label="段落" :aria-pressed="isActive('paragraph')" :disabled="isDisabled('paragraph')" @click="run('paragraph')">正文</button>
      <button type="button" data-command="heading-2" aria-label="二级标题" :aria-pressed="isActive('heading-2')" :disabled="isDisabled('heading-2')" @click="run('heading-2')">H2</button>
      <button type="button" data-command="heading-3" aria-label="三级标题" :aria-pressed="isActive('heading-3')" :disabled="isDisabled('heading-3')" @click="run('heading-3')">H3</button>
      <button type="button" data-command="bold" aria-label="粗体" :aria-pressed="isActive('bold')" :disabled="isDisabled('bold')" @click="run('bold')"><strong>B</strong></button>
      <button type="button" data-command="italic" aria-label="斜体" :aria-pressed="isActive('italic')" :disabled="isDisabled('italic')" @click="run('italic')"><em>I</em></button>
      <button type="button" data-command="bullet-list" aria-label="无序列表" :aria-pressed="isActive('bullet-list')" :disabled="isDisabled('bullet-list')" @click="run('bullet-list')">无序列表</button>
      <button type="button" data-command="ordered-list" aria-label="有序列表" :aria-pressed="isActive('ordered-list')" :disabled="isDisabled('ordered-list')" @click="run('ordered-list')">有序列表</button>
      <button type="button" data-command="blockquote" aria-label="引用" :aria-pressed="isActive('blockquote')" :disabled="isDisabled('blockquote')" @click="run('blockquote')">引用</button>
      <button type="button" data-command="link" aria-label="链接" :aria-pressed="isActive('link')" :disabled="isDisabled('link')" @click="promptLink">链接</button>
      <button type="button" data-command="undo" aria-label="撤销" :disabled="isDisabled('undo')" @click="run('undo')">撤销</button>
      <button type="button" data-command="redo" aria-label="重做" :disabled="isDisabled('redo')" @click="run('redo')">重做</button>
      <button type="button" data-command="clear-formatting" aria-label="清除格式" :disabled="isDisabled('clear-formatting')" @click="run('clear-formatting')">清除格式</button>
      <button type="button" data-command="image" aria-label="图片" :disabled="isDisabled('image')" @click="openImageDialog">图片</button>
    </div>
    <EditorContent v-show="mode === 'visual'" :editor="editor" />
    <textarea v-if="mode === 'html'" :value="repairValue" data-rich-editor="html" :disabled="disabled" @input="updateHtmlRepair"></textarea>
    <textarea v-if="mode === 'text'" :value="textRepair" data-rich-editor="text" :disabled="disabled" @input="updateTextRepair"></textarea>
  </section>
</template>
