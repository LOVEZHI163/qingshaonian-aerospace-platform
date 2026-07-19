<script setup>
import { onMounted, ref } from "vue";

import EventPublicProfilePanel from "../components/EventPublicProfilePanel.vue";
import SiteSettingsPanel from "../components/SiteSettingsPanel.vue";
import { api } from "../lib/api.js";

const tabs = [["homepage", "首页设置"], ["events", "赛事视觉"], ["content", "内容发布"]];
const activeTab = ref("homepage");
const loading = ref(true);
const error = ref("");
const settings = ref(null);
const events = ref([]);
const profiles = ref([]);

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

onMounted(load);
</script>

<template>
  <section class="site-content-page" data-testid="site-content-page">
    <div class="page-title-row"><div><h2>官网内容</h2><p>统一维护首页信息、赛事视觉与公开内容。</p></div><button type="button" class="dark" data-action="refresh-site-content" :disabled="loading" @click="load">刷新</button></div>
    <div class="site-content-tabs" role="tablist" aria-label="官网内容分类">
      <button v-for="tab in tabs" :id="`site-tab-${tab[0]}`" :key="tab[0]" type="button" role="tab" :data-site-tab="tab[0]" :aria-selected="activeTab === tab[0]" :aria-controls="`site-panel-${tab[0]}`" :class="{ active: activeTab === tab[0] }" @click="activeTab = tab[0]">{{ tab[1] }}</button>
    </div>

    <p v-if="loading" class="panel site-loading" role="status">正在加载官网配置…</p>
    <section v-else-if="error" class="panel site-load-error"><p class="message" role="alert">{{ error }}</p><button type="button" class="dark" data-action="retry-load" @click="load">重试</button></section>
    <template v-else>
      <section id="site-panel-homepage" v-show="activeTab === 'homepage'" role="tabpanel" aria-labelledby="site-tab-homepage" data-site-panel="homepage"><SiteSettingsPanel v-if="settings" :settings="settings" :events="events" :profiles="profiles" @saved="updateSettings" /></section>
      <section id="site-panel-events" v-show="activeTab === 'events'" role="tabpanel" aria-labelledby="site-tab-events" data-site-panel="events"><EventPublicProfilePanel :events="events" :profiles="profiles" @saved="updateProfile" /></section>
      <section id="site-panel-content" v-show="activeTab === 'content'" role="tabpanel" aria-labelledby="site-tab-content" data-site-panel="content"><div class="panel site-placeholder"><h3>内容发布</h3><p>内容管理将在下一步接入。</p></div></section>
    </template>
  </section>
</template>
