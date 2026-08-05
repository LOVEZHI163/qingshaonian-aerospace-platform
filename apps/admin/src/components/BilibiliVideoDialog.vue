<script setup>
import { computed, nextTick, ref, watch } from "vue";

import { bilibiliPlayerUrl, parseBilibiliInput } from "../lib/bilibili-video.js";

const props = defineProps({
  open: { type: Boolean, required: true },
  initial: { type: Object, default: () => ({ bvid: "", title: "" }) },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(["close", "select"]);

const url = ref("");
const title = ref("");
const dialog = ref(null);
const urlInput = ref(null);
const parsed = computed(() => parseBilibiliInput(url.value));
const normalizedTitle = computed(() => title.value.trim());
const canSubmit = computed(() => !props.disabled && parsed.value.ok && Boolean(normalizedTitle.value));
const shortLinkHelp = parseBilibiliInput("https://b23.tv/link").message;

watch(() => [props.open, props.initial], ([open]) => {
  if (!open) return;
  url.value = props.initial?.bvid || "";
  title.value = props.initial?.title || "";
  nextTick(() => urlInput.value?.focus());
}, { immediate: true, deep: true });

function close() {
  emit("close");
}

function confirm() {
  if (!canSubmit.value) return;
  emit("select", { bvid: parsed.value.bvid, title: normalizedTitle.value });
}

function focusableElements() {
  return [...(dialog.value?.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  ) || [])];
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements();
  if (!focusable.length) {
    event.preventDefault();
    dialog.value?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (!dialog.value?.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <div v-if="open" class="dialog-backdrop" @click.self="close">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="bilibili-video-title" aria-describedby="bilibili-video-instructions" class="panel content-bilibili-dialog" tabindex="-1" @keydown="handleKeydown">
      <div class="panel-title">
        <h3 id="bilibili-video-title">{{ initial?.bvid ? "编辑B站视频" : "插入B站视频" }}</h3>
        <button type="button" data-action="close-bilibili-video" @click="close">关闭</button>
      </div>
      <p id="bilibili-video-instructions" class="content-bilibili-help">填写B站完整视频链接或BV号和自定义标题，系统将生成封面与播放器。</p>

      <label>
        B站视频链接或BV号
        <input ref="urlInput" v-model="url" data-field="bilibili-url" :disabled="disabled" placeholder="https://www.bilibili.com/video/BV... 或 BV...">
      </label>
      <p class="content-bilibili-help">{{ shortLinkHelp }}</p>
      <p v-if="url && !parsed.ok" role="alert">{{ parsed.message }}</p>
      <p v-if="parsed.ok" class="content-bilibili-help" data-bilibili-recognized>已识别：{{ parsed.bvid }}</p>

      <label>
        视频标题
        <input v-model="title" data-field="bilibili-title" :disabled="disabled">
      </label>
      <p v-if="parsed.ok && !normalizedTitle" role="alert">请填写视频标题。</p>

      <div v-if="parsed.ok && normalizedTitle" class="content-bilibili-preview">
        <iframe
          :src="bilibiliPlayerUrl(parsed.bvid)"
          :title="`B站视频预览：${normalizedTitle}`"
          loading="lazy"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
        />
      </div>

      <div class="form-actions">
        <button type="button" @click="close">取消</button>
        <button type="button" class="primary" data-action="confirm-bilibili-video" :disabled="!canSubmit" @click="confirm">
          {{ initial?.bvid ? "保存视频" : "插入视频" }}
        </button>
      </div>
    </section>
  </div>
</template>
