<script setup>
import { computed, onMounted, reactive, ref } from "vue";

import { api } from "../lib/api.js";

const props = defineProps({ events: { type: Array, default: () => [] } });

const rows = ref([]);
const summary = ref({ total: 0, sizeBytes: 0, referenced: 0, unreferenced: 0 });
const pagination = ref({ page: 1, limit: 12, total: 0, pages: 1 });
const filters = reactive({ q: "", eventId: "", purpose: "", referenceStatus: "" });
const selected = ref([]);
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const feedback = ref("");

const purposeOptions = [
  ["default-hero", "默认宣传图"],
  ["share-image", "分享封面"],
  ["event-hero", "赛事封面"],
  ["content-cover", "文章封面"],
  ["content-body", "正文图片"],
  ["content-attachment", "文章附件图片"]
];
const purposeLabels = new Map(purposeOptions);
const eventNames = computed(() => new Map(props.events.map((event) => [event.id, event.name])));
const selectedCount = computed(() => selected.value.length);

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : "未知时间";
}

function referenceTitle(reference) {
  return reference.eventName || reference.title || reference.label || reference.entityId;
}

function queryPath() {
  const query = new URLSearchParams({ managed: "1", page: String(pagination.value.page), limit: String(pagination.value.limit) });
  for (const [key, value] of Object.entries(filters)) {
    if (String(value || "").trim()) query.set(key, String(value).trim());
  }
  return `/api/admin/site-media?${query.toString()}`;
}

async function load({ preserveFeedback = false } = {}) {
  loading.value = true;
  error.value = "";
  if (!preserveFeedback) feedback.value = "";
  try {
    const payload = await api(queryPath());
    rows.value = payload.rows || [];
    summary.value = payload.summary || summary.value;
    pagination.value = payload.pagination || pagination.value;
    selected.value = selected.value.filter((id) => rows.value.some((row) => row.id === id));
  } catch (failure) {
    error.value = failure?.message || "图片媒体加载失败";
  } finally {
    loading.value = false;
  }
}

function search() {
  pagination.value.page = 1;
  load();
}

function clearFilters() {
  Object.assign(filters, { q: "", eventId: "", purpose: "", referenceStatus: "" });
  search();
}

function toggleSelected(id, checked) {
  selected.value = checked
    ? [...new Set([...selected.value, id])]
    : selected.value.filter((value) => value !== id);
}

async function deleteMedia(row) {
  if (!row.canDelete || !window.confirm(`确定删除“${row.originalName || row.id}”吗？删除后无法恢复。`)) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/api/admin/site-media/${encodeURIComponent(row.id)}`, { method: "DELETE" });
    feedback.value = "图片已删除";
    await load({ preserveFeedback: true });
  } catch (failure) {
    error.value = failure?.message || "图片删除失败";
  } finally {
    busy.value = false;
  }
}

async function bulkDelete() {
  if (!selected.value.length || !window.confirm(`确定处理选中的 ${selected.value.length} 张图片吗？被引用图片会自动跳过。`)) return;
  busy.value = true;
  error.value = "";
  try {
    const payload = await api("/api/admin/site-media/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: selected.value })
    });
    feedback.value = `删除 ${payload.deleted?.length || 0} 张，跳过 ${payload.skipped?.length || 0} 张`;
    selected.value = [];
    await load({ preserveFeedback: true });
  } catch (failure) {
    error.value = failure?.message || "批量删除失败";
  } finally {
    busy.value = false;
  }
}

function downloadSelected() {
  for (const id of selected.value) {
    const row = rows.value.find((item) => item.id === id);
    if (!row?.downloadUrl) continue;
    const anchor = document.createElement("a");
    anchor.href = row.downloadUrl;
    anchor.download = row.originalName || row.id;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
}

async function replaceMedia(row, event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !window.confirm(`确定用“${file.name}”替换“${row.originalName || row.id}”吗？系统会迁移全部引用。`)) return;
  busy.value = true;
  error.value = "";
  const body = new FormData();
  body.append("file", file);
  try {
    const payload = await api(`/api/admin/site-media/${encodeURIComponent(row.id)}/replace`, { method: "POST", body });
    feedback.value = `图片已替换，迁移 ${payload.migratedReferences || 0} 处引用`;
    await load({ preserveFeedback: true });
  } catch (failure) {
    error.value = failure?.message || "图片替换失败";
  } finally {
    busy.value = false;
  }
}

async function changePage(page) {
  pagination.value.page = page;
  await load();
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <section class="site-media-management" data-testid="site-media-management">
    <div class="media-management-heading">
      <div><h3>图片媒体管理</h3><p>集中管理官网图片。被页面引用的图片需使用“替换”，不能直接删除。</p></div>
      <div class="form-actions"><button type="button" :disabled="loading" @click="load()">刷新图片</button></div>
    </div>

    <div class="media-summary-grid" aria-label="图片媒体概览">
      <article data-summary="total"><span>图片总数</span><strong>{{ summary.total }}</strong></article>
      <article data-summary="size"><span>占用空间</span><strong>{{ formatBytes(summary.sizeBytes) }}</strong></article>
      <article data-summary="referenced"><span>正在使用</span><strong>{{ summary.referenced }}</strong></article>
      <article data-summary="unreferenced"><span>未被引用</span><strong>{{ summary.unreferenced }}</strong></article>
    </div>

    <section class="panel media-filter-panel">
      <div class="media-filter-grid">
        <label>关键词<input v-model="filters.q" data-media-filter="q" type="search" placeholder="文件名或媒体 ID"></label>
        <label>赛事<select v-model="filters.eventId" data-media-filter="eventId"><option value="">全部赛事</option><option value="none">平台通用</option><option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label>
        <label>用途<select v-model="filters.purpose" data-media-filter="purpose"><option value="">全部用途</option><option v-for="option in purposeOptions" :key="option[0]" :value="option[0]">{{ option[1] }}</option></select></label>
        <label>引用状态<select v-model="filters.referenceStatus" data-media-filter="referenceStatus"><option value="">全部状态</option><option value="referenced">正在使用</option><option value="unreferenced">未被引用</option></select></label>
      </div>
      <div class="form-actions"><button type="button" class="primary" data-action="search-media-management" @click="search">查询</button><button type="button" @click="clearFilters">清空筛选</button></div>
    </section>

    <div class="media-bulk-bar">
      <span>已选 {{ selectedCount }} 张</span>
      <div class="form-actions"><button type="button" :disabled="!selectedCount || busy" @click="downloadSelected">下载所选</button><button type="button" class="danger" data-action="bulk-delete-media" :disabled="!selectedCount || busy" @click="bulkDelete">批量删除</button></div>
    </div>
    <p v-if="feedback" class="message success" data-media-feedback>{{ feedback }}</p>
    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在加载图片媒体…</p>

    <div v-else-if="rows.length" class="site-media-card-grid">
      <article v-for="row in rows" :key="row.id" class="site-media-card" :data-media-card="row.id">
        <div class="site-media-card-preview"><img :src="row.previewUrl" :alt="row.originalName || ''" loading="lazy"><label class="media-select"><input :checked="selected.includes(row.id)" type="checkbox" :data-select-media="row.id" @change="toggleSelected(row.id, $event.target.checked)"><span>选择</span></label></div>
        <div class="site-media-card-body">
          <div><strong>{{ row.originalName || row.id }}</strong><small>{{ row.id }}</small></div>
          <dl>
            <div><dt>用途</dt><dd>{{ purposeLabels.get(row.purpose) || row.purpose }}</dd></div>
            <div><dt>赛事</dt><dd>{{ row.eventId ? (eventNames.get(row.eventId) || row.eventId) : "平台通用" }}</dd></div>
            <div><dt>规格</dt><dd>{{ row.width || "-" }}×{{ row.height || "-" }} · {{ formatBytes(row.sizeBytes) }}</dd></div>
            <div><dt>上传</dt><dd>{{ formatDate(row.createdAt) }}</dd></div>
          </dl>
          <details class="media-reference-details"><summary>{{ row.referenceCount ? `正在使用（${row.referenceCount} 处）` : "未被引用" }}</summary><ul v-if="row.references?.length"><li v-for="(reference, index) in row.references" :key="`${reference.kind}-${reference.entityId}-${index}`"><strong>{{ reference.label }}</strong><span>{{ referenceTitle(reference) }}</span></li></ul><p v-else>可安全删除。</p></details>
          <div class="site-media-card-actions">
            <a :href="row.previewUrl" target="_blank" rel="noopener">预览</a>
            <a :href="row.downloadUrl" :download="row.originalName" :data-download-media="row.id">下载</a>
            <label class="file-action">替换<input type="file" accept="image/png,image/jpeg,image/webp" :data-replace-media="row.id" :disabled="busy" @change="replaceMedia(row, $event)"></label>
            <button type="button" class="danger" :data-delete-media="row.id" :disabled="busy || !row.canDelete" :title="row.canDelete ? '删除图片' : '图片仍被引用，请先替换或解除引用'" @click="deleteMedia(row)">删除</button>
          </div>
        </div>
      </article>
    </div>
    <div v-else-if="!error" class="empty-state"><p>暂无符合条件的官网图片。</p></div>

    <div v-if="pagination.pages > 1" class="content-list-pagination"><button type="button" :disabled="pagination.page <= 1" @click="changePage(pagination.page - 1)">上一页</button><span>第 {{ pagination.page }} / {{ pagination.pages }} 页，共 {{ pagination.total }} 张</span><button type="button" :disabled="pagination.page >= pagination.pages" @click="changePage(pagination.page + 1)">下一页</button></div>
  </section>
</template>
