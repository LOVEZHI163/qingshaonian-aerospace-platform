<script setup>
import { computed, nextTick, onMounted, ref } from "vue";

import ContentEditorPanel from "../components/ContentEditorPanel.vue";
import ContentImportPanel from "../components/ContentImportPanel.vue";
import ContentListPanel from "../components/ContentListPanel.vue";
import EventPublicProfilePanel from "../components/EventPublicProfilePanel.vue";
import SiteSettingsPanel from "../components/SiteSettingsPanel.vue";
import { api } from "../lib/api.js";
import { createPreviewSnapshot } from "../lib/site-preview.js";

const props = defineProps({
  initialContentId: { type: String, default: "" }
});
const emit = defineEmits(["navigate", "content-id"]);

const tabs = [["homepage", "首页设置"], ["events", "赛事视觉"], ["content", "内容发布"]];
const activeTab = ref(props.initialContentId ? "content" : "homepage");
const tabButtons = ref([]);
const loading = ref(true);
const error = ref("");
const settings = ref(null);
const events = ref([]);
const profiles = ref([]);
const siteSettingsPanel = ref(null);
const eventPublicProfilePanel = ref(null);
const selectedContentId = ref(props.initialContentId || null);
const contentContext = ref(props.initialContentId ? "existing" : "none");
const contentEditor = ref(null);
const contentList = ref(null);
const contentImport = ref(null);
const previewError = ref("");
const blockedPreviewUrl = ref("");

const activePreviewPanel = computed(() => activeTab.value === "homepage"
  ? siteSettingsPanel.value
  : activeTab.value === "events"
    ? eventPublicProfilePanel.value
    : contentEditor.value);

const activePreviewDraft = computed(() => {
  if (activeTab.value === "content" && ["none", "import"].includes(contentContext.value)) return null;
  return activePreviewPanel.value?.getPreviewDraft?.() || null;
});
const savedPreviewState = computed(() => {
  if (activeTab.value === "content" && contentContext.value === "none") {
    return { path: null, reason: "请先选择已保存内容后再预览。" };
  }
  if (activeTab.value === "content" && contentContext.value === "import") {
    return { path: null, reason: "转载内容保存为草稿后才可预览。" };
  }
  if (activeTab.value === "content" && contentContext.value === "new") {
    return { path: null, reason: "新建内容尚未保存，暂无已保存官网页面。" };
  }
  return activePreviewPanel.value?.getSavedPreviewState?.()
    || { path: null, reason: "已保存官网页面暂不可用。" };
});
const savedPreviewPath = computed(() => savedPreviewState.value.path || null);
const savedPreviewHelp = computed(() => savedPreviewPath.value
  ? "已保存官网页面当前可公开访问。"
  : savedPreviewState.value.reason);
const activePreviewState = computed(() => activePreviewPanel.value?.getPreviewState?.() || {
  loading: false,
  failed: false,
  ready: Boolean(activePreviewDraft.value)
});
const previewHelp = computed(() => {
  if (activeTab.value === "events" && !activePreviewDraft.value) return "请先选择赛事后再预览。";
  if (activeTab.value === "content" && contentContext.value === "none") return "请先选择或新建内容后再预览。";
  if (activeTab.value === "content" && contentContext.value === "import") return "转载检查不会发布内容，保存为草稿后可继续预览。";
  if (activeTab.value === "content" && activePreviewState.value.loading) return "内容加载中，请稍候。";
  if (activeTab.value === "content" && activePreviewState.value.failed) return "内容加载失败，请重试。";
  if (activeTab.value === "content" && !activePreviewState.value.ready) return "内容暂不可预览，请重试。";
  return "草稿预览不会保存或发布当前修改。";
});
const canPreviewDraft = computed(() => Boolean(
  activePreviewDraft.value
  && (activeTab.value !== "content" || (contentContext.value !== "none" && activePreviewState.value.ready))
));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [settingsPayload, profilePayload, eventPayload] = await Promise.all([
      api("/api/admin/site-settings"),
      api("/api/admin/event-public-profiles"),
      api("/api/admin/events")
    ]);
    settings.value = settingsPayload.row;
    profiles.value = profilePayload.rows || [];
    events.value = eventPayload.rows || [];
  } catch (failure) {
    error.value = failure?.message || "官网配置加载失败";
  } finally {
    loading.value = false;
  }
}

function updateSettings(row) {
  settings.value = row;
}

function updateProfile(row) {
  const index = profiles.value.findIndex((profile) => profile.eventId === row.eventId);
  if (index >= 0) profiles.value.splice(index, 1, row);
  else profiles.value.push(row);
}

function chooseContent(id) {
  contentContext.value = "existing";
  selectedContentId.value = id;
  emit("content-id", id);
}

function newContent() {
  contentContext.value = "new";
  selectedContentId.value = null;
  emit("content-id", null);
}

function importContent() {
  contentContext.value = "import";
  selectedContentId.value = null;
  emit("content-id", null);
}

function backToContentList() {
  if (contentContext.value === "import" && contentImport.value) {
    contentImport.value.requestLeave(() => {
      contentContext.value = "none";
      selectedContentId.value = null;
      emit("content-id", null);
      contentList.value?.load();
    });
    return;
  }
  contentEditor.value?.requestLeave(() => {
    contentContext.value = "none";
    selectedContentId.value = null;
    emit("content-id", null);
    contentList.value?.load();
  });
}

function importCancelled() {
  contentContext.value = "none";
  selectedContentId.value = null;
  emit("content-id", null);
  contentList.value?.load();
}

function contentImported(id) {
  contentContext.value = "existing";
  selectedContentId.value = id;
  emit("content-id", id);
  contentList.value?.load();
}

function contentSaved(row) {
  contentContext.value = "existing";
  selectedContentId.value = row.id;
  emit("content-id", row.id);
  contentList.value?.load();
}

function contentDeleted() {
  contentContext.value = "none";
  selectedContentId.value = null;
  emit("content-id", null);
  contentList.value?.load();
}

function contentMissing() {
  contentContext.value = "none";
  selectedContentId.value = null;
  emit("content-id", null);
}

function requestLeave(callback) {
  if (activeTab.value === "content" && contentContext.value === "import" && contentImport.value) {
    contentImport.value.requestLeave(callback);
    return;
  }
  if (activeTab.value === "content" && contentContext.value !== "import" && contentEditor.value) {
    contentEditor.value.requestLeave(callback);
    return;
  }
  callback();
}

async function finishTabActivation(normalized, focus) {
  activeTab.value = tabs[normalized][0];
  previewError.value = "";
  blockedPreviewUrl.value = "";
  if (focus) {
    await nextTick();
    tabButtons.value[normalized]?.focus();
  }
}

function activateTab(index, { focus = false } = {}) {
  const normalized = (index + tabs.length) % tabs.length;
  if (tabs[normalized][0] === activeTab.value) {
    if (focus) void finishTabActivation(normalized, true);
    return;
  }
  if (activeTab.value === "content" && contentContext.value === "import" && contentImport.value) {
    contentImport.value.requestLeave(() => finishTabActivation(normalized, focus));
    return;
  }
  if (activeTab.value === "content" && contentEditor.value) {
    contentEditor.value.requestLeave(async () => {
      await contentEditor.value?.load?.();
      await finishTabActivation(normalized, focus);
    });
    return;
  }
  void finishTabActivation(normalized, focus);
}

function refreshSiteContent() {
  requestLeave(async () => {
    await load();
    if (activeTab.value === "content" && contentEditor.value) await contentEditor.value.load();
  });
}

function openPreviewWindow() {
  const popup = window.open("about:blank", "_blank");
  if (popup) popup.opener = null;
  return popup;
}

function previewSaved() {
  previewError.value = "";
  blockedPreviewUrl.value = "";
  const path = savedPreviewPath.value;
  if (!path) return;
  const popup = openPreviewWindow();
  if (popup) popup.location.href = path;
  else blockedPreviewUrl.value = path;
}

async function previewDraft() {
  previewError.value = "";
  blockedPreviewUrl.value = "";
  const draft = activePreviewDraft.value;
  if (!draft || !canPreviewDraft.value) return;

  const popup = openPreviewWindow();
  try {
    const response = await api(`/api/admin/site-preview/${draft.kind}`, {
      method: "POST",
      body: JSON.stringify(draft.body)
    });
    const snapshot = createPreviewSnapshot({
      kind: draft.kind,
      payload: response.preview.payload,
      context: response.preview.context
    });
    if (popup) popup.location.href = snapshot.url;
    else blockedPreviewUrl.value = snapshot.url;
  } catch (failure) {
    popup?.close?.();
    previewError.value = failure?.message || "草稿预览生成失败";
  }
}

function handleTabKey(event, index) {
  const targetIndex = event.key === "ArrowRight"
    ? index + 1
    : event.key === "ArrowLeft"
      ? index - 1
      : event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : null;
  if (targetIndex === null) return;
  event.preventDefault();
  activateTab(targetIndex, { focus: true });
}

onMounted(load);
defineExpose({ requestLeave });
</script>

<template>
  <section class="site-content-page" data-testid="site-content-page">
    <div class="page-title-row">
      <div><h2>官网内容</h2><p>统一维护首页信息、赛事视觉与公开内容。</p></div>
      <div class="site-preview-actions">
        <button type="button" class="dark" data-action="refresh-site-content" :disabled="loading" @click="refreshSiteContent">刷新</button>
        <button type="button" data-action="preview-saved-site" :disabled="loading || !savedPreviewPath" :aria-describedby="!savedPreviewPath ? 'saved-preview-help' : undefined" @click="previewSaved">预览已保存官网</button>
        <button type="button" class="primary" data-action="preview-site-draft" :disabled="loading || !canPreviewDraft" @click="previewDraft">预览当前草稿</button>
      </div>
    </div>
    <div class="site-preview-status">
      <p id="saved-preview-help" class="site-preview-help" data-saved-preview-help>{{ savedPreviewHelp }}</p>
      <p class="site-preview-help" data-preview-help>{{ previewHelp }}</p>
      <p v-if="previewError" class="message" role="alert" data-preview-error>{{ previewError }}</p>
      <a v-if="blockedPreviewUrl" class="site-preview-fallback" :href="blockedPreviewUrl" target="_blank" rel="noopener" data-preview-fallback>预览窗口被拦截，点击在新标签页打开</a>
    </div>
    <div class="site-content-tabs" role="tablist" aria-label="官网内容分类">
      <button v-for="(tab, index) in tabs" :id="`site-tab-${tab[0]}`" ref="tabButtons" :key="tab[0]" type="button" role="tab" :data-site-tab="tab[0]" :aria-selected="activeTab === tab[0]" :aria-controls="`site-panel-${tab[0]}`" :tabindex="activeTab === tab[0] ? 0 : -1" :class="{ active: activeTab === tab[0] }" @click="activateTab(index)" @keydown="handleTabKey($event, index)">{{ tab[1] }}</button>
    </div>

    <p v-if="loading" class="panel site-loading" role="status">正在加载官网配置…</p>
    <section v-else-if="error" class="panel site-load-error"><p class="message" role="alert">{{ error }}</p><button type="button" class="dark" data-action="retry-load" @click="load">重试</button></section>
    <template v-else>
      <section id="site-panel-homepage" v-show="activeTab === 'homepage'" role="tabpanel" aria-labelledby="site-tab-homepage" data-site-panel="homepage"><SiteSettingsPanel v-if="settings" ref="siteSettingsPanel" :settings="settings" :events="events" :profiles="profiles" @saved="updateSettings" /></section>
      <section id="site-panel-events" v-show="activeTab === 'events'" role="tabpanel" aria-labelledby="site-tab-events" data-site-panel="events"><EventPublicProfilePanel ref="eventPublicProfilePanel" :events="events" :profiles="profiles" @saved="updateProfile" @navigate="emit('navigate', $event)" /></section>
      <section id="site-panel-content" v-show="activeTab === 'content'" role="tabpanel" aria-labelledby="site-tab-content" data-site-panel="content" :data-content-context="contentContext"><div class="content-management-layout"><ContentListPanel v-if="contentContext === 'none'" ref="contentList" :events="events" :selected-id="selectedContentId" @select="chooseContent" @new="newContent" @import="importContent" /><ContentImportPanel v-else-if="contentContext === 'import'" ref="contentImport" :events="events" @cancel="importCancelled" @committed="contentImported" /><div v-else class="content-editor-workflow"><button type="button" data-action="back-to-content-list" @click="backToContentList">返回内容列表</button><ContentEditorPanel ref="contentEditor" :content-id="selectedContentId" :events="events" :profiles="profiles" @saved="contentSaved" @deleted="contentDeleted" @missing="contentMissing" @navigate="emit('navigate', $event)" /></div></div></section>
    </template>
  </section>
</template>
