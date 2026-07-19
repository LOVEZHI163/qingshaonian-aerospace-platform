<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { api } from "../lib/api.js";
import ContentPreviewDialog from "./ContentPreviewDialog.vue";
import MediaPicker from "./MediaPicker.vue";
import RichTextEditor from "./RichTextEditor.vue";

const props = defineProps({ contentId: { type: String, default: null }, events: { type: Array, default: () => [] } });
const emit = defineEmits(["saved", "deleted"]);
const types = [["announcement","公告"],["news","新闻"],["work","作品"],["recap","回顾"],["guide","指南"]];
const states = { draft: "草稿", scheduled: "定时发布", published: "已发布", offline: "已下线" };
const blank = () => ({ id: null, slug: "", eventId: null, type: "news", title: "", summary: "", bodyHtml: "", status: "draft", publishAt: null, pinned: false, sortOrder: 0, coverMediaId: null, coverMedia: null, attachments: [], version: null });
const form = reactive(blank());
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const success = ref("");
const previewOpen = ref(false);
const previewHtml = ref("");
const confirmAction = ref(null);
const confirmButton = ref(null);
const baseline = ref(JSON.stringify(blank()));
let leaveCallback = null;
let confirmReturnFocus = null;

const published = computed(() => form.status === "published");
const dirty = computed(() => JSON.stringify(snapshot()) !== baseline.value);
const statusLabel = computed(() => states[form.status] || form.status);

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

function applyRow(row) {
  Object.assign(form, blank(), row, {
    eventId: row.eventId || null,
    publishAt: localDateTime(row.publishAt),
    attachments: (row.attachments || []).map((item) => ({ ...item, label: item.label || "" }))
  });
  baseline.value = JSON.stringify(snapshot());
}

async function load() {
  error.value = ""; success.value = "";
  if (!props.contentId) { applyRow(blank()); return; }
  loading.value = true;
  try { applyRow((await api(`/api/admin/content/${props.contentId}`)).row); }
  catch (failure) { error.value = failure?.message || "内容加载失败"; }
  finally { loading.value = false; }
}

watch(() => props.contentId, load, { immediate: true });
watch(confirmAction, async (action, previous) => {
  if (action && !previous) {
    confirmReturnFocus = document.activeElement;
    document.addEventListener("keydown", handleConfirmKey);
    await nextTick(); confirmButton.value?.focus();
  } else if (!action && previous) {
    document.removeEventListener("keydown", handleConfirmKey);
    confirmReturnFocus?.focus?.(); confirmReturnFocus = null;
  }
});
function handleConfirmKey(event) { if (event.key === "Escape") cancelConfirm(); }
onBeforeUnmount(() => document.removeEventListener("keydown", handleConfirmKey));

function requestLeave(callback) {
  if (!dirty.value) { callback(); return; }
  leaveCallback = callback;
  confirmAction.value = "discard";
}

function contentPayload() {
  const data = snapshot();
  if (data.status === "draft") data.publishAt = null;
  else if (data.status === "scheduled") {
    const date = new Date(form.publishAt || "");
    if (Number.isNaN(date.getTime()) || date <= new Date()) throw new Error("请选择未来的发布时间");
    data.publishAt = date.toISOString();
  }
  if (form.id) data.version = form.version;
  return data;
}

async function save() {
  if (busy.value || published.value) return;
  error.value = ""; success.value = "";
  let body;
  try { body = contentPayload(); }
  catch (failure) { error.value = failure.message; return; }
  busy.value = true;
  try {
    const path = form.id ? `/api/admin/content/${form.id}` : "/api/admin/content";
    const payload = await api(path, { method: form.id ? "PATCH" : "POST", body: JSON.stringify(body) });
    applyRow(payload.row); success.value = "内容已保存"; emit("saved", payload.row);
  } catch (failure) {
    error.value = failure?.status === 409 ? "内容已被其他管理员更新，请刷新后重试" : (failure?.message || "内容保存失败");
  } finally { busy.value = false; }
}

async function preview() {
  if (!form.id) { error.value = "请先保存内容再预览"; return; }
  try {
    const row = (await api(`/api/admin/content/${form.id}`)).row;
    previewHtml.value = row.previewHtml || "";
    previewOpen.value = true;
  } catch (failure) { error.value = failure?.message || "预览加载失败"; }
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
      applyRow(payload.row); success.value = action === "publish" ? "内容已发布" : "内容已下线"; emit("saved", payload.row);
    }
    confirmAction.value = null;
  } catch (failure) { error.value = failure?.status === 409 ? "内容已被其他管理员更新，请刷新后重试" : (failure?.message || "操作失败"); }
  finally { busy.value = false; }
}

function uploadedCover(media) { form.coverMediaId = media.id; form.coverMedia = media; }
function uploadedAttachment(media) { form.attachments.push({ mediaId: media.id, label: media.originalName || "", displayOrder: form.attachments.length, media }); }
function moveAttachment(index, delta) { const target = index + delta; if (target < 0 || target >= form.attachments.length) return; [form.attachments[index], form.attachments[target]] = [form.attachments[target], form.attachments[index]]; }
function removeAttachment(index) { form.attachments.splice(index, 1); }
function mediaError(failure) { error.value = failure?.message || "媒体上传失败"; }

async function deleteMedia(mediaId, clear) {
  try { await api(`/api/admin/site-media/${mediaId}`, { method: "DELETE" }); clear(); success.value = "媒体文件已删除"; }
  catch (failure) { error.value = failure?.status === 409 ? "媒体仍被内容引用，请先解除引用并保存" : (failure?.message || "媒体删除失败"); }
}

defineExpose({ requestLeave, load, isDirty: () => dirty.value });
</script>

<template>
  <section class="panel content-editor-panel" data-content-editor>
    <div class="panel-title"><div><h3>{{ form.id ? "编辑内容" : "新建内容" }}</h3><p v-if="form.id">状态：<strong>{{ statusLabel }}</strong> · 版本 {{ form.version }}</p><p v-else>新内容默认保存为草稿。</p></div><button v-if="form.id" type="button" data-action="refresh-content" :disabled="busy" @click="load">刷新</button></div>
    <p v-if="loading" role="status">正在加载内容…</p>
    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="success" class="success-message" role="status">{{ success }}</p>
    <form v-if="!loading" class="content-editor-form" @submit.prevent="save">
      <div class="site-form-grid"><label>标题<input v-model="form.title" data-content-field="title" :disabled="published"></label><label>公开地址 slug<input v-model="form.slug" data-content-field="slug" :disabled="published" autocomplete="off"></label></div>
      <div class="site-form-grid"><label>归属赛事<select v-model="form.eventId" data-content-field="eventId" :disabled="published"><option :value="null">平台通用</option><option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label><label>内容类型<select v-model="form.type" data-content-field="type" :disabled="published"><option v-for="type in types" :key="type[0]" :value="type[0]">{{ type[1] }}</option></select></label></div>
      <label>摘要<textarea v-model="form.summary" data-content-field="summary" :disabled="published"></textarea></label>
      <label>正文<RichTextEditor v-model="form.bodyHtml" :disabled="published" /></label>
      <div class="site-form-grid"><label>状态<select v-model="form.status" data-content-field="status" :disabled="published"><option value="draft">草稿</option><option value="scheduled">定时发布</option><option v-if="form.status === 'offline'" value="offline">已下线</option><option v-if="published" value="published">已发布</option></select></label><label v-if="form.status === 'scheduled'">发布时间<input v-model="form.publishAt" data-content-field="publishAt" type="datetime-local" :disabled="published"></label><label>排序<input v-model.number="form.sortOrder" data-content-field="sortOrder" type="number" :disabled="published"></label><label class="site-checkbox"><input v-model="form.pinned" data-content-field="pinned" type="checkbox" :disabled="published">置顶显示</label></div>
      <p v-if="form.status === 'offline'" class="hint">下线内容如需编辑，请选择草稿或定时发布后再保存；也可以直接删除。</p>
      <section class="content-media-field"><h4>封面图片</h4><p v-if="form.coverMedia"><strong>{{ form.coverMedia.originalName }}</strong> · {{ form.coverMedia.mimeType }} · {{ form.coverMedia.sizeBytes }} 字节<span v-if="form.coverMedia.width"> · {{ form.coverMedia.width }}×{{ form.coverMedia.height }}</span></p><p v-else-if="form.coverMediaId">媒体 ID：{{ form.coverMediaId }}</p><p v-else>未设置</p><div class="form-actions"><MediaPicker purpose="content-cover" accept="image/png,image/jpeg,image/webp" label="上传封面" :disabled="published" @uploaded="uploadedCover" @error="mediaError"/><button v-if="form.coverMediaId" type="button" :disabled="published" @click="form.coverMediaId = null; form.coverMedia = null">解除引用</button><button v-if="form.coverMedia?.id" type="button" class="reject" :disabled="published" @click="deleteMedia(form.coverMedia.id, () => { form.coverMediaId = null; form.coverMedia = null; })">删除媒体文件</button></div></section>
      <section class="content-media-field"><div class="panel-title"><h4>附件</h4><MediaPicker purpose="content-attachment" accept="application/pdf,image/png,image/jpeg,image/webp" label="上传附件" :disabled="published" @uploaded="uploadedAttachment" @error="mediaError"/></div><p v-if="!form.attachments.length">暂无附件</p><article v-for="(attachment,index) in form.attachments" :key="attachment.mediaId" class="content-attachment" :data-attachment="attachment.mediaId"><div><strong>{{ attachment.media?.originalName || attachment.mediaId }}</strong><span>{{ attachment.media?.mimeType }} · {{ attachment.media?.sizeBytes }} 字节<span v-if="attachment.media?.width"> · {{ attachment.media.width }}×{{ attachment.media.height }}</span></span></div><input v-model="attachment.label" data-attachment-label aria-label="附件标签" :disabled="published"><div class="form-actions"><button type="button" data-action="move-attachment-up" :disabled="published || index === 0" @click="moveAttachment(index,-1)">上移</button><button type="button" :disabled="published || index === form.attachments.length - 1" @click="moveAttachment(index,1)">下移</button><button type="button" :disabled="published" @click="removeAttachment(index)">解除引用</button><button type="button" class="reject" data-action="delete-attachment-media" :disabled="published" @click="deleteMedia(attachment.mediaId, () => removeAttachment(index))">删除媒体文件</button></div></article></section>
      <div class="form-actions content-editor-actions"><button type="button" class="primary" data-action="save-content" :disabled="busy || published || form.status === 'offline'" @click="save">保存</button><button type="button" data-action="preview-content" :disabled="busy || !form.id || dirty" @click="preview">预览</button><button v-if="form.id && !published" type="button" class="dark" data-action="publish-content" :disabled="busy || dirty" @click="ask('publish')">发布</button><button v-if="published" type="button" class="dark" data-action="offline-content" :disabled="busy" @click="ask('offline')">下线</button><button type="button" class="reject" data-action="delete-content" :disabled="busy || !form.id || !['draft','offline'].includes(form.status)" @click="ask('delete')">删除</button></div>
    </form>
    <div v-if="confirmAction" class="dialog-backdrop" @click.self="cancelConfirm"><section class="panel content-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="content-confirm-title"><h3 id="content-confirm-title">{{ confirmAction === 'publish' ? '确认发布' : confirmAction === 'offline' ? '确认下线' : confirmAction === 'delete' ? '确认删除' : '放弃未保存修改' }}</h3><p>{{ confirmAction === 'publish' ? '发布后内容将对公众可见。' : confirmAction === 'offline' ? '下线后公众将无法访问该内容。' : confirmAction === 'delete' ? '删除后不可恢复。' : '当前修改尚未保存，确定放弃吗？' }}</p><div class="form-actions"><button ref="confirmButton" type="button" class="dark" :data-action="confirmAction === 'discard' ? 'confirm-discard-content' : 'confirm-content-action'" :disabled="busy" @click="confirm">确认</button><button type="button" :disabled="busy" @click="cancelConfirm">取消</button></div></section></div>
    <ContentPreviewDialog :open="previewOpen" :title="form.title || '内容预览'" :html="previewHtml" @close="previewOpen = false" />
  </section>
</template>
