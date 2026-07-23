<script setup>
import { computed, reactive, ref, watch } from "vue";

import { api } from "../lib/api.js";

const props = defineProps({
  settings: { type: Object, required: true },
  events: { type: Array, default: () => [] },
  profiles: { type: Array, default: () => [] }
});

const emit = defineEmits(["saved"]);
const saving = ref(false);
const uploading = ref("");
const error = ref("");
const success = ref("");
const form = reactive({});

const configurableEvents = computed(() => props.events.filter((event) => (
  event.status === "published"
  && !event.archivedAt
  && props.profiles.some((profile) => profile.eventId === event.id && profile.isVisible)
)));

function applySettings(settings) {
  Object.assign(form, {
    platformName: settings.platformName || "",
    platformIntro: settings.platformIntro || "",
    organizersText: (settings.organizers || []).join("\n"),
    contact: settings.contact || "",
    icp: settings.icp || "",
    seoTitle: settings.seoTitle || "",
    seoDescription: settings.seoDescription || "",
    featuredEventId: settings.featuredEventId || "",
    defaultHeroMediaId: settings.defaultHeroMediaId || null,
    shareMediaId: settings.shareMediaId || null,
    version: settings.version
  });
}

watch(() => props.settings, applySettings, { immediate: true });

function payload() {
  return {
    version: form.version,
    featuredEventId: form.featuredEventId || null,
    platformIntro: form.platformIntro,
    organizers: form.organizersText.split(/\r?\n/).map((row) => row.trim()).filter(Boolean),
    contact: form.contact,
    icp: form.icp,
    seoTitle: form.seoTitle,
    seoDescription: form.seoDescription,
    defaultHeroMediaId: form.defaultHeroMediaId || null,
    shareMediaId: form.shareMediaId || null
  };
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  success.value = "";
  try {
    const response = await api("/api/admin/site-settings", { method: "PATCH", body: JSON.stringify(payload()) });
    applySettings(response.row);
    success.value = "首页设置已保存";
    emit("saved", response.row);
  } catch (failure) {
    error.value = failure?.status === 409
      ? "配置已被其他管理员更新，请刷新后重试"
      : failure?.message || "首页设置保存失败";
  } finally {
    saving.value = false;
  }
}

async function upload(event, field, purpose) {
  const file = event.target.files?.[0];
  if (!file || uploading.value) return;
  uploading.value = field;
  error.value = "";
  success.value = "";
  try {
    const body = new FormData();
    body.append("file", file);
    body.append("purpose", purpose);
    const response = await api("/api/admin/site-media", { method: "POST", body });
    form[field] = response.row.id;
    success.value = "图片已上传，请保存设置以生效";
  } catch (failure) {
    error.value = failure?.message || "图片上传失败";
  } finally {
    uploading.value = "";
    event.target.value = "";
  }
}

defineExpose({
  getPreviewDraft: () => ({ kind: "homepage", body: payload(), context: {} }),
  getSavedPreviewState: () => ({ path: "/", reason: "" }),
  getSavedPreviewPath: () => "/"
});
</script>

<template>
  <form class="panel site-settings-form" @submit.prevent="save">
    <div class="panel-title"><div><h3>首页设置</h3><p>维护平台公共信息、首页重点赛事与默认图片。</p></div><span>版本 {{ form.version }}</span></div>
    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="success" class="message success-message" role="status">{{ success }}</p>
    <div class="site-form-grid">
      <label>平台名称<input v-model="form.platformName" data-field="platformName" readonly /></label>
      <label>首页重点赛事
        <select v-model="form.featuredEventId" data-field="featuredEventId">
          <option value="">自动选择</option>
          <option v-for="event in configurableEvents" :key="event.id" :value="event.id">{{ event.name }}</option>
        </select>
      </label>
    </div>
    <label>平台简介<textarea v-model="form.platformIntro" data-field="platformIntro" /></label>
    <label>主办单位（每行一个）<textarea v-model="form.organizersText" data-field="organizers" /></label>
    <div class="site-form-grid">
      <label>联系方式<input v-model="form.contact" data-field="contact" /></label>
      <label>备案号<input v-model="form.icp" data-field="icp" /></label>
      <label>SEO 标题<input v-model="form.seoTitle" data-field="seoTitle" /></label>
      <label>SEO 摘要<textarea v-model="form.seoDescription" data-field="seoDescription" /></label>
    </div>
    <div class="site-media-grid">
      <section class="site-media-field">
        <strong>默认宣传图</strong><span>{{ form.defaultHeroMediaId || "未设置" }}</span>
        <div class="form-actions"><label class="file-action">选择图片<input type="file" accept="image/png,image/jpeg,image/webp" data-action="upload-default-hero" :disabled="Boolean(uploading)" @change="upload($event, 'defaultHeroMediaId', 'default-hero')" /></label><button v-if="form.defaultHeroMediaId" type="button" data-action="remove-default-hero" @click="form.defaultHeroMediaId = null">解除引用</button></div>
      </section>
      <section class="site-media-field">
        <strong>分享封面</strong><span>{{ form.shareMediaId || "未设置" }}</span>
        <div class="form-actions"><label class="file-action">选择图片<input type="file" accept="image/png,image/jpeg,image/webp" data-action="upload-share-image" :disabled="Boolean(uploading)" @change="upload($event, 'shareMediaId', 'share-image')" /></label><button v-if="form.shareMediaId" type="button" @click="form.shareMediaId = null">解除引用</button></div>
      </section>
    </div>
    <div class="form-actions"><button type="button" class="primary site-save-button" data-action="save-settings" :disabled="saving || Boolean(uploading)" @click="save">{{ saving ? "保存中…" : "保存首页设置" }}</button></div>
  </form>
</template>
