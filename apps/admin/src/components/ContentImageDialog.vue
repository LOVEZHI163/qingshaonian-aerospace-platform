<script setup>
import { computed, nextTick, ref, shallowRef, watch } from "vue";

import { api } from "../lib/api.js";
import MediaPicker from "./MediaPicker.vue";

const props = defineProps({
  open: { type: Boolean, required: true },
  initial: {
    type: Object,
    default: () => ({ mediaId: "", alt: "", caption: "" })
  },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(["close", "select", "error"]);

const rows = ref([]);
const query = ref("");
const selectedMedia = ref(null);
const alt = ref("");
const caption = ref("");
const loading = ref(false);
const failure = ref("");
const dialog = ref(null);
const searchInput = ref(null);
const uploadHandlers = shallowRef({ uploaded: () => {}, error: () => {} });
let requestVersion = 0;
let sessionVersion = 0;

const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const visibleRows = computed(() => rows.value.filter((row) => !row.mimeType || allowedTypes.has(row.mimeType)));

function safeMedia(row) {
  if (!row?.id) return null;
  return {
    id: String(row.id),
    eventId: row.eventId ?? null,
    purpose: row.purpose || "",
    visibility: row.visibility || "",
    originalName: row.originalName || "",
    mimeType: row.mimeType || "",
    sizeBytes: row.sizeBytes ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    createdAt: row.createdAt || "",
    previewUrl: row.previewUrl || ""
  };
}

function reportError(error) {
  failure.value = error?.message || "图片媒体请求失败";
  emit("error", error);
}

async function loadMedia() {
  const version = ++requestVersion;
  loading.value = true;
  failure.value = "";
  try {
    const payload = await api(`/api/admin/site-media?kind=image&limit=100&q=${encodeURIComponent(query.value.trim())}`);
    if (version !== requestVersion || !props.open) return;
    rows.value = (payload.rows || []).map(safeMedia).filter(Boolean);
    if (selectedMedia.value?.id) {
      selectedMedia.value = rows.value.find((row) => row.id === selectedMedia.value.id) || selectedMedia.value;
    }
  } catch (error) {
    if (version === requestVersion && props.open) reportError(error);
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

function selectRow(row) {
  if (!props.disabled) selectedMedia.value = row;
}

function uploaded(row) {
  const media = safeMedia(row);
  if (!media || (media.mimeType && !allowedTypes.has(media.mimeType))) {
    reportError(new Error("只支持 PNG、JPEG 或 WebP 图片"));
    return;
  }
  failure.value = "";
  selectedMedia.value = media;
  rows.value = [media, ...rows.value.filter((item) => item.id !== media.id)];
}

function confirm() {
  if (props.disabled || !selectedMedia.value) return;
  emit("select", {
    media: selectedMedia.value,
    alt: alt.value,
    caption: caption.value
  });
}

function close() {
  requestVersion += 1;
  sessionVersion += 1;
  emit("close");
}

function beginUploadSession() {
  const session = ++sessionVersion;
  uploadHandlers.value = {
    uploaded: (row) => {
      if (props.open && session === sessionVersion) uploaded(row);
    },
    error: (error) => {
      if (props.open && session === sessionVersion) reportError(error);
    }
  };
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

watch(() => props.open, (open) => {
  if (!open) {
    requestVersion += 1;
    sessionVersion += 1;
    return;
  }
  beginUploadSession();
  const initial = props.initial || {};
  query.value = "";
  rows.value = [];
  alt.value = String(initial.alt || "");
  caption.value = String(initial.caption || "");
  selectedMedia.value = initial.mediaId ? safeMedia({ id: initial.mediaId }) : null;
  failure.value = "";
  loadMedia();
  nextTick(() => searchInput.value?.focus());
}, { immediate: true });
</script>

<template>
  <div v-if="open" class="dialog-backdrop" @click.self="close">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="content-image-title" class="panel content-image-dialog" tabindex="-1" @keydown="handleKeydown">
      <div class="panel-title">
        <h3 id="content-image-title">{{ initial?.mediaId ? "编辑正文图片" : "插入正文图片" }}</h3>
        <button type="button" data-action="close-content-image" @click="close">关闭</button>
      </div>

      <form class="form-actions" data-action="search-media" @submit.prevent="loadMedia">
        <input ref="searchInput" v-model="query" data-field="media-search" type="search" aria-label="搜索媒体" placeholder="按文件名或媒体 ID 搜索">
        <button type="submit" :disabled="loading">搜索</button>
        <MediaPicker
          purpose="content-body"
          accept="image/png,image/jpeg,image/webp"
          label="上传图片"
          :disabled="disabled"
          @uploaded="uploadHandlers.uploaded"
          @error="uploadHandlers.error"
        />
      </form>

      <p v-if="failure" role="alert">
        {{ failure }}
        <button type="button" data-action="retry-media" @click="loadMedia">重试媒体库</button>
      </p>
      <p v-else-if="loading">正在加载图片媒体库…</p>

      <div class="content-image-library" aria-label="图片媒体库">
        <button
          v-for="media in visibleRows"
          :key="media.id"
          type="button"
          :data-media-id="media.id"
          :aria-pressed="selectedMedia?.id === media.id"
          :disabled="disabled"
          @click="selectRow(media)"
        >
          <img v-if="media.previewUrl" :src="media.previewUrl" :alt="media.originalName || ''">
          <span>{{ media.originalName || media.id }}</span>
        </button>
        <p v-if="!loading && !failure && !visibleRows.length">暂无可选图片</p>
      </div>

      <label>替代文本<input v-model="alt" data-field="image-alt" :disabled="disabled"></label>
      <label>图片题注<input v-model="caption" data-field="image-caption" :disabled="disabled"></label>
      <div class="form-actions">
        <button type="button" @click="close">取消</button>
        <button
          type="button"
          class="primary"
          data-action="confirm-image"
          :disabled="disabled || !selectedMedia"
          @click="confirm"
        >{{ initial?.mediaId ? "保存图片" : "插入图片" }}</button>
      </div>
    </section>
  </div>
</template>
