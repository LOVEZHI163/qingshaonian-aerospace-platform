<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../lib/api.js";

const props = defineProps({ events: { type: Array, default: () => [] }, selectedId: { type: String, default: null } });
const emit = defineEmits(["select", "new"]);
const states = { draft: "草稿", scheduled: "定时发布", published: "已发布", offline: "已下线" };
const types = { announcement: "公告", news: "新闻", work: "作品", recap: "回顾", guide: "指南" };
const rows = ref([]);
const loading = ref(true);
const error = ref("");
const filters = reactive({ type: "", eventId: "", status: "", keyword: "" });

const filtered = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase();
  return rows.value.filter((row) => (!filters.type || row.type === filters.type)
    && (!filters.eventId || row.eventId === filters.eventId)
    && (!filters.status || row.status === filters.status)
    && (!keyword || [row.title, row.slug, row.summary].some((value) => String(value || "").toLowerCase().includes(keyword))));
});

async function load() {
  loading.value = true; error.value = "";
  try { rows.value = (await api("/api/admin/content")).rows || []; }
  catch (failure) { error.value = failure?.message || "内容列表加载失败"; }
  finally { loading.value = false; }
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <section class="panel content-list-panel">
    <div class="panel-title"><div><h3>内容列表</h3><p>按类型、赛事、状态和关键词筛选。</p></div><button type="button" class="primary" data-action="new-content" @click="emit('new')">新建内容</button></div>
    <div class="content-filter-grid"><label>类型<select v-model="filters.type" data-content-filter="type"><option value="">全部类型</option><option v-for="(label,value) in types" :key="value" :value="value">{{ label }}</option></select></label><label>赛事<select v-model="filters.eventId" data-content-filter="eventId"><option value="">全部赛事</option><option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label><label>状态<select v-model="filters.status" data-content-filter="status"><option value="">全部状态</option><option v-for="(label,value) in states" :key="value" :value="value">{{ label }}</option></select></label><label>关键词<input v-model="filters.keyword" data-content-filter="keyword" placeholder="标题、slug 或摘要"></label></div>
    <p v-if="loading" role="status">正在加载内容列表…</p>
    <div v-else-if="error"><p class="message" role="alert">{{ error }}</p><button type="button" @click="load">重试</button></div>
    <p v-else-if="!filtered.length" class="empty-state">没有符合条件的内容。</p>
    <div v-else class="content-list-rows">
      <button v-for="row in filtered" :key="row.id" type="button" :class="{ selected: row.id === selectedId }" :data-content-row="row.id" @click="emit('select', row.id)"><span><strong>{{ row.title }}</strong><small>{{ types[row.type] || row.type }} · {{ row.slug }}</small></span><em :class="row.status">{{ states[row.status] || row.status }}</em></button>
    </div>
  </section>
</template>
