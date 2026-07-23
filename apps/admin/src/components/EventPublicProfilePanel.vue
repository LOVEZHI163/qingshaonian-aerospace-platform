<script setup>
import { computed, reactive, ref, watch } from "vue";

import { api } from "../lib/api.js";

const props = defineProps({
  events: { type: Array, default: () => [] },
  profiles: { type: Array, default: () => [] }
});
const emit = defineEmits(["saved"]);

const selectedId = ref("");
const form = reactive({});
const baseline = ref("");
const error = ref("");
const success = ref("");
const saving = ref(false);
const uploading = ref(false);

const selectedEvent = computed(() => props.events.find((event) => event.id === selectedId.value) || null);
const dirty = computed(() => Boolean(selectedId.value) && JSON.stringify(form) !== baseline.value);

function fallbackSlug(event) {
  const base = String(event?.id || "event").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return base || "event";
}

function profileFor(eventId) {
  return props.profiles.find((profile) => profile.eventId === eventId) || null;
}

function openEvent(eventId) {
  const event = props.events.find((row) => row.id === eventId);
  if (!event) return;
  selectedId.value = eventId;
  const profile = profileFor(eventId);
  Object.assign(form, {
    slug: profile?.slug || fallbackSlug(event),
    slogan: profile?.slogan || "",
    summary: profile?.summary || "",
    isVisible: profile?.isVisible === true,
    displayOrder: profile?.displayOrder ?? 0,
    heroMediaId: profile?.heroMediaId || null,
    version: profile?.version
  });
  baseline.value = JSON.stringify(form);
  error.value = "";
  success.value = "";
}

function selectEvent(eventId) {
  if (eventId === selectedId.value) return;
  if (dirty.value) {
    error.value = "请先保存或放弃当前修改，再切换赛事";
    return;
  }
  openEvent(eventId);
}

function requestBody() {
  return {
    ...(Number.isInteger(form.version) ? { version: form.version } : {}),
    slug: form.slug.trim(),
    slogan: form.slogan,
    summary: form.summary,
    isVisible: form.isVisible,
    displayOrder: Number(form.displayOrder),
    heroMediaId: form.heroMediaId || null
  };
}

async function save() {
  if (!selectedId.value || saving.value) return false;
  saving.value = true;
  error.value = "";
  success.value = "";
  try {
    const response = await api(`/api/admin/event-public-profiles/${encodeURIComponent(selectedId.value)}`, {
      method: "PUT",
      body: JSON.stringify(requestBody())
    });
    Object.assign(form, {
      slug: response.row.slug,
      slogan: response.row.slogan || "",
      summary: response.row.summary || "",
      isVisible: response.row.isVisible === true,
      displayOrder: response.row.displayOrder ?? 0,
      heroMediaId: response.row.heroMediaId || null,
      version: response.row.version
    });
    baseline.value = JSON.stringify(form);
    success.value = "赛事视觉设置已保存";
    emit("saved", response.row);
    return true;
  } catch (failure) {
    error.value = failure?.message || "赛事视觉设置保存失败";
    return false;
  } finally {
    saving.value = false;
  }
}

async function uploadCover(event) {
  const file = event.target.files?.[0];
  if (!file || uploading.value || !selectedId.value) return;
  uploading.value = true;
  error.value = "";
  success.value = "";
  try {
    const body = new FormData();
    body.append("file", file);
    body.append("purpose", "event-hero");
    body.append("eventId", selectedId.value);
    const response = await api("/api/admin/site-media", { method: "POST", body });
    form.heroMediaId = response.row.id;
    await save();
  } catch (failure) {
    error.value = failure?.message || "赛事封面上传失败";
  } finally {
    uploading.value = false;
    event.target.value = "";
  }
}

function getSavedPreviewState() {
  const event = selectedEvent.value;
  if (!event) return { path: null, reason: "请先选择赛事后再预览已保存官网。" };
  const profile = profileFor(event.id);
  if (!profile) return { path: null, reason: "该赛事尚未保存官网视觉配置，暂无已保存官网页面。" };
  if (profile.isVisible !== true) {
    return { path: null, reason: "已保存赛事未在官网公开，官网不可访问。" };
  }
  if (!["published", "archived"].includes(event.status)) {
    return { path: null, reason: "赛事尚未发布，官网不可访问。" };
  }
  if (!profile.slug) return { path: null, reason: "已保存赛事没有公开地址，官网不可访问。" };
  return { path: `/events/${encodeURIComponent(profile.slug)}`, reason: "" };
}

watch(() => props.events, (rows) => {
  if (!selectedId.value && rows.length) openEvent(rows[0].id);
}, { immediate: true });

defineExpose({
  getPreviewDraft: () => selectedId.value ? {
    kind: "event",
    body: { eventId: selectedId.value, ...requestBody() },
    context: { eventId: selectedId.value }
  } : null,
  getSavedPreviewState,
  getSavedPreviewPath: () => getSavedPreviewState().path
});
</script>

<template>
  <div class="event-profile-layout">
    <section class="panel event-profile-list">
      <h3>赛事列表</h3>
      <p v-if="events.length === 0" class="hint">暂无赛事可配置。</p>
      <button v-for="event in events" :key="event.id" type="button" :class="{ selected: event.id === selectedId }" :data-event-select="event.id" @click="selectEvent(event.id)">
        <strong>{{ event.name }}</strong><span>{{ event.status }}</span>
      </button>
    </section>

    <form v-if="selectedEvent" class="panel event-profile-form" :data-event-editor="selectedId" @submit.prevent="save">
      <div class="panel-title"><div><h3>赛事视觉设置</h3><p>业务赛事信息只读，此处仅维护官网展示。</p></div><span>{{ Number.isInteger(form.version) ? `版本 ${form.version}` : "尚未建立" }}</span></div>
      <p v-if="error" class="message" role="alert">{{ error }}</p>
      <p v-if="success" class="message success-message" role="status">{{ success }}</p>
      <dl class="event-facts" :data-event-facts="selectedId"><div><dt>赛事名称</dt><dd>{{ selectedEvent.name }}</dd></div><div><dt>比赛日期</dt><dd>{{ selectedEvent.dateLabel || "未填写" }}</dd></div><div><dt>比赛地点</dt><dd>{{ selectedEvent.venue || "未填写" }}</dd></div><div><dt>赛事状态</dt><dd>{{ selectedEvent.status }}</dd></div></dl>
      <div class="site-form-grid">
        <label>公开地址 slug<input v-model="form.slug" data-profile-field="slug" autocomplete="off" /></label>
        <label>显示顺序<input v-model.number="form.displayOrder" data-profile-field="displayOrder" type="number" /></label>
      </div>
      <label class="site-checkbox"><input v-model="form.isVisible" data-profile-field="isVisible" type="checkbox" />在官网公开此赛事</label>
      <label>宣传语<input v-model="form.slogan" data-profile-field="slogan" /></label>
      <label>赛事摘要<textarea v-model="form.summary" data-profile-field="summary" /></label>
      <section class="site-media-field">
        <strong>赛事封面</strong><span data-profile-media-id>{{ form.heroMediaId || "未设置" }}</span>
        <div class="form-actions"><label class="file-action">选择图片<input type="file" accept="image/png,image/jpeg,image/webp" data-action="upload-profile-cover" :disabled="uploading || saving" @change="uploadCover" /></label><button v-if="form.heroMediaId" type="button" @click="form.heroMediaId = null">解除引用</button></div>
      </section>
      <div class="form-actions"><button type="button" class="primary site-save-button" data-action="save-profile" :disabled="saving || uploading" @click="save">{{ saving ? "保存中…" : "保存赛事视觉" }}</button><button v-if="dirty" type="button" @click="openEvent(selectedId)">放弃修改</button></div>
    </form>
    <p v-else class="panel empty-state">请先在赛事设置中创建赛事。</p>
  </div>
</template>
