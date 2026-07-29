<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api } from "../lib/api.js";

const props = defineProps({ events: { type: Array, default: () => [] }, selectedId: { type: String, default: null } });
const emit = defineEmits(["select", "new"]);
const states = { draft: "草稿", scheduled: "定时发布", published: "已发布", offline: "已下线" };
const types = { announcement: "公告", news: "新闻", work: "作品", recap: "回顾", guide: "指南" };
const rows = ref([]);
const loading = ref(true);
const error = ref("");
const filters = reactive({ type: "", eventId: "", status: "", keyword: "" });
const PLATFORM_FILTER = "__platform__";
const page = ref(1);
const pageSize = 10;
const hasActiveFilters = computed(() => Object.values(filters).some((value) => String(value).trim()));
const eventNames = computed(() => new Map(props.events.map((event) => [event.id, event.name])));
const eventsById = computed(() => new Map(props.events.map((event) => [event.id, event])));

const filtered = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase();
  return rows.value.filter((row) => (!filters.type || row.type === filters.type)
    && (!filters.eventId
      || (filters.eventId === PLATFORM_FILTER ? !row.eventId : row.eventId === filters.eventId))
    && (!filters.status || row.status === filters.status)
    && (!keyword || [row.title, row.slug, row.summary, eventNames.value.get(row.eventId)]
      .some((value) => String(value || "").toLowerCase().includes(keyword))));
});
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));

watch(
  () => [filters.type, filters.eventId, filters.status, filters.keyword],
  () => { page.value = 1; }
);

async function load() {
  loading.value = true; error.value = "";
  try {
    rows.value = (await api("/api/admin/content")).rows || [];
    page.value = Math.min(Math.max(page.value, 1), pageCount.value);
  }
  catch (failure) { error.value = failure?.message || "内容列表加载失败"; }
  finally { loading.value = false; }
}

onMounted(load);
function clearFilters() {
  Object.assign(filters, { type: "", eventId: "", status: "", keyword: "" });
  page.value = 1;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : "未知时间";
}

function scopeLabel(row) {
  return row.eventId ? (eventNames.value.get(row.eventId) || "未知赛事") : "平台通用";
}

function isActuallyPublic(row) {
  if (row.status !== "published" || !String(row.slug || "").trim()) return false;
  const publishAt = Date.parse(row.publishAt);
  if (!Number.isFinite(publishAt) || publishAt > Date.now()) return false;
  if (!row.eventId) return true;
  return ["published", "archived"].includes(eventsById.value.get(row.eventId)?.status);
}

defineExpose({ load, clearFilters });
</script>

<template>
  <section class="panel content-list-panel">
    <div class="panel-title"><div><h3>内容列表</h3><p>按类型、赛事、状态和关键词筛选。</p></div><div class="form-actions"><button type="button" @click="load">刷新</button><button type="button" class="primary" data-action="new-content" @click="emit('new')">新建内容</button></div></div>
    <div class="content-filter-grid"><label>类型<select v-model="filters.type" data-content-filter="type"><option value="">全部类型</option><option v-for="(label,value) in types" :key="value" :value="value">{{ label }}</option></select></label><label>赛事<select v-model="filters.eventId" data-content-filter="eventId"><option value="">全部赛事</option><option :value="PLATFORM_FILTER">平台通用</option><option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label><label>状态<select v-model="filters.status" data-content-filter="status"><option value="">全部状态</option><option v-for="(label,value) in states" :key="value" :value="value">{{ label }}</option></select></label><label>关键词<input v-model="filters.keyword" data-content-filter="keyword" placeholder="标题、slug 或摘要"></label></div>
    <div class="content-list-summary"><span data-content-list-count>共 {{ filtered.length }} 条内容</span><button v-if="hasActiveFilters" type="button" data-action="clear-content-filters" @click="clearFilters">清空筛选</button></div>
    <p v-if="loading" role="status">正在加载内容列表…</p>
    <div v-else-if="error"><p class="message" role="alert">{{ error }}</p><button type="button" @click="load">重试</button></div>
    <div v-else-if="!rows.length" class="empty-state content-list-empty">
      <p>尚未创建官网内容。创建新闻、公告或赛事资料，让访客及时了解最新动态。</p>
      <button type="button" class="primary" data-action="create-first-content" @click="emit('new')">创建第一篇内容</button>
    </div>
    <div v-else-if="!filtered.length" class="empty-state content-list-empty">
      <p>没有符合条件的内容。可以调整筛选条件或清空筛选后重试。</p>
      <button type="button" data-action="clear-empty-content-filters" @click="clearFilters">清空筛选</button>
    </div>
    <div v-else class="content-list-rows">
      <article v-for="row in paged" :key="row.id" :class="{ selected: row.id === selectedId }" :data-content-row="row.id" @click="emit('select', row.id)">
        <div class="content-list-row-main">
          <div class="content-list-row-heading">
            <span><strong>{{ row.title }}</strong><small>{{ types[row.type] || row.type }} · {{ row.slug }}</small></span>
            <em :class="row.status">{{ states[row.status] || row.status }}</em>
          </div>
          <dl class="content-list-row-facts">
            <div><dt>范围</dt><dd>{{ scopeLabel(row) }}</dd></div>
            <div><dt>位置</dt><dd>{{ row.pinned ? "置顶" : "不置顶" }} · 排序 {{ Number(row.sortOrder || 0) }}</dd></div>
            <div v-if="row.status === 'scheduled' && row.publishAt"><dt>排期</dt><dd>定时至 {{ formatDate(row.publishAt) }}</dd></div>
            <div><dt>更新</dt><dd>{{ formatDate(row.updatedAt) }}</dd></div>
          </dl>
        </div>
        <div class="content-list-row-actions">
          <a v-if="isActuallyPublic(row)" :href="`/content/${encodeURIComponent(row.slug)}`" target="_blank" rel="noopener" data-action="preview-public-content" @click.stop>官网预览</a>
          <button type="button" data-action="edit-content" @click.stop="emit('select', row.id)">编辑</button>
        </div>
      </article>
    </div>
    <div v-if="filtered.length > pageSize" class="content-list-pagination"><button type="button" :disabled="page === 1" @click="page -= 1">上一页</button><span>第 {{ page }} / {{ pageCount }} 页</span><button type="button" :disabled="page === pageCount" @click="page += 1">下一页</button></div>
  </section>
</template>
