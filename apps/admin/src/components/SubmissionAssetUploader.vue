<script setup>
import { onBeforeUnmount, reactive, watch } from "vue";

import { apiUrl } from "../lib/api.js";
import { uploadFile } from "../lib/upload.js";

const props = defineProps({
  sessionId: { type: String, required: true },
  mode: { type: String, required: true },
  assets: { type: Object, default: () => ({}) }
});
const emit = defineEmits(["complete", "error"]);

const definitions = {
  artwork_image: { label: "作品图片", endpoint: "artwork-image", accept: ".jpg,.jpeg,.png" },
  creation_video: { label: "作画视频", endpoint: "creation-video", accept: ".mp4" }
};
const kinds = Object.keys(definitions);
const state = reactive(Object.fromEntries(kinds.map((kind) => [kind, {
  asset: null, uploading: false, progress: null, error: "", previewUrl: "", previewObjectUrl: "", controller: null, requestId: 0
}])));
let disposed = false;

function displaySize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round((value / 1024) * 10) / 10} KB`;
  return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
}

function displayDuration(milliseconds) {
  const seconds = Math.round(Number(milliseconds || 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function persistedPreview(asset) {
  const path = asset?.previewUrl || asset?.previewPath || "";
  return path ? apiUrl(path) : "";
}

function clearObjectPreview(kind) {
  const current = state[kind];
  if (current.previewObjectUrl) URL.revokeObjectURL(current.previewObjectUrl);
  current.previewObjectUrl = "";
}

function cancelUpload(kind) {
  const current = state[kind];
  current.requestId += 1;
  current.controller?.abort();
  current.controller = null;
  current.uploading = false;
  current.progress = null;
}

function clearAssetState(kind, { cancel = true } = {}) {
  const current = state[kind];
  if (cancel) cancelUpload(kind);
  clearObjectPreview(kind);
  current.asset = null;
  current.previewUrl = "";
  current.error = "";
  current.progress = null;
}

function setPersistedAsset(kind, asset, { cancel = true } = {}) {
  if (!asset) {
    clearAssetState(kind, { cancel });
    return;
  }
  const current = state[kind];
  if (cancel) cancelUpload(kind);
  clearObjectPreview(kind);
  current.asset = asset;
  current.previewUrl = persistedPreview(asset);
  current.error = "";
  current.progress = null;
}

function pairComplete() {
  return kinds.every((kind) => Boolean(state[kind].asset) && !state[kind].asset.cleanedAt);
}

function publishComplete() {
  emit("complete", pairComplete());
}

watch(
  () => [props.sessionId, props.mode],
  () => {
    for (const kind of kinds) clearAssetState(kind);
    if (props.mode === "image_video") {
      for (const kind of kinds) setPersistedAsset(kind, props.assets?.[kind], { cancel: false });
    }
    publishComplete();
  },
  { immediate: true }
);

watch(
  () => props.assets,
  (assets) => {
    for (const kind of kinds) setPersistedAsset(kind, props.mode === "image_video" ? assets?.[kind] : null);
    publishComplete();
  },
  { immediate: true, deep: true }
);

function currentRequest(kind, request) {
  const current = state[kind];
  return !disposed
    && current.requestId === request.id
    && current.controller === request.controller
    && props.sessionId === request.sessionId
    && props.mode === request.mode;
}

async function chooseAsset(kind, event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || props.mode !== "image_video") return;

  cancelUpload(kind);
  const current = state[kind];
  const controller = new AbortController();
  const request = { id: current.requestId + 1, controller, sessionId: props.sessionId, mode: props.mode };
  current.requestId = request.id;
  current.controller = controller;
  current.uploading = true;
  current.progress = { loaded: 0, total: file.size, percent: 0 };
  current.error = "";
  try {
    const result = await uploadFile(`/api/upload-sessions/${encodeURIComponent(props.sessionId)}/${definitions[kind].endpoint}`, file, {
      signal: controller.signal,
      onProgress(progress) {
        if (currentRequest(kind, request)) current.progress = progress;
      }
    });
    if (!currentRequest(kind, request)) return;
    const asset = result?.row || result;
    if (!asset?.id) throw new Error("上传结果无效，请重新选择文件");
    if (kind === "artwork_image") {
      clearObjectPreview(kind);
      current.previewObjectUrl = URL.createObjectURL(file);
      current.previewUrl = current.previewObjectUrl;
    }
    current.asset = asset;
    current.progress = null;
    publishComplete();
  } catch (error) {
    if (!currentRequest(kind, request)) return;
    if (error?.name === "AbortError") {
      current.progress = null;
      return;
    }
    current.error = error?.message || `${definitions[kind].label}上传失败，请稍后重试`;
    current.progress = null;
    emit("error", error);
    publishComplete();
  } finally {
    if (currentRequest(kind, request)) {
      current.uploading = false;
      current.controller = null;
    }
  }
}

onBeforeUnmount(() => {
  disposed = true;
  for (const kind of kinds) {
    cancelUpload(kind);
    clearObjectPreview(kind);
  }
});
</script>

<template>
  <section v-if="mode === 'image_video'" class="submission-asset-uploader" aria-label="作品材料上传">
    <article v-for="kind in kinds" :key="kind" class="submission-asset-card" :data-asset-card="kind">
      <div class="panel-title">
        <h4>{{ definitions[kind].label }}</h4>
        <em :class="state[kind].asset ? 'success' : 'empty'">{{ state[kind].asset ? '已上传' : '必传' }}</em>
      </div>
      <label class="file-action" :for="`submission-${kind}`">
        {{ state[kind].uploading ? '正在上传…' : state[kind].asset ? '重新选择文件' : '选择文件' }}
        <input :id="`submission-${kind}`" :data-action="`choose-${kind}`" type="file" :accept="definitions[kind].accept" @change="chooseAsset(kind, $event)">
      </label>
      <p class="hint">{{ kind === 'artwork_image' ? '仅 JPG、JPEG、PNG，最大 2MB' : '仅 MP4，最大 200MB、时长不超过 2 分钟' }}</p>
      <div v-if="state[kind].progress" class="submission-upload-progress">
        <progress :value="state[kind].progress.percent" max="100" :aria-label="`${definitions[kind].label}上传进度`"></progress>
        <span>{{ state[kind].progress.percent }}%</span>
      </div>
      <p v-if="state[kind].error" class="message" role="alert">{{ state[kind].error }}</p>
      <div v-if="state[kind].asset" class="submission-asset-details">
        <img v-if="kind === 'artwork_image' && state[kind].previewUrl" class="submission-artwork-preview" :src="state[kind].previewUrl" :alt="`${state[kind].asset.originalName} 预览`">
        <video v-else-if="kind === 'creation_video' && state[kind].previewUrl" class="submission-video-preview" :src="state[kind].previewUrl" controls preload="metadata"></video>
        <p>{{ state[kind].asset.originalName }}</p>
        <p>{{ displaySize(state[kind].asset.sizeBytes) }}<template v-if="state[kind].asset.width && state[kind].asset.height"> · {{ state[kind].asset.width }} × {{ state[kind].asset.height }}</template><template v-if="state[kind].asset.durationMs != null"> · {{ displayDuration(state[kind].asset.durationMs) }}</template></p>
        <p v-for="warning in state[kind].asset.warnings || []" :key="warning" class="submission-warning" role="status">{{ warning }}</p>
      </div>
    </article>
  </section>
</template>
