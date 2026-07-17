<script setup>
import { computed } from "vue";

import { apiUrl } from "../lib/api.js";

const props = defineProps({
  file: { type: Object, default: null }
});

defineEmits(["close"]);

const previewSource = computed(() => props.file?.previewUrl ? apiUrl(props.file.previewUrl) : "");
const isPdf = computed(() => {
  const name = String(props.file?.fileName || props.file?.title || "").toLowerCase();
  return props.file?.mimeType === "application/pdf" || name.endsWith(".pdf");
});
</script>

<template>
  <div v-if="file" class="dialog-backdrop file-preview-backdrop" role="presentation" @click.self="$emit('close')">
    <section class="panel file-preview-dialog" role="dialog" aria-modal="true" aria-label="证书预览">
      <div class="page-title-row">
        <div><h3>{{ file.title || "证书预览" }}</h3><p>{{ file.fileName || "导入预览" }}</p></div>
        <button type="button" class="ghost" @click="$emit('close')">关闭</button>
      </div>
      <p v-if="file.cleanedAt" class="message">文件已清理，当前不可预览或下载。</p>
      <p v-else-if="!previewSource" class="hint empty-state">接口未提供预览地址，当前不可预览。</p>
      <iframe v-else-if="isPdf" class="certificate-pdf-preview" :src="previewSource" title="PDF 证书预览" />
      <img v-else class="certificate-image-preview" :src="previewSource" :alt="`${file.title || '证书'}预览`" />
    </section>
  </div>
</template>
