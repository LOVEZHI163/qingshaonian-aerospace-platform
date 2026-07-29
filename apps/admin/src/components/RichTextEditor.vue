<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { sanitizeEditorHtml } from "../lib/rich-text.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  revision: { type: [String, Number], default: "" }
});
const emit = defineEmits(["update:modelValue", "normalized"]);
const mode = ref("visual");
const visual = ref(null);
const visualFocused = ref(false);
const composing = ref(false);
const lastEmittedVisual = ref(null);
const repairValue = ref("");
const textRepair = ref("");

const value = ref(sanitizeEditorHtml(props.modelValue));

function syncVisualDom(html, { force = false } = {}) {
  if (!visual.value || mode.value !== "visual") return;
  if (!force && (visualFocused.value || composing.value)) return;
  if (force || visual.value.innerHTML !== html) visual.value.innerHTML = html;
}

function htmlPlainText(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  const blockTags = new Set(["P", "H2", "H3", "H4", "LI", "BLOCKQUOTE", "FIGCAPTION"]);
  function textOf(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(textOf).join("");
    return blockTags.has(node.tagName) ? `${text}\n` : text;
  }
  return [...container.childNodes].map(textOf).join("")
    .replaceAll("\u00a0", " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

watch([() => props.modelValue, () => props.revision], ([next, revision], [, previousRevision]) => {
  const safe = sanitizeEditorHtml(next);
  const revisionChanged = revision !== previousRevision;
  if (safe === value.value && !revisionChanged) return;
  value.value = safe;
  if (mode.value === "html") repairValue.value = safe;
  else if (mode.value === "text") textRepair.value = htmlPlainText(safe);
  if (revisionChanged) syncVisualDom(safe, { force: true });
  else if (safe !== lastEmittedVisual.value) syncVisualDom(safe);
  if (safe !== next) emit("normalized", safe);
});
onMounted(() => {
  syncVisualDom(value.value, { force: true });
  if (value.value !== props.modelValue) emit("normalized", value.value);
});

const plainText = computed(() => {
  return htmlPlainText(value.value);
});

function updateFromVisual(event) {
  const safe = sanitizeEditorHtml(event.currentTarget.innerHTML);
  value.value = safe;
  lastEmittedVisual.value = safe;
  emit("update:modelValue", safe);
}

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
  emit("update:modelValue", safe);
}

function updateTextRepair(event) {
  textRepair.value = event.target.value;
  const safe = plainTextHtml(textRepair.value);
  value.value = safe;
  emit("update:modelValue", safe);
}

async function setMode(next) {
  mode.value = next;
  if (next === "html") repairValue.value = value.value;
  if (next === "text") textRepair.value = plainText.value;
  await nextTick();
  if (next === "visual") syncVisualDom(value.value, { force: true });
}

function command(name, argument = null) {
  if (props.disabled) return;
  visual.value?.focus();
  document.execCommand?.(name, false, argument);
  updateFromVisual({ currentTarget: visual.value });
}

function promptLink() {
  const href = window.prompt?.("请输入链接地址") || "";
  if (/^(https?:|mailto:)/i.test(href)) command("createLink", href);
}

function promptImage() {
  const src = window.prompt?.("请输入本站图片地址") || "";
  if (src.startsWith("/api/public/media/")) command("insertImage", src);
}

function cleanPastedHtml(html, text) {
  return sanitizeEditorHtml(html) || String(text || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replace(/\r?\n/g, "<br>");
}

function paste(event) {
  event.preventDefault();
  const cleaned = cleanPastedHtml(event.clipboardData?.getData("text/html"), event.clipboardData?.getData("text/plain"));
  if (document.execCommand) document.execCommand("insertHTML", false, cleaned);
  else if (visual.value) visual.value.innerHTML += cleaned;
  updateFromVisual({ currentTarget: visual.value });
}
</script>

<template>
  <section class="rich-text-editor" :class="{ disabled }">
    <div class="rich-editor-modes" role="tablist" aria-label="正文编辑模式">
      <button v-for="item in [['visual','可视化'],['html','HTML'],['text','纯文本']]" :key="item[0]" type="button" role="tab" :data-editor-mode="item[0]" :aria-selected="mode === item[0]" :disabled="disabled" @click="setMode(item[0])">{{ item[1] }}</button>
    </div>
    <div v-if="mode === 'visual'" class="rich-editor-toolbar" role="toolbar" aria-label="正文格式工具栏">
      <button type="button" aria-label="标题" :disabled="disabled" @click="command('formatBlock', 'h2')">标题</button>
      <button type="button" aria-label="粗体" :disabled="disabled" @click="command('bold')"><strong>B</strong></button>
      <button type="button" aria-label="斜体" :disabled="disabled" @click="command('italic')"><em>I</em></button>
      <button type="button" aria-label="无序列表" :disabled="disabled" @click="command('insertUnorderedList')">列表</button>
      <button type="button" aria-label="链接" :disabled="disabled" @click="promptLink">链接</button>
      <button type="button" aria-label="引用" :disabled="disabled" @click="command('formatBlock', 'blockquote')">引用</button>
      <button type="button" aria-label="图片" :disabled="disabled" @click="promptImage">图片</button>
    </div>
    <div v-if="mode === 'visual'" ref="visual" class="rich-editor-surface" data-rich-editor="visual" :contenteditable="disabled ? 'false' : 'true'" @focus="visualFocused = true" @blur="visualFocused = false; syncVisualDom(value, { force: true })" @compositionstart="composing = true" @compositionend="composing = false; updateFromVisual($event)" @input="updateFromVisual" @paste="paste"></div>
    <textarea v-else-if="mode === 'html'" :value="repairValue" data-rich-editor="html" :disabled="disabled" @input="updateHtmlRepair"></textarea>
    <textarea v-else :value="textRepair" data-rich-editor="text" :disabled="disabled" @input="updateTextRepair"></textarea>
  </section>
</template>
