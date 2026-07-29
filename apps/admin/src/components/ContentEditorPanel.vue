<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { api } from "../lib/api.js";
import ContentPublicationReview from "./ContentPublicationReview.vue";
import ContentPreviewDialog from "./ContentPreviewDialog.vue";
import MediaPicker from "./MediaPicker.vue";
import RichTextEditor from "./RichTextEditor.vue";

const props = defineProps({ contentId: { type: String, default: null }, events: { type: Array, default: () => [] }, profiles: { type: Array, default: () => [] } });
const emit = defineEmits(["saved", "deleted", "navigate"]);
const types = [["announcement","公告"],["news","新闻"],["work","作品"],["recap","回顾"],["guide","指南"]];
const states = { draft: "草稿", scheduled: "定时发布", published: "已发布", offline: "已下线" };
const blank = () => ({ id: null, slug: "", eventId: null, type: "news", title: "", summary: "", bodyHtml: "", status: "draft", publishAt: null, pinned: false, sortOrder: 0, coverMediaId: null, coverMedia: null, attachments: [], version: null });
const form = reactive(blank());
const loading = ref(false);
const loadFailed = ref(false);
const busy = ref(false);
const error = ref("");
const success = ref("");
const previewOpen = ref(false);
const previewHtml = ref("");
const reviewing = ref(false);
const confirmAction = ref(null);
const confirmButton = ref(null);
const editorHeading = ref(null);
const pendingMedia = ref([]);
const deletingMedia = ref(new Set());
const baseline = ref(JSON.stringify(blank()));
const persistedPreview = ref(null);
let leaveCallback = null;
let confirmReturnFocus = null;
let preferStableFocus = false;
let loadSequence = 0;
let loadController = null;

const published = computed(() => form.status === "published");
const dirty = computed(() => JSON.stringify(snapshot()) !== baseline.value);
const statusLabel = computed(() => states[form.status] || form.status);
const selectedEvent = computed(() => props.events.find((event) => event.id === form.eventId) || null);
const selectedProfile = computed(() => props.profiles.find((profile) => profile.eventId === form.eventId) || null);

function snapshot() {
  return {
    slug: form.slug, eventId: form.eventId || null, type: form.type, title: form.title,
    summary: form.summary, bodyHtml: form.bodyHtml, status: form.status,
    publishAt: form.publishAt || null, pinned: Boolean(form.pinned), sortOrder: Number(form.sortOrder || 0),
    coverMediaId: form.coverMediaId || null,
    attachments: form.attachments.map((item, index) => ({ mediaId: item.mediaId, label: item.label || "", displayOrder: index }))
  };
}

function localDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function applyRow(row, { keepPending = false } = {}) {
  Object.assign(form, blank(), row, {
    eventId: row.eventId || null,
    publishAt: localDateTime(row.publishAt),
    attachments: (row.attachments || []).map((item) => ({ ...item, label: item.label || "" }))
  });
  persistedPreview.value = row.id ? {
    id: row.id,
    slug: typeof row.slug === "string" ? row.slug : "",
    status: row.status,
    publishAt: row.publishAt || null
  } : null;
  if (!keepPending) pendingMedia.value = [];
  baseline.value = JSON.stringify(snapshot());
}

async function load() {
  const sequence = ++loadSequence;
  loadController?.abort();
  error.value = ""; success.value = "";
  loadFailed.value = false;
  reviewing.value = false;
  applyRow(blank());
  if (!props.contentId) { loading.value = false; return; }
  loading.value = true;
  loadController = new AbortController();
  try {
    const payload = await api(`/api/admin/content/${props.contentId}`, { signal: loadController.signal });
    if (sequence !== loadSequence) return;
    applyRow(payload.row);
  } catch (failure) {
    if (sequence !== loadSequence || failure?.name === "AbortError") return;
    loadFailed.value = true;
    error.value = failure?.message || "内容加载失败";
  } finally { if (sequence === loadSequence) loading.value = false; }
}

watch(() => props.contentId, load, { immediate: true });
watch(confirmAction, async (action, previous) => {
  if (action && !previous) {
    confirmReturnFocus = document.activeElement;
    document.addEventListener("keydown", handleConfirmKey);
    await nextTick(); confirmButton.value?.focus();
  } else if (!action && previous) {
    document.removeEventListener("keydown", handleConfirmKey);
    if (!preferStableFocus && confirmReturnFocus?.isConnected && !confirmReturnFocus.disabled) {
      confirmReturnFocus.focus(); confirmReturnFocus = null; return;
    }
    await nextTick(); editorHeading.value?.focus?.(); confirmReturnFocus = null; preferStableFocus = false;
  }
});
function handleConfirmKey(event) {
  if (event.key === "Escape") { cancelConfirm(); return; }
  if (event.key !== "Tab") return;
  const dialog = confirmButton.value?.closest('[role="dialog"]');
  const focusable = [...(dialog?.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])") || [])];
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable.at(-1);
  if ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first)) {
    event.preventDefault(); (event.shiftKey ? last : first).focus();
  }
}
onBeforeUnmount(() => { document.removeEventListener("keydown", handleConfirmKey); loadController?.abort(); });

function requestLeave(callback) {
  if (!dirty.value) { callback(); return; }
  leaveCallback = callback;
  confirmAction.value = "discard";
}

function contentPayload({ forPreview = false } = {}) {
  const data = snapshot();
  if (forPreview) {
    if (data.publishAt) {
      const date = new Date(form.publishAt);
      if (!Number.isNaN(date.getTime())) data.publishAt = date.toISOString();
    }
    if (form.id) { data.id = form.id; data.version = form.version; }
    return data;
  }

  if (!form.id) { data.status = "draft"; data.publishAt = null; return data; }
  if (data.status === "draft") data.publishAt = null;
  else if (data.status === "scheduled") {
    const date = new Date(form.publishAt || "");
    if (Number.isNaN(date.getTime()) || date <= new Date()) throw new Error("请选择未来的发布时间");
    data.publishAt = date.toISOString();
  }
  if (form.id) data.version = form.version;
  return data;
}

async function save({ openReview = false } = {}) {
  if (busy.value || published.value) return null;
  error.value = ""; success.value = "";
  let body;
  try { body = contentPayload(); }
  catch (failure) { error.value = failure.message; return null; }
  busy.value = true;
  try {
    const path = form.id ? `/api/admin/content/${form.id}` : "/api/admin/content";
    const payload = await api(path, { method: form.id ? "PATCH" : "POST", body: JSON.stringify(body) });
    applyRow(payload.row, { keepPending: true }); success.value = "内容已保存"; emit("saved", payload.row);
    if (openReview) reviewing.value = true;
    return payload.row;
  } catch (failure) {
    error.value = failure?.status === 409 ? "内容已被其他管理员更新，请刷新后重试" : (failure?.message || "内容保存失败");
    return null;
  } finally { busy.value = false; }
}

async function saveAndReview() {
  if (published.value) return;
  if (dirty.value || !form.id) {
    await save({ openReview: true });
    return;
  }
  reviewing.value = true;
}

async function saveAndPreview() {
  const saved = await save();
  if (saved) await preview();
}

async function preview() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const response = await api("/api/admin/site-preview/content", {
      method: "POST",
      body: JSON.stringify(contentPayload({ forPreview: true }))
    });
    const html = response?.preview?.payload?.row?.bodyHtml;
    if (typeof html !== "string") throw new Error("预览数据无效");
    previewHtml.value = html;
    previewOpen.value = true;
  } catch (failure) { error.value = failure?.message || "预览加载失败"; }
  finally { busy.value = false; }
}

function ask(action) { if (!busy.value) confirmAction.value = action; }
function cancelConfirm() { confirmAction.value = null; leaveCallback = null; }

async function confirm() {
  const action = confirmAction.value;
  if (action === "discard") {
    const callback = leaveCallback; confirmAction.value = null; leaveCallback = null; callback?.(); return;
  }
  if (!form.id || busy.value) return;
  busy.value = true; error.value = ""; success.value = "";
  try {
    if (action === "delete") {
      await api(`/api/admin/content/${form.id}`, { method: "DELETE", body: JSON.stringify({ version: form.version }) });
      const id = form.id; applyRow(blank()); success.value = "内容已删除"; emit("deleted", id);
    } else {
      const payload = await api(`/api/admin/content/${form.id}/${action}`, { method: "POST", body: JSON.stringify({ version: form.version }) });
      applyRow(payload.row, { keepPending: true }); success.value = action === "publish" ? "内容已发布" : "内容已下线"; emit("saved", payload.row);
      if (action === "publish") reviewing.value = false;
    }
    preferStableFocus = true;
    confirmAction.value = null;
  } catch (failure) { error.value = failure?.status === 409 ? "内容已被其他管理员更新，请刷新后重试" : (failure?.message || "操作失败"); }
  finally { busy.value = false; }
}

function uploadedCover(media) {
  if (form.coverMediaId && form.coverMediaId !== media.id) rememberMedia(form.coverMedia || { id: form.coverMediaId, originalName: `媒体 ${form.coverMediaId}` });
  form.coverMediaId = media.id; form.coverMedia = media;
}
function uploadedAttachment(media) { form.attachments.push({ mediaId: media.id, label: media.originalName || "", displayOrder: form.attachments.length, media }); }
function moveAttachment(mediaId, delta) { const index = form.attachments.findIndex((row) => row.mediaId === mediaId); const target = index + delta; if (index < 0 || target < 0 || target >= form.attachments.length) return; [form.attachments[index], form.attachments[target]] = [form.attachments[target], form.attachments[index]]; }
function rememberMedia(media) { if (!media?.id || pendingMedia.value.some((row) => row.id === media.id)) return; pendingMedia.value.push({ ...media }); }
function detachCover() { rememberMedia(form.coverMedia || { id: form.coverMediaId, originalName: `媒体 ${form.coverMediaId}` }); form.coverMediaId = null; form.coverMedia = null; }
function detachAttachment(mediaId) { const item = form.attachments.find((row) => row.mediaId === mediaId); if (!item) return; rememberMedia(item.media || { id: mediaId, originalName: `媒体 ${mediaId}` }); form.attachments = form.attachments.filter((row) => row.mediaId !== mediaId); }
function mediaError(failure) { error.value = failure?.message || "媒体上传失败"; }
function normalizeBody(bodyHtml) {
  form.bodyHtml = bodyHtml;
  try { const saved = JSON.parse(baseline.value); saved.bodyHtml = bodyHtml; baseline.value = JSON.stringify(saved); } catch { /* blank baseline is always valid JSON */ }
}

async function deletePendingMedia(mediaId) {
  if (deletingMedia.value.has(mediaId)) return;
  deletingMedia.value = new Set([...deletingMedia.value, mediaId]); error.value = "";
  try { await api(`/api/admin/site-media/${mediaId}`, { method: "DELETE" }); pendingMedia.value = pendingMedia.value.filter((row) => row.id !== mediaId); success.value = "媒体文件已删除"; }
  catch (failure) { error.value = failure?.status === 409 ? "媒体仍被内容引用，请先解除引用并保存" : (failure?.message || "媒体删除失败"); }
  finally { const next = new Set(deletingMedia.value); next.delete(mediaId); deletingMedia.value = next; }
}

function getSavedPreviewState() {
  const saved = persistedPreview.value;
  if (!saved) return { path: null, reason: "新建内容尚未保存，暂无已保存官网页面。" };
  if (saved.status === "draft") return { path: null, reason: "已保存内容仍是草稿，尚未公开。" };
  if (saved.status === "scheduled") return { path: null, reason: "已保存内容为定时发布，尚未公开。" };
  if (saved.status === "offline") return { path: null, reason: "已保存内容已下线，官网不可访问。" };
  if (saved.status !== "published") return { path: null, reason: "已保存内容当前未公开，官网不可访问。" };

  const publishAt = Date.parse(saved.publishAt);
  if (!Number.isFinite(publishAt) || publishAt > Date.now()) {
    return { path: null, reason: "已保存内容尚未到发布时间，官网不可访问。" };
  }
  if (!saved.slug) return { path: null, reason: "已保存内容没有公开地址，官网不可访问。" };
  return { path: `/content/${encodeURIComponent(saved.slug)}`, reason: "" };
}

defineExpose({
  requestLeave,
  load,
  isDirty: () => dirty.value,
  getPreviewState: () => ({ loading: loading.value, failed: loadFailed.value, ready: !loading.value && !loadFailed.value }),
  getPreviewDraft: () => ({ kind: "content", body: contentPayload({ forPreview: true }), context: { contentId: form.id } }),
  getSavedPreviewState,
  getSavedPreviewPath: () => getSavedPreviewState().path
});
</script>

<template>
  <section class="panel content-editor-panel" data-content-editor>
    <div class="panel-title"><div><h3 ref="editorHeading" tabindex="-1" data-content-editor-heading>{{ form.id ? "编辑内容" : "新建内容" }}</h3><p v-if="form.id">状态：<strong>{{ statusLabel }}</strong> · 版本 {{ form.version }}</p><p v-else>新内容默认保存为草稿。</p></div><button v-if="form.id" type="button" data-action="refresh-content" :disabled="busy" @click="load">刷新</button></div>
    <p v-if="loading" role="status">正在加载内容…</p>
    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="success" class="success-message" role="status">{{ success }}</p>
    <form v-if="!loading && !loadFailed && !reviewing" class="content-editor-form" @submit.prevent="save">
      <section data-content-section="basics"><h4>基本信息</h4>
      <div class="site-form-grid"><label>标题<input v-model="form.title" data-content-field="title" :disabled="published"></label><label>公开地址 slug<input v-model="form.slug" data-content-field="slug" :disabled="published" autocomplete="off"></label></div>
      <div class="site-form-grid"><label>归属赛事<select v-model="form.eventId" data-content-field="eventId" :disabled="published"><option :value="null">平台通用</option><option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label><label>内容类型<select v-model="form.type" data-content-field="type" :disabled="published"><option v-for="type in types" :key="type[0]" :value="type[0]">{{ type[1] }}</option></select></label></div>
      <label>摘要<textarea v-model="form.summary" data-content-field="summary" :disabled="published"></textarea></label>
      </section>
      <section data-content-section="body-media"><h4>正文与媒体</h4>
      <label>正文<RichTextEditor :model-value="form.bodyHtml" :revision="`${form.id || 'new'}:${form.version ?? 0}`" :disabled="published" @update:model-value="form.bodyHtml = $event" @normalized="normalizeBody" /></label>
      <section class="content-media-field"><h4>封面图片</h4><p v-if="form.coverMedia"><strong>{{ form.coverMedia.originalName }}</strong> · {{ form.coverMedia.mimeType }} · {{ form.coverMedia.sizeBytes }} 字节<span v-if="form.coverMedia.width"> · {{ form.coverMedia.width }}×{{ form.coverMedia.height }}</span></p><p v-else-if="form.coverMediaId">媒体 ID：{{ form.coverMediaId }}</p><p v-else>未设置</p><div class="form-actions"><MediaPicker purpose="content-cover" accept="image/png,image/jpeg,image/webp" label="上传封面" :disabled="published" @uploaded="uploadedCover" @error="mediaError"/><button v-if="form.coverMediaId" type="button" data-action="detach-cover-media" :disabled="published" @click="detachCover">解除引用</button></div></section>
      <section class="content-media-field"><div class="panel-title"><h4>附件</h4><MediaPicker purpose="content-attachment" accept="application/pdf,image/png,image/jpeg,image/webp" label="上传附件" :disabled="published" @uploaded="uploadedAttachment" @error="mediaError"/></div><p v-if="!form.attachments.length">暂无附件</p><article v-for="(attachment,index) in form.attachments" :key="attachment.mediaId" class="content-attachment" :data-attachment="attachment.mediaId"><div><strong>{{ attachment.media?.originalName || attachment.mediaId }}</strong><span>{{ attachment.media?.mimeType }} · {{ attachment.media?.sizeBytes }} 字节<span v-if="attachment.media?.width"> · {{ attachment.media.width }}×{{ attachment.media.height }}</span></span></div><input v-model="attachment.label" data-attachment-label aria-label="附件标签" :disabled="published"><div class="form-actions"><button type="button" data-action="move-attachment-up" :disabled="published || index === 0" @click="moveAttachment(attachment.mediaId,-1)">上移</button><button type="button" :disabled="published || index === form.attachments.length - 1" @click="moveAttachment(attachment.mediaId,1)">下移</button><button type="button" data-action="detach-attachment-media" :disabled="published" @click="detachAttachment(attachment.mediaId)">解除引用</button></div></article></section>
      <section v-if="pendingMedia.length" class="content-media-field pending-media"><h4>待清理媒体</h4><p>解除引用并保存后，可在这里物理删除文件。</p><article v-for="media in pendingMedia" :key="media.id" :data-pending-media="media.id"><span>{{ media.originalName || media.id }}</span><button type="button" class="reject" data-action="delete-pending-media" :disabled="deletingMedia.has(media.id)" @click="deletePendingMedia(media.id)">{{ deletingMedia.has(media.id) ? '删除中…' : '删除媒体文件' }}</button></article></section>
      </section>
      <section data-content-section="display"><h4>展示设置</h4>
      <div class="site-form-grid"><label>状态<select v-model="form.status" data-content-field="status" :disabled="published"><option value="draft">草稿</option><option v-if="form.id" value="scheduled">定时发布</option><option v-if="form.status === 'offline'" value="offline">已下线</option><option v-if="published" value="published">已发布</option></select></label><label v-if="form.status === 'scheduled'">发布时间<input v-model="form.publishAt" data-content-field="publishAt" type="datetime-local" :disabled="published"></label><label>排序<input v-model.number="form.sortOrder" data-content-field="sortOrder" type="number" :disabled="published"></label><label class="site-checkbox"><input v-model="form.pinned" data-content-field="pinned" type="checkbox" :disabled="published">置顶显示</label></div>
      <p v-if="!form.id" class="hint">新内容先保存草稿后才能设置定时发布。</p>
      <p v-if="form.status === 'offline'" class="hint">下线内容如需编辑，请选择草稿或定时发布后再保存；也可以直接删除。</p>
      </section>
      <div class="form-actions content-editor-actions"><button type="button" class="primary" data-action="save-content" :disabled="busy || published || form.status === 'offline'" @click="save">保存草稿</button><button type="button" data-action="save-and-preview-content" :disabled="busy || published || form.status === 'offline'" @click="saveAndPreview">保存并预览</button><button v-if="!published" type="button" class="dark" data-action="save-and-review-content" :disabled="busy || form.status === 'offline'" @click="saveAndReview">进入发布检查</button><button type="button" data-action="preview-content" :disabled="busy" @click="preview">预览</button><button v-if="published" type="button" class="dark" data-action="offline-content" :disabled="busy" @click="ask('offline')">下线</button><button type="button" class="reject" data-action="delete-content" :disabled="busy || !form.id || !['draft','offline'].includes(form.status)" @click="ask('delete')">删除</button></div>
    </form>
    <ContentPublicationReview v-else-if="!loading && !loadFailed" :content="{ ...form }" :event="selectedEvent" :profile="selectedProfile" :busy="busy" @back="reviewing = false" @preview="preview" @publish="ask('publish')" @navigate="emit('navigate', $event)" />
    <div v-if="confirmAction" class="dialog-backdrop" @click.self="cancelConfirm"><section class="panel content-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="content-confirm-title"><h3 id="content-confirm-title">{{ confirmAction === 'publish' ? '确认发布' : confirmAction === 'offline' ? '确认下线' : confirmAction === 'delete' ? '确认删除' : '放弃未保存修改' }}</h3><p>{{ confirmAction === 'publish' ? '发布后内容将对公众可见。' : confirmAction === 'offline' ? '下线后公众将无法访问该内容。' : confirmAction === 'delete' ? '删除后不可恢复。' : '当前修改尚未保存，确定放弃吗？' }}</p><div class="form-actions"><button ref="confirmButton" type="button" class="dark" :data-action="confirmAction === 'discard' ? 'confirm-discard-content' : 'confirm-content-action'" :disabled="busy" @click="confirm">确认</button><button type="button" :disabled="busy" @click="cancelConfirm">取消</button></div></section></div>
    <ContentPreviewDialog :open="previewOpen" :title="form.title || '内容预览'" :html="previewHtml" @close="previewOpen = false" />
  </section>
</template>
