<script setup>
import { computed, onBeforeUnmount, ref } from "vue";

import { api, apiBlob, apiUrl } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import SubmissionAssetUploader from "./SubmissionAssetUploader.vue";

const props = defineProps({
  eventId: { type: String, required: true },
  registration: { type: Object, required: true },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(["close", "refresh", "error"]);

const kinds = ["artwork_image", "creation_video"];
const labels = { artwork_image: "作品图片", creation_video: "作画视频" };
const downloads = createBlobDownloadManager();
const replacing = ref(false);
const replacementSession = ref(null);
const replacementLoading = ref(false);
const replacementComplete = ref(false);
const replacementCompletedKinds = ref(new Set());
const replacementError = ref("");
const replacementResult = ref("");
const missingFiles = ref(new Set());
let replacementRequest = 0;

const submission = computed(() => props.registration?.submission || null);
const assets = computed(() => submission.value?.assets || {});
const remainingReplacementKinds = computed(() => kinds.filter((kind) => !replacementCompletedKinds.value.has(kind)));
const partialReplacementMessage = computed(() => {
  const completed = kinds.filter((kind) => replacementCompletedKinds.value.has(kind)).map((kind) => labels[kind]);
  const remaining = remainingReplacementKinds.value.map((kind) => labels[kind]);
  return completed.length && remaining.length ? `${completed.join("、")}已替换，${remaining.join("、")}仍待替换` : "";
});

function assetPath(kind) {
  return `/api/admin/events/${encodeURIComponent(props.eventId)}/registrations/${encodeURIComponent(props.registration.id)}/assets/${kind}`;
}

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

function displayTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN");
}

function assetAvailable(asset, kind) {
  return Boolean(asset && !asset.cleanedAt && !missingFiles.value.has(kind));
}

function assetMessage(asset, kind) {
  if (missingFiles.value.has(kind)) return "文件缺失或损坏，无法播放或下载";
  if (!asset) return "待上传";
  if (asset.cleanedAt) return kind === "creation_video" ? "视频文件已由管理员清理" : "图片文件已由管理员清理";
  return "可预览";
}

function submissionStatus() {
  if (!submission.value?.required) return "无需作品";
  const values = kinds.map((kind) => assets.value[kind]);
  if (values.some((asset) => asset?.cleanedAt)) return "已清理";
  if (missingFiles.value.size) return "文件缺失";
  if (values.every((asset) => !asset)) return "待上传";
  if (values.some((asset) => !asset)) return "文件缺失";
  if (submission.value.warnings?.length) return "有警告";
  return "已齐全";
}

function noteMissing(kind) {
  missingFiles.value = new Set([...missingFiles.value, kind]);
}

async function downloadAsset(kind, asset) {
  if (!assetAvailable(asset, kind)) return;
  try {
    const blob = await apiBlob(assetPath(kind));
    downloads.save(blob, blob.fileName || asset.originalName);
  } catch (error) {
    emit("error", error?.message || "作品材料下载失败，请重试");
  }
}

function cancelReplacement({ keepResult = false } = {}) {
  replacementRequest += 1;
  replacing.value = false;
  replacementSession.value = null;
  replacementLoading.value = false;
  replacementComplete.value = false;
  replacementCompletedKinds.value = new Set();
  replacementError.value = "";
  if (!keepResult) replacementResult.value = "";
}

async function createReplacementSession() {
  if (props.disabled || !props.registration?.projectId) return;
  const request = replacementRequest + 1;
  replacementRequest = request;
  replacing.value = true;
  replacementSession.value = null;
  replacementComplete.value = false;
  replacementCompletedKinds.value = new Set();
  replacementError.value = "";
  replacementResult.value = "";
  replacementLoading.value = true;
  try {
    const payload = await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/projects/${encodeURIComponent(props.registration.projectId)}/upload-sessions`, { method: "POST" });
    if (request !== replacementRequest || !replacing.value) return;
    const session = payload?.row || payload;
    if (!session?.id) throw new Error("invalid upload session");
    replacementSession.value = session;
  } catch (error) {
    if (request !== replacementRequest || !replacing.value) return;
    replacementError.value = error?.message || "无法创建作品上传会话，请重试";
  } finally {
    if (request === replacementRequest) replacementLoading.value = false;
  }
}

function retryReplacement() {
  if (replacementSession.value?.id) void confirmReplacement();
  else void createReplacementSession();
}

async function confirmReplacement() {
  const sessionId = replacementSession.value?.id;
  const registrationId = props.registration?.id;
  const generation = replacementRequest;
  const currentReplacement = () => (
    replacementRequest === generation
    && replacing.value
    && replacementSession.value?.id === sessionId
    && props.registration?.id === registrationId
  );
  if (!sessionId || !registrationId || !replacementComplete.value || replacementLoading.value || !currentReplacement()) return;
  replacementLoading.value = true;
  replacementError.value = "";
  try {
    for (const kind of remainingReplacementKinds.value) {
      if (!currentReplacement()) return;
      await api(assetPath(kind), { method: "PUT", body: JSON.stringify({ uploadSessionId: sessionId }) });
      if (!currentReplacement()) return;
      replacementCompletedKinds.value = new Set([...replacementCompletedKinds.value, kind]);
      emit("refresh");
    }
    if (!currentReplacement()) return;
    replacementResult.value = "作品材料已替换，报名已恢复待审核";
    cancelReplacement({ keepResult: true });
  } catch (error) {
    if (currentReplacement()) replacementError.value = error?.message || "作品材料替换失败，请重试";
  } finally {
    if (currentReplacement()) replacementLoading.value = false;
  }
}

onBeforeUnmount(() => {
  replacementRequest += 1;
  downloads.dispose();
});
</script>

<template>
  <aside class="submission-asset-review" aria-label="作品材料审核">
    <div class="panel-title"><div><h3>作品材料审核</h3><p class="hint">状态：{{ submissionStatus() }}</p></div><button type="button" class="mini" aria-label="关闭作品材料审核" @click="emit('close')">关闭</button></div>
    <p v-if="!submission?.required" class="hint">无需作品材料。</p>
    <template v-else>
      <article v-for="kind in kinds" :key="kind" class="submission-asset-card submission-review-card" :data-asset-kind="kind">
        <div class="panel-title"><h4>{{ labels[kind] }}</h4><em :class="assetAvailable(assets[kind], kind) ? 'success' : 'empty'">{{ assetMessage(assets[kind], kind) }}</em></div>
        <template v-if="assetAvailable(assets[kind], kind)">
          <img v-if="kind === 'artwork_image'" class="submission-artwork-preview" :src="apiUrl(assetPath(kind))" :alt="`${assets[kind].originalName} 高清预览`" @error="noteMissing(kind)">
          <video v-else class="submission-video-preview" :src="apiUrl(assetPath(kind))" controls preload="metadata" aria-label="播放作画视频" @error="noteMissing(kind)"></video>
          <button type="button" class="mini" :data-action="`download-${kind}`" :aria-label="`下载${labels[kind]}`" @click="downloadAsset(kind, assets[kind])">下载原文件</button>
        </template>
        <p v-if="assets[kind]" class="submission-asset-metadata">{{ assets[kind].originalName }} · {{ displaySize(assets[kind].sizeBytes) }}<template v-if="assets[kind].width && assets[kind].height"> · {{ assets[kind].width }} × {{ assets[kind].height }}</template><template v-if="assets[kind].durationMs != null"> · {{ displayDuration(assets[kind].durationMs) }}</template></p>
        <p v-if="assets[kind]" class="hint">上传时间：{{ displayTime(assets[kind].uploadedAt) }}</p>
        <p v-for="warning in assets[kind]?.warnings || []" :key="warning" class="submission-warning" role="status">{{ warning }}</p>
      </article>
      <p v-for="warning in submission.warnings || []" :key="`submission-${warning}`" class="submission-warning" role="status">{{ warning }}</p>
      <button v-if="!disabled && !replacing" type="button" class="mini" data-action="replace-materials" aria-label="替换作品材料" @click="createReplacementSession">替换材料</button>
    </template>

    <section v-if="replacing" class="registration-submission admin-material-replacement" aria-label="替换作品材料">
      <h4>替换作品材料</h4>
      <p v-if="replacementLoading && !replacementSession" class="hint">正在创建作品上传会话…</p>
      <template v-else-if="replacementSession?.id">
        <SubmissionAssetUploader :key="replacementSession.id" :session-id="replacementSession.id" mode="image_video" :assets="replacementSession.assets || {}" @complete="replacementComplete = $event" @error="replacementError = '作品材料上传失败，请重试'" />
        <p v-if="partialReplacementMessage" class="message" role="status">{{ partialReplacementMessage }}</p>
        <p v-if="replacementError" class="message" role="alert">{{ replacementError }}</p>
        <button type="button" class="primary" data-action="confirm-replacement" :disabled="replacementLoading || !replacementComplete || !remainingReplacementKinds.length" @click="confirmReplacement">{{ replacementLoading ? '正在替换…' : partialReplacementMessage ? '继续替换剩余材料' : '确认替换作品材料' }}</button>
        <button v-if="replacementError" type="button" class="mini" data-action="retry-replacement" :disabled="replacementLoading" @click="retryReplacement">重试</button>
        <button type="button" class="mini" @click="cancelReplacement">取消替换</button>
      </template>
      <p v-else class="message" role="alert">{{ replacementError || '作品上传会话不可用' }} <button type="button" class="mini" data-action="retry-replacement" @click="retryReplacement">重试</button></p>
    </section>
    <p v-if="replacementResult" class="message" role="status">{{ replacementResult }}</p>
  </aside>
</template>
