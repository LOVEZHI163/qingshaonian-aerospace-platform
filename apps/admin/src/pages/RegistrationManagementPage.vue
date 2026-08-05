<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import SubmissionAssetReview from "../components/SubmissionAssetReview.vue";

const props = defineProps({ eventId: { type: String, default: "" }, eventArchived: { type: Boolean, default: false } });
const emit = defineEmits(["open-certificates"]);
const events = ref([]); const projects = ref([]); const organizations = ref([]); const rows = ref([]);
const total = ref(0); const refreshedAt = ref(""); const loading = ref(false); const error = ref(""); const success = ref("");
const filters = reactive({ status: "", group: "", projectId: "", organizationId: "", q: "", page: 1, pageSize: 25 });
const editRow = ref(null); const resultRow = ref(null);
const reviewRow = ref(null);
const reviewTrigger = ref(null);
const edit = reactive({ organizationId: "", athlete: { name: "", school: "", grade: "", phone: "" }, projectId: "", instructor: "" });
const result = reactive({ awardName: "", rank: "", score: "" });
const statusText = { pending: "待审核", approved: "已审核", rejected: "已驳回", cancelled: "已取消" };
const downloads = createBlobDownloadManager();
const eventProjects = computed(() => projects.value.filter((project) => project.eventId === props.eventId));
const groups = computed(() => [...new Set(eventProjects.value.flatMap((project) => project.allowedGroups || []))]);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / filters.pageSize)));
const selectedEventId = computed(() => props.eventId);
const archived = computed(() => props.eventArchived || events.value.find((event) => event.id === props.eventId)?.status === "archived");

function query({ includePaging = true, scope } = {}) {
  const params = new URLSearchParams();
  params.set("eventId", props.eventId);
  for (const [key, value] of Object.entries(filters)) if (value && (includePaging || !["page", "pageSize"].includes(key))) params.set(key, value);
  if (scope) params.set("scope", scope);
  return params.toString();
}
function resetPage() { filters.page = 1; loadRows(); }
async function loadRows() {
  if (!props.eventId) return;
  loading.value = true; error.value = "";
  try {
    const payload = await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/registrations?${query()}`);
    rows.value = payload.rows || []; total.value = payload.total || 0; refreshedAt.value = payload.refreshedAt || "";
  } catch (cause) { error.value = cause.message || "报名列表加载失败"; } finally { loading.value = false; }
}
async function loadPage() {
  if (!props.eventId) return;
  try {
    const [eventPayload, organizationPayload] = await Promise.all([api("/api/admin/events"), api("/api/admin/organizations")]);
    events.value = eventPayload.rows || []; projects.value = eventPayload.projects || []; organizations.value = organizationPayload.rows || [];
    await loadRows();
  } catch (cause) { error.value = cause.message || "报名管理加载失败"; }
}
async function status(row, next) {
  if (archived.value) return;
  if (next === "approved" && row.submission?.required && !row.submission.complete) {
    if (row.status === "approved" && window.confirm("作品材料已清理或缺失。确认仅保留既有审核历史状态，不重新通过报名？")) {
      success.value = "作品材料已清理，已保留既有审核历史状态";
      return;
    }
    error.value = "必传作品材料未齐全、已清理或文件缺失，不能直接通过报名";
    return;
  }
  const rejectReason = next === "rejected" ? window.prompt("请输入驳回原因", "信息需补充") : "";
  if (next === "rejected" && rejectReason === null) return;
  try { await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/registrations/${row.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next, rejectReason }) }); success.value = next === "approved" ? "报名已审核通过" : "报名已驳回"; await loadRows(); } catch (cause) { error.value = cause.message; }
}
function materialStatus(row) {
  const submission = row.submission;
  if (!submission?.required) return "无需作品";
  const assets = submission.assets || {};
  const values = [assets.artwork_image, assets.creation_video];
  if (values.some((asset) => asset?.cleanedAt)) return "已清理";
  if (submission.missingKinds?.length) return "文件缺失";
  if (values.every((asset) => !asset)) return "待上传";
  if (values.some((asset) => !asset)) return "文件缺失";
  if (submission.warnings?.length) return "有警告";
  return submission.complete ? "已齐全" : "文件缺失";
}
function beginReview(row, trigger = null) { reviewTrigger.value = trigger; reviewRow.value = row; }
function closeReview() { reviewRow.value = null; void nextTick(() => reviewTrigger.value?.focus()); }
function refreshReview(row) {
  if (row?.id) {
    rows.value = rows.value.map((item) => item.id === row.id ? row : item);
    if (reviewRow.value?.id === row.id) reviewRow.value = row;
  }
  void loadRows();
}
function beginEdit(row) { if (archived.value) return; editRow.value = row; Object.assign(edit, { organizationId: row.organizationId || "", athlete: { ...row.athlete }, projectId: row.projectId, instructor: row.instructor || "" }); }
async function saveEdit() { if (archived.value) return; try { await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/registrations/${editRow.value.id}`, { method: "PATCH", body: JSON.stringify(edit) }); editRow.value = null; success.value = "报名信息已修改"; await loadRows(); } catch (cause) { error.value = cause.message; } }
function beginResult(row) { if (archived.value) return; resultRow.value = row; Object.assign(result, { awardName: row.awardName || "", rank: row.rank || "", score: row.score || "" }); }
async function saveResult() { if (archived.value) return; try { await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/registrations/${resultRow.value.id}/result`, { method: "POST", body: JSON.stringify(result) }); resultRow.value = null; success.value = "成绩已保存"; await loadRows(); } catch (cause) { error.value = cause.message; } }
async function download(kind) {
  const eventId = selectedEventId.value; if (!eventId) return;
  const path = kind === "template" ? `/api/admin/events/${eventId}/certificate-template.xlsx` : `/api/admin/events/${encodeURIComponent(eventId)}/registrations/export.xlsx?${kind === "all" ? "scope=all" : `${query({ includePaging: false, scope: "filtered" })}`}`;
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
    <p v-if="!eventId" class="hint empty-state">请先从顶部选择赛事。</p>
    <section v-else class="panel"><div class="registration-filter-grid">
      <select v-model="filters.status" @change="resetPage"><option value="">全部状态</option><option value="pending">待审核</option><option value="approved">已审核</option><option value="rejected">已驳回</option><option value="cancelled">已取消</option></select>
      <select v-model="filters.group" @change="resetPage"><option value="">全部组别</option><option v-for="group in groups" :key="group" :value="group">{{ group }}</option></select>
      <select v-model="filters.projectId" @change="resetPage"><option value="">全部赛项</option><option v-for="project in eventProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select>
      <select v-model="filters.organizationId" @change="resetPage"><option value="">全部组织</option><option v-for="organization in organizations" :key="organization.id" :value="organization.id">{{ organization.name }}</option></select>
      <input v-model="filters.q" placeholder="搜索编号、姓名、学校、教师" @keyup.enter="resetPage" />
    </div><div class="form-actions"><button class="mini" @click="resetPage">查询</button><button class="mini" data-action="export-filtered" @click="download('filtered')">导出筛选名单</button><button class="mini" data-action="export-all" @click="download('all')">导出赛事全名单</button><button v-if="!archived" class="mini" data-action="certificate-template" @click="download('template')">下载证书模板</button></div>
    <p class="hint">{{ loading ? '正在刷新…' : `最近刷新：${refreshedAt ? new Date(refreshedAt).toLocaleString('zh-CN') : '-'}` }}</p>
    <div class="table-wrap"><table><thead><tr><th>编号</th><th>姓名</th><th>学校/实际年级</th><th>组织</th><th>组别/赛项</th><th>指导老师</th><th>作品材料</th><th>状态</th><th v-if="!archived">操作</th></tr></thead><tbody><tr v-for="row in rows" :key="row.id"><td>{{ row.id }}</td><td>{{ row.athlete.name }}</td><td>{{ row.athlete.school }}<br><span>{{ row.grade || row.athlete.grade }}</span></td><td>{{ row.organization || '个人报名' }}</td><td>{{ row.group }}<br><span>{{ row.projectName }}</span></td><td>{{ row.instructor || '-' }}</td><td><button v-if="row.submission?.required" type="button" class="mini" :data-action="`review-materials-${row.id}`" :aria-label="`查看${row.athlete.name}的作品材料`" @click="beginReview(row, $event.currentTarget)">{{ materialStatus(row) }}</button><span v-else>{{ materialStatus(row) }}</span></td><td><em :class="row.status">{{ statusText[row.status] || row.status }}</em></td><td v-if="!archived"><button class="mini" :data-action="`approve-${row.id}`" :disabled="row.status === 'approved'" @click="status(row, 'approved')">{{ row.status === 'approved' ? '已审核' : '审核' }}</button><button class="mini reject" @click="status(row, 'rejected')">驳回</button><button class="mini" @click="beginEdit(row)">编辑</button><button class="mini" @click="beginResult(row)">成绩</button><button class="mini" data-action="manage-certificates" @click="emit('open-certificates', row)">证书</button></td></tr></tbody></table><p v-if="!loading && rows.length === 0" class="hint empty-state">暂无报名记录。</p></div>
    <div class="form-actions pagination"><button class="mini" :disabled="filters.page <= 1" @click="filters.page -= 1; loadRows()">上一页</button><span>第 {{ filters.page }} / {{ pageCount }} 页，共 {{ total }} 条</span><button class="mini" :disabled="filters.page >= pageCount" @click="filters.page += 1; loadRows()">下一页</button></div></section>
    <div v-if="reviewRow" class="dialog-backdrop"><SubmissionAssetReview :event-id="eventId" :registration="reviewRow" :disabled="archived" @close="closeReview" @refresh="refreshReview" @error="error = $event" /></div>
    <div v-if="editRow" class="dialog-backdrop"><form class="panel organization-dialog" @submit.prevent="saveEdit"><h3>编辑报名</h3><div class="two"><label>姓名<input v-model="edit.athlete.name" required></label><label>学校<input v-model="edit.athlete.school" required></label></div><div class="two"><label>年级<input v-model="edit.athlete.grade" required></label><label>手机号<input v-model="edit.athlete.phone" required></label></div><label>组织<select v-model="edit.organizationId"><option value="">不关联组织</option><option v-for="organization in organizations" :key="organization.id" :value="organization.id">{{ organization.name }}</option></select></label><label>赛项<select v-model="edit.projectId" data-field="registration-project" disabled><option v-for="project in eventProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><p class="hint">赛项在报名创建后不可修改；如需更换赛项，请取消后重新报名。</p><label>指导老师<input v-model="edit.instructor"></label><div class="form-actions"><button class="primary">保存</button><button type="button" @click="editRow = null">取消</button></div></form></div>
    <div v-if="resultRow" class="dialog-backdrop"><form class="panel organization-dialog" @submit.prevent="saveResult"><h3>录入成绩</h3><label>奖项/等级<input v-model="result.awardName"></label><label>名次<input v-model="result.rank"></label><label>成绩/分数<input v-model="result.score"></label><div class="form-actions"><button class="primary">保存</button><button type="button" @click="resultRow = null">取消</button></div></form></div>
  </section>
</template>
