<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

const props = defineProps({ initialEventId: { type: String, default: "" } });
const emit = defineEmits(["open-certificates"]);
const events = ref([]); const projects = ref([]); const organizations = ref([]); const rows = ref([]);
const total = ref(0); const refreshedAt = ref(""); const loading = ref(false); const error = ref(""); const success = ref("");
const filters = reactive({ eventId: "", status: "", group: "", projectId: "", organizationId: "", q: "", page: 1, pageSize: 25 });
const editRow = ref(null); const resultRow = ref(null);
const edit = reactive({ organizationId: "", athlete: { name: "", school: "", grade: "", phone: "" }, projectId: "", instructor: "" });
const result = reactive({ awardName: "", rank: "", score: "" });
const downloads = createBlobDownloadManager();
const eventProjects = computed(() => projects.value.filter((project) => !filters.eventId || project.eventId === filters.eventId));
const groups = computed(() => [...new Set(eventProjects.value.flatMap((project) => project.allowedGroups || []))]);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / filters.pageSize)));
const selectedEventId = computed(() => filters.eventId || events.value.find((event) => event.isCurrent)?.id || "");

function query({ includePaging = true, scope } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && (includePaging || !["page", "pageSize"].includes(key))) params.set(key, value);
  if (scope) params.set("scope", scope);
  return params.toString();
}
function resetPage() { filters.page = 1; loadRows(); }
async function loadRows() {
  loading.value = true; error.value = "";
  try {
    const payload = await api(`/api/admin/registrations?${query()}`);
    rows.value = payload.rows || []; total.value = payload.total || 0; refreshedAt.value = payload.refreshedAt || "";
  } catch (cause) { error.value = cause.message || "报名列表加载失败"; } finally { loading.value = false; }
}
async function loadPage() {
  try {
    const [eventPayload, organizationPayload] = await Promise.all([api("/api/admin/events"), api("/api/admin/organizations")]);
    events.value = eventPayload.rows || []; projects.value = eventPayload.projects || []; organizations.value = organizationPayload.rows || [];
    filters.eventId = events.value.some((event) => event.id === props.initialEventId)
      ? props.initialEventId
      : events.value.find((event) => event.isCurrent)?.id || events.value[0]?.id || "";
    await loadRows();
  } catch (cause) { error.value = cause.message || "报名管理加载失败"; }
}
async function status(row, next) {
  const rejectReason = next === "rejected" ? window.prompt("请输入驳回原因", "信息需补充") : "";
  if (next === "rejected" && rejectReason === null) return;
  try { await api(`/api/registrations/${row.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next, rejectReason }) }); success.value = next === "approved" ? "报名已审核通过" : "报名已驳回"; await loadRows(); } catch (cause) { error.value = cause.message; }
}
function beginEdit(row) { editRow.value = row; Object.assign(edit, { organizationId: row.organizationId || "", athlete: { ...row.athlete }, projectId: row.projectId, instructor: row.instructor || "" }); }
async function saveEdit() { try { await api(`/api/admin/registrations/${editRow.value.id}`, { method: "PATCH", body: JSON.stringify(edit) }); editRow.value = null; success.value = "报名信息已修改"; await loadRows(); } catch (cause) { error.value = cause.message; } }
function beginResult(row) { resultRow.value = row; Object.assign(result, { awardName: row.awardName || "", rank: row.rank || "", score: row.score || "" }); }
async function saveResult() { try { await api(`/api/admin/registrations/${resultRow.value.id}/result`, { method: "POST", body: JSON.stringify(result) }); resultRow.value = null; success.value = "成绩已保存"; await loadRows(); } catch (cause) { error.value = cause.message; } }
async function download(kind) {
  const eventId = selectedEventId.value; if (!eventId) return;
  const path = kind === "template" ? `/api/admin/events/${eventId}/certificate-template.xlsx` : `/api/admin/registrations/export.xlsx?${kind === "all" ? `eventId=${encodeURIComponent(eventId)}&scope=all` : `${query({ includePaging: false, scope: "filtered" })}`}`;
  try {
    const blob = await apiBlob(path); downloads.save(blob, kind === "template" ? "证书模板.xlsx" : "报名名单.xlsx");
  } catch (cause) { error.value = cause.message || "下载失败"; }
}
onMounted(loadPage);
onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="registration-management"><div class="page-title-row"><div><h2>报名管理</h2><p>审核报名、录入成绩并导出赛事名单。</p></div><button class="dark" data-action="refresh" :disabled="loading" @click="loadRows">刷新</button></div>
    <p v-if="error" class="message">{{ error }}</p><p v-if="success" class="success-message">{{ success }}</p>
    <section class="panel"><div class="registration-filter-grid">
      <select v-model="filters.eventId" data-filter="eventId" @change="resetPage"><option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option></select>
      <select v-model="filters.status" @change="resetPage"><option value="">全部状态</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="cancelled">已取消</option></select>
      <select v-model="filters.group" @change="resetPage"><option value="">全部组别</option><option v-for="group in groups" :key="group" :value="group">{{ group }}</option></select>
      <select v-model="filters.projectId" @change="resetPage"><option value="">全部赛项</option><option v-for="project in eventProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select>
      <select v-model="filters.organizationId" @change="resetPage"><option value="">全部组织</option><option v-for="organization in organizations" :key="organization.id" :value="organization.id">{{ organization.name }}</option></select>
      <input v-model="filters.q" placeholder="搜索编号、姓名、学校、教师" @keyup.enter="resetPage" />
    </div><div class="form-actions"><button class="mini" @click="resetPage">查询</button><button class="mini" data-action="export-filtered" @click="download('filtered')">导出筛选名单</button><button class="mini" data-action="export-all" @click="download('all')">导出赛事全名单</button><button class="mini" data-action="certificate-template" @click="download('template')">下载证书模板</button></div>
    <p class="hint">{{ loading ? '正在刷新…' : `最近刷新：${refreshedAt ? new Date(refreshedAt).toLocaleString('zh-CN') : '-'}` }}</p>
    <div class="table-wrap"><table><thead><tr><th>编号</th><th>姓名</th><th>学校/实际年级</th><th>组织</th><th>组别/赛项</th><th>指导老师</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="row in rows" :key="row.id"><td>{{ row.id }}</td><td>{{ row.athlete.name }}</td><td>{{ row.athlete.school }}<br><span>{{ row.grade || row.athlete.grade }}</span></td><td>{{ row.organization || '个人报名' }}</td><td>{{ row.group }}<br><span>{{ row.projectName }}</span></td><td>{{ row.instructor || '-' }}</td><td><em :class="row.status">{{ row.status }}</em></td><td><button class="mini" @click="status(row, 'approved')">审核</button><button class="mini reject" @click="status(row, 'rejected')">驳回</button><button class="mini" @click="beginEdit(row)">编辑</button><button class="mini" @click="beginResult(row)">成绩</button><button class="mini" data-action="manage-certificates" @click="emit('open-certificates', row)">证书</button></td></tr></tbody></table><p v-if="!loading && rows.length === 0" class="hint empty-state">暂无报名记录。</p></div>
    <div class="form-actions pagination"><button class="mini" :disabled="filters.page <= 1" @click="filters.page -= 1; loadRows()">上一页</button><span>第 {{ filters.page }} / {{ pageCount }} 页，共 {{ total }} 条</span><button class="mini" :disabled="filters.page >= pageCount" @click="filters.page += 1; loadRows()">下一页</button></div></section>
    <div v-if="editRow" class="dialog-backdrop"><form class="panel organization-dialog" @submit.prevent="saveEdit"><h3>编辑报名</h3><div class="two"><label>姓名<input v-model="edit.athlete.name" required></label><label>学校<input v-model="edit.athlete.school" required></label></div><div class="two"><label>年级<input v-model="edit.athlete.grade" required></label><label>手机号<input v-model="edit.athlete.phone" required></label></div><label>组织<select v-model="edit.organizationId"><option value="">不关联组织</option><option v-for="organization in organizations" :key="organization.id" :value="organization.id">{{ organization.name }}</option></select></label><label>赛项<select v-model="edit.projectId"><option v-for="project in eventProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>指导老师<input v-model="edit.instructor"></label><div class="form-actions"><button class="primary">保存</button><button type="button" @click="editRow = null">取消</button></div></form></div>
    <div v-if="resultRow" class="dialog-backdrop"><form class="panel organization-dialog" @submit.prevent="saveResult"><h3>录入成绩</h3><label>奖项/等级<input v-model="result.awardName"></label><label>名次<input v-model="result.rank"></label><label>成绩/分数<input v-model="result.score"></label><div class="form-actions"><button class="primary">保存</button><button type="button" @click="resultRow = null">取消</button></div></form></div>
  </section>
</template>
