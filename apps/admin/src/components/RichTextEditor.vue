<script setup>
import { computed, nextTick, ref, watch } from "vue";

const props = defineProps({ modelValue: { type: String, default: "" }, disabled: { type: Boolean, default: false } });
const emit = defineEmits(["update:modelValue"]);
const mode = ref("visual");
const visual = ref(null);
const value = ref(props.modelValue);

watch(() => props.modelValue, (next) => {
  if (next === value.value) return;
  value.value = next || "";
  if (visual.value && mode.value === "visual" && visual.value.innerHTML !== value.value) visual.value.innerHTML = value.value;
});

const plainText = computed(() => {
  const container = document.createElement("div");
  container.innerHTML = value.value;
  return container.textContent || "";
});

function update(next) {
  value.value = next;
  emit("update:modelValue", next);
}

async function setMode(next) {
  mode.value = next;
  await nextTick();
  if (next === "visual" && visual.value) visual.value.innerHTML = value.value;
}

function command(name, argument = null) {
  if (props.disabled) return;
  visual.value?.focus();
  document.execCommand?.(name, false, argument);
  update(visual.value?.innerHTML || value.value);
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
  const documentFragment = new DOMParser().parseFromString(html || "", "text/html");
  documentFragment.querySelectorAll("script,style,iframe,object,embed").forEach((node) => node.remove());
  documentFragment.body.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const keepHref = node.tagName === "A" && attribute.name === "href" && /^(https?:|mailto:)/i.test(attribute.value);
      const keepImage = node.tagName === "IMG" && ["src", "alt"].includes(attribute.name)
        && (attribute.name === "alt" || attribute.value.startsWith("/api/public/media/"));
      if (!keepHref && !keepImage) node.removeAttribute(attribute.name);
    }
  });
  return documentFragment.body.innerHTML || String(text || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replace(/\r?\n/g, "<br>");
}

function paste(event) {
  event.preventDefault();
  const cleaned = cleanPastedHtml(event.clipboardData?.getData("text/html"), event.clipboardData?.getData("text/plain"));
  if (document.execCommand) document.execCommand("insertHTML", false, cleaned);
  else if (visual.value) visual.value.innerHTML += cleaned;
  update(visual.value?.innerHTML || cleaned);
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
    <div v-if="mode === 'visual'" ref="visual" class="rich-editor-surface" data-rich-editor="visual" :contenteditable="disabled ? 'false' : 'true'" @input="update($event.currentTarget.innerHTML)" @paste="paste" v-html="value"></div>
    <textarea v-else-if="mode === 'html'" :value="value" data-rich-editor="html" :disabled="disabled" @input="update($event.target.value)"></textarea>
    <textarea v-else :value="plainText" data-rich-editor="text" :disabled="disabled" @input="update(`<p>${$event.target.value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replace(/\r?\n/g, '</p><p>')}</p>`)"></textarea>
  </section>
</template>
