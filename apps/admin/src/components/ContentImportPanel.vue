<script setup>
import { computed, reactive, ref } from "vue";

import { api, apiUrl } from "../lib/api.js";
import { contentImportError } from "../lib/content-import-errors.js";
import { CONTENT_TYPE_OPTIONS } from "../lib/content-type-labels.js";

const props = defineProps({ events: { type: Array, default: () => [] } });
const emit = defineEmits(["cancel", "committed"]);

const sourceUrl = ref("");
const batch = ref(null);
const busy = ref(false);
const actionImageId = ref("");
const error = ref("");
const duplicateContentId = ref("");
const committed = ref(false);
const selectedImageIds = ref([]);
const coverImageId = ref("");
const form = reactive({ title: "", summary: "", eventId: "", type: "news", slug: "" });

const readyImages = computed(() => (batch.value?.images || []).filter((image) => image.status === "ready"));
const storageWarning = computed(() => (batch.value?.warnings || []).find((warning) => warning.code === "IMPORT_STORAGE_WARNING"));

function slugify(value) {
  return String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
    || `repost-${Date.now()}`;
}

function applyBatch(row) {
  batch.value = row;
  form.title = row.title || "";
  form.summary = row.summary || "";
  form.slug = slugify(row.title);
  selectedImageIds.value = (row.images || []).filter((image) => image.status === "ready").map((image) => image.id);
  coverImageId.value = (row.images || []).find((image) => image.status === "ready" && image.coverCandidate)?.id || "";
}

async function inspect() {
  if (!sourceUrl.value.trim() || busy.value) return;
  busy.value = true; error.value = ""; duplicateContentId.value = "";
  try {
    const payload = await api("/api/admin/content-imports/inspect", {
      method: "POST", body: JSON.stringify({ sourceUrl: sourceUrl.value.trim() })
    });
    applyBatch(payload.row);
  } catch (failure) {
    error.value = contentImportError(failure);
    if (failure?.code === "IMPORT_DUPLICATE_SOURCE") duplicateContentId.value = failure?.payload?.details?.contentId || "";
  } finally { busy.value = false; }
}

async function retryImage(image) {
  actionImageId.value = image.id; error.value = "";
  try {
    const payload = await api(`/api/admin/content-imports/${batch.value.id}/images/${image.id}/retry`, { method: "POST" });
    Object.assign(image, payload.row);
    if (image.status === "ready" && !selectedImageIds.value.includes(image.id)) selectedImageIds.value.push(image.id);
  } catch (failure) { error.value = contentImportError(failure); }
  finally { actionImageId.value = ""; }
}

async function deleteImage(image) {
  actionImageId.value = image.id; error.value = "";
  try {
    const payload = await api(`/api/admin/content-imports/${batch.value.id}/images/${image.id}`, { method: "DELETE" });
    Object.assign(image, payload.row);
    selectedImageIds.value = selectedImageIds.value.filter((id) => id !== image.id);
    if (coverImageId.value === image.id) coverImageId.value = "";
  } catch (failure) { error.value = contentImportError(failure); }
  finally { actionImageId.value = ""; }
}

async function commit() {
  if (busy.value || !batch.value) return;
  busy.value = true; error.value = "";
  try {
    const payload = await api(`/api/admin/content-imports/${batch.value.id}/commit`, {
      method: "POST",
      body: JSON.stringify({ ...form, eventId: form.eventId || null, selectedImageIds: selectedImageIds.value, coverImageId: coverImageId.value || null })
    });
    committed.value = true;
    emit("committed", payload.row.id);
  } catch (failure) { error.value = contentImportError(failure); }
  finally { busy.value = false; }
}

async function cleanupBatch({ silent = false } = {}) {
  let cleanupError = "";
  if (batch.value && !committed.value) {
    try { await api(`/api/admin/content-imports/${batch.value.id}`, { method: "DELETE" }); }
    catch (failure) { cleanupError = contentImportError(failure); }
  }
  if (cleanupError && !silent) error.value = `临时转载任务清理失败：${cleanupError}`;
}

async function cancel() {
  await cleanupBatch();
  emit("cancel");
}

async function requestLeave(callback) {
  await cleanupBatch({ silent: true });
  callback?.();
}

defineExpose({ requestLeave });
</script>

<template>
  <section class="panel content-import-panel">
    <div class="panel-title"><div><h3>转载内容</h3><p>将公开文章安全整理为站内草稿，确认后再进入编辑和发布检查。</p></div><button type="button" data-action="cancel-import" @click="cancel()">返回内容列表</button></div>
    <p v-if="error" class="message danger-message" role="alert">{{ error }}</p>
    <button v-if="duplicateContentId" type="button" class="primary" data-action="open-existing-content" @click="emit('committed', duplicateContentId)">打开已有内容</button>

    <form v-if="!batch" class="content-import-start" @submit.prevent="inspect">
      <div class="content-import-step"><strong>第 1 步：粘贴微信公众号或新闻网页链接</strong><span>系统会自动提取正文并过滤广告、二维码等图片。</span></div>
      <label>原文链接<input v-model="sourceUrl" data-field="sourceUrl" type="url" required placeholder="https://mp.weixin.qq.com/s/... 或新闻网页地址"></label>
      <div class="form-actions"><button type="submit" class="primary" data-action="inspect-import" :disabled="busy || !sourceUrl.trim()">{{ busy ? "正在检查…" : "检查链接" }}</button></div>
    </form>

    <form v-else class="content-import-review" @submit.prevent="commit">
      <div class="content-import-step"><strong>第 2 步：检查并调整</strong><span>来源：{{ batch.sourceName || "未识别" }} · 作者：{{ batch.sourceAuthor || "未识别" }} · 原文时间：{{ batch.sourcePublishedAt ? new Date(batch.sourcePublishedAt).toLocaleString('zh-CN') : "未识别" }}</span></div>
      <p v-if="storageWarning" class="message warning-message">{{ storageWarning.message }}</p>
      <div class="content-import-fields">
        <label>标题<input v-model="form.title" data-field="importTitle" required></label>
        <label>公开地址 slug<input v-model="form.slug" data-field="importSlug" required></label>
        <label>归属赛事<select v-model="form.eventId" data-field="importEvent"><option value="">平台通用</option><option v-for="event in props.events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label>
        <label>内容类型<select v-model="form.type" data-field="importType"><option v-for="type in CONTENT_TYPE_OPTIONS" :key="type.value" :value="type.value">{{ type.label }}</option></select></label>
        <label class="content-import-summary">摘要<textarea v-model="form.summary" rows="3"></textarea></label>
      </div>
      <div class="content-import-layout">
        <section><h4>正文预览</h4><div class="content-import-preview" data-import-preview v-html="batch.previewHtml"></div></section>
        <aside><h4>文章图片</h4><p class="hint">勾选要保存到正文的图片，并可指定一张封面。</p>
          <article v-for="image in batch.images" :key="image.id" class="content-import-image" :class="image.status" :data-image="image.id">
            <img v-if="image.status === 'ready'" :src="apiUrl(`/api/admin/content-imports/${batch.id}/images/${image.id}`)" :alt="image.alt || image.originalName">
            <div><strong>{{ image.originalName || "文章图片" }}</strong><small>{{ image.status === "ready" ? "可使用" : (image.reason || "不可使用") }}</small>
              <label v-if="image.status === 'ready'"><input v-model="selectedImageIds" type="checkbox" :value="image.id">保存正文图片</label>
              <label v-if="image.status === 'ready'"><input v-model="coverImageId" type="radio" name="import-cover" :value="image.id">设为封面</label>
              <div class="form-actions"><button v-if="image.status !== 'ready' && image.status !== 'deleted'" type="button" data-action="retry-image" :disabled="actionImageId === image.id" @click="retryImage(image)">重试</button><button v-if="image.status !== 'deleted'" type="button" data-action="delete-image" :disabled="actionImageId === image.id" @click="deleteImage(image)">删除</button></div>
            </div>
          </article>
          <p v-if="!batch.images.length">原文没有可处理的图片。</p>
        </aside>
      </div>
      <div class="content-import-commit"><div><strong>第 3 步：保存草稿</strong><p>仅保存为草稿，不会直接发布。保存后请继续检查排版、封面与来源信息。</p></div><button type="submit" class="primary" data-action="commit-import" :disabled="busy || !form.title.trim() || !form.slug.trim()">{{ busy ? "正在保存…" : "保存为草稿" }}</button></div>
    </form>
  </section>
</template>
