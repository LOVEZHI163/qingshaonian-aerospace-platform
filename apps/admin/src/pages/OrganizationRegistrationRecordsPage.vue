<script setup>
import { onMounted, reactive, ref } from "vue";

import { api } from "../lib/api.js";

const filters = reactive({ q: "", eventId: "", projectId: "", status: "", page: 1, pageSize: 25 });
const rows = ref([]);
const total = ref(0);
const filterOptions = reactive({ events: [], projects: [] });
const loading = ref(false);
const error = ref("");
const statusText = { pending: "待审核", approved: "已通过", rejected: "已驳回", cancelled: "已取消" };
let requestId = 0;

function requestPath() {
  const params = new URLSearchParams();
  ["q", "eventId", "projectId", "status"].forEach((key) => {
    if (filters[key]) params.set(key, filters[key]);
  });
  params.set("page", String(filters.page));
  params.set("pageSize", String(filters.pageSize));
  return `/api/organization/registrations?${params.toString()}`;
}

async function loadRecords() {
  const currentRequest = ++requestId;
  loading.value = true;
  error.value = "";
  try {
    const payload = await api(requestPath());
    if (currentRequest !== requestId) return;
    rows.value = payload.rows || [];
    total.value = Number(payload.total) || 0;
    filters.page = Number(payload.page) || filters.page;
    filters.pageSize = Number(payload.pageSize) || filters.pageSize;
    filterOptions.events = payload.filterOptions?.events || [];
    filterOptions.projects = payload.filterOptions?.projects || [];
  } catch (_error) {
    if (currentRequest !== requestId) return;
    rows.value = [];
    total.value = 0;
    error.value = "报名记录加载失败，请重试";
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

function resetAndLoad() {
  filters.page = 1;
  loadRecords();
}

function previousPage() {
  if (filters.page <= 1) return;
  filters.page -= 1;
  loadRecords();
}

function nextPage() {
  if (filters.page * filters.pageSize >= total.value) return;
  filters.page += 1;
  loadRecords();
}

onMounted(loadRecords);
</script>

<template>
  <section class="panel organization-registration-records-page" data-testid="organization-registration-records-page">
    <div class="panel-title"><h3>报名记录</h3><span>{{ total }} 条</span></div>
    <p class="hint">查看本组织在全部赛事中的报名、审核和成绩记录。</p>

    <div class="record-filters" aria-label="报名记录筛选">
      <label>搜索<input v-model="filters.q" data-filter="organization-records-q" placeholder="姓名、编号或赛项" @input="resetAndLoad" /></label>
      <label>赛事<select v-model="filters.eventId" data-filter="organization-records-event" @change="resetAndLoad"><option value="">全部赛事</option><option v-for="event in filterOptions.events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label>
      <label>赛项<select v-model="filters.projectId" data-filter="organization-records-project" @change="resetAndLoad"><option value="">全部赛项</option><option v-for="project in filterOptions.projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
      <label>状态<select v-model="filters.status" data-filter="organization-records-status" @change="resetAndLoad"><option value="">全部状态</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="cancelled">已取消</option></select></label>
    </div>

    <p v-if="loading" class="hint">正在加载报名记录…</p>
    <p v-else-if="error" class="message" role="alert">{{ error }} <button type="button" class="mini" data-action="retry-organization-records" @click="loadRecords">重试</button></p>
    <div v-else class="table-wrap"><table class="registration-record-table"><thead><tr><th>赛事</th><th>编号</th><th>姓名</th><th>学校/年级</th><th>赛项</th><th>审核状态</th><th>成绩/奖项</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.id"><td>{{ row.eventName || row.eventId || "-" }}</td><td>{{ row.id }}</td><td>{{ row.athlete?.name || "-" }}</td><td>{{ row.athlete?.school || "-" }}<br /><span>{{ row.athlete?.grade || "-" }}</span></td><td>{{ row.projectName || "-" }}</td><td><em :class="row.status">{{ statusText[row.status] || row.status || "-" }}</em></td><td>{{ row.awardName || "未录入" }}<br /><span>名次 {{ row.rank || "-" }} · 成绩 {{ row.score || "-" }}</span></td></tr>
    </tbody></table><p v-if="rows.length === 0" class="hint empty-state">暂无报名记录。</p></div>

    <div class="pagination"><button type="button" class="mini" data-action="organization-records-previous" :disabled="loading || filters.page <= 1" @click="previousPage">上一页</button><span>第 {{ filters.page }} 页</span><button type="button" class="mini" data-action="organization-records-next" :disabled="loading || filters.page * filters.pageSize >= total" @click="nextPage">下一页</button></div>
  </section>
</template>
