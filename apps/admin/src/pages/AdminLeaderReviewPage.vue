<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";

import AccessibleDialog from "../components/AccessibleDialog.vue";
import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import { leaderUserFacingError } from "../lib/leader-error.js";

const leaders = ref([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const success = ref("");
const filters = reactive({ organizationId: "", reviewStatus: "all", keyword: "" });
const historyTarget = ref(null);
const historyRows = ref([]);
const historyLoading = ref(false);
const rejectTarget = ref(null);
const rejectReason = ref("");
const rejectError = ref("");
const preview = ref(null);
const previewUrl = ref("");
const previewLoading = ref(false);
const previewError = ref("");
const downloads = createBlobDownloadManager();
let previewRequestId = 0;
let previewController = null;

const statusText = { pending: "待审核", approved: "已通过", rejected: "已驳回" };
const actionText = { submitted: "提交审核", approved: "审核通过", rejected: "审核驳回", enabled: "启用", disabled: "停用" };

function replaceLeader(row) {
  const index = leaders.value.findIndex((item) => item.id === row.id);
  if (index >= 0) leaders.value.splice(index, 1, row);
}

function queryPath() {
  const query = new URLSearchParams();
  if (filters.organizationId.trim()) query.set("organizationId", filters.organizationId.trim());
  if (filters.reviewStatus !== "all") query.set("reviewStatus", filters.reviewStatus);
  if (filters.keyword.trim()) query.set("q", filters.keyword.trim());
  const suffix = query.toString();
  return `/api/admin/organization-leaders${suffix ? `?${suffix}` : ""}`;
}

async function loadLeaders() {
  loading.value = true;
  error.value = "";
  try {
    const payload = await api(queryPath());
    leaders.value = payload.rows || [];
  } catch (cause) {
    error.value = leaderUserFacingError(cause, "领队审核列表加载失败，请稍后重试");
  } finally {
    loading.value = false;
  }
}

async function review(row, decision, reason = "") {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  success.value = "";
  try {
    const payload = await api(`/api/admin/organization-leaders/${row.id}/review`, {
      method: "PATCH",
      body: JSON.stringify({ decision, reason, submissionVersion: row.submissionVersion })
    });
    replaceLeader(payload.row);
    rejectTarget.value = null;
    rejectReason.value = "";
    rejectError.value = "";
    success.value = decision === "approved" ? "领队审核已通过" : "领队资料已驳回";
  } catch (cause) {
    error.value = leaderUserFacingError(cause, "领队审核失败，请稍后重试");
  } finally {
    saving.value = false;
  }
}

function openReject(row) {
  rejectTarget.value = row;
  rejectReason.value = "";
  rejectError.value = "";
}

function closeReject() {
  rejectTarget.value = null;
  rejectReason.value = "";
  rejectError.value = "";
}

async function submitReject() {
  const reason = rejectReason.value.trim();
  if (!reason) {
    rejectError.value = "请填写驳回原因";
    return;
  }
  await review(rejectTarget.value, "rejected", reason);
}

async function setEnabled(row, enabled) {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  success.value = "";
  try {
    const payload = await api(`/api/admin/organization-leaders/${row.id}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled })
    });
    replaceLeader(payload.row);
    success.value = enabled ? "领队已启用" : "领队已停用";
  } catch (cause) {
    error.value = leaderUserFacingError(cause, "领队启停操作失败，请稍后重试");
  } finally {
    saving.value = false;
  }
}

async function openHistory(row) {
  historyTarget.value = row;
  historyRows.value = [];
  historyLoading.value = true;
  error.value = "";
  try {
    const payload = await api(`/api/organization/leaders/${row.id}/reviews`);
    historyRows.value = payload.rows || [];
  } catch (cause) {
    error.value = leaderUserFacingError(cause, "审核历史加载失败，请稍后重试");
  } finally {
    historyLoading.value = false;
  }
}

function closeHistory() {
  historyTarget.value = null;
  historyRows.value = [];
}

function documentPath(row) {
  return `/api/organization/leaders/${row.id}/authorization/${row.document.id}`;
}

async function downloadAuthorization(row) {
  if (!row.document?.id) return;
  error.value = "";
  try {
    const blob = await apiBlob(documentPath(row));
    downloads.save(blob, row.document.originalName || "领队授权书");
  } catch (cause) {
    error.value = leaderUserFacingError(cause, "授权书下载失败，请稍后重试");
  }
}

function releasePreviewUrl() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = "";
}

function invalidatePreviewRequest() {
  previewRequestId += 1;
  previewController?.abort();
  previewController = null;
}

function closePreview() {
  invalidatePreviewRequest();
  releasePreviewUrl();
  preview.value = null;
  previewLoading.value = false;
  previewError.value = "";
}

async function openPreview(row) {
  if (!row.document?.id) return;
  invalidatePreviewRequest();
  const requestId = previewRequestId;
  const controller = new AbortController();
  previewController = controller;
  releasePreviewUrl();
  preview.value = row;
  previewLoading.value = true;
  previewError.value = "";
  try {
    const blob = await apiBlob(documentPath(row), { signal: controller.signal });
    const objectUrl = URL.createObjectURL(blob);
    if (requestId !== previewRequestId || controller.signal.aborted) return URL.revokeObjectURL(objectUrl);
    previewUrl.value = objectUrl;
  } catch (cause) {
    if (requestId === previewRequestId && cause?.name !== "AbortError") previewError.value = leaderUserFacingError(cause, "授权书预览失败，请稍后重试");
  } finally {
    if (requestId === previewRequestId) {
      previewLoading.value = false;
      previewController = null;
    }
  }
}

function displayTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

onMounted(loadLeaders);
onBeforeUnmount(() => { closePreview(); downloads.dispose(); });
</script>

<template>
  <section class="leader-management-page admin-leader-review-page" data-testid="admin-leader-review-page">
    <div class="page-title-row"><div><h2>领队审核</h2><p>按组织和状态查找领队，审核通用授权书并管理启用状态。</p></div><button type="button" class="dark" :disabled="loading" @click="loadLeaders">刷新</button></div>
    <p v-if="error" class="message">{{ error }}</p><p v-if="success" class="success-message">{{ success }}</p>

    <form class="panel leader-filter" data-testid="leader-filter-form" @submit.prevent="loadLeaders">
      <label>组织 ID<input v-model="filters.organizationId" data-testid="organization-filter" placeholder="输入组织 ID 精确搜索" /></label>
      <label>审核状态<select v-model="filters.reviewStatus" data-testid="status-filter"><option value="all">全部</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已驳回</option></select></label>
      <label>关键词<input v-model="filters.keyword" data-testid="keyword-filter" placeholder="组织、领队姓名或手机" /></label>
      <button class="primary" :disabled="loading">搜索</button>
    </form>

    <section class="panel leader-list-panel">
      <div class="panel-title"><h3>领队资料</h3><span>{{ leaders.length }} 条</span></div>
      <p v-if="loading" class="hint">正在加载领队资料…</p><p v-else-if="leaders.length === 0" class="hint empty-state">暂无符合条件的领队。</p>
      <div v-else class="table-wrap"><table class="leader-review-table"><thead><tr><th>组织</th><th>领队</th><th>版本</th><th>状态</th><th>授权书</th><th>操作</th></tr></thead><tbody><tr v-for="row in leaders" :key="row.id"><td><strong>{{ row.organization?.name || row.organizationId }}</strong><br /><span>{{ row.organizationId }}</span></td><td>{{ row.name }}<br /><span>{{ row.phone }}<template v-if="row.email"> · {{ row.email }}</template></span><p v-if="row.notes" class="hint">{{ row.notes }}</p></td><td>第 {{ row.submissionVersion }} 版</td><td><em :class="row.reviewStatus">{{ statusText[row.reviewStatus] || row.reviewStatus }}</em><br /><em :class="row.enabled ? 'approved' : 'disabled'">{{ row.enabled ? "已启用" : "已停用" }}</em><p v-if="row.rejectionReason" class="leader-rejection">{{ row.rejectionReason }}</p></td><td>{{ row.document?.originalName || "未上传" }}</td><td><div class="leader-actions"><button v-if="row.document" type="button" class="mini" :data-action="`preview-${row.id}`" @click="openPreview(row)">预览</button><button v-if="row.document" type="button" class="mini" :data-action="`download-${row.id}`" @click="downloadAuthorization(row)">下载</button><button type="button" class="mini" :data-action="`history-${row.id}`" @click="openHistory(row)">历史</button><button v-if="row.reviewStatus === 'pending'" type="button" class="mini" :data-action="`approve-${row.id}`" :disabled="saving" @click="review(row, 'approved')">通过</button><button v-if="row.reviewStatus === 'pending'" type="button" class="mini reject" :data-action="`reject-${row.id}`" :disabled="saving" @click="openReject(row)">驳回</button><button v-if="row.enabled" type="button" class="mini reject" :data-action="`disable-${row.id}`" :disabled="saving" @click="setEnabled(row, false)">停用</button><button v-else type="button" class="mini" :data-action="`enable-${row.id}`" :disabled="saving" @click="setEnabled(row, true)">启用</button></div></td></tr></tbody></table></div>
    </section>

    <AccessibleDialog as="form" :open="Boolean(rejectTarget)" labelled-by="admin-leader-reject-title" initial-focus="[data-testid='reject-reason']" class="panel leader-dialog" data-testid="reject-form" @submit.prevent="submitReject" @close="closeReject"><h3 id="admin-leader-reject-title">驳回{{ rejectTarget?.name }}的领队资料</h3><p class="hint">驳回原因会显示给组织负责人，请明确说明需要修改的内容。</p><label>驳回原因<textarea v-model="rejectReason" data-testid="reject-reason" rows="4" required /></label><p v-if="rejectError" class="message" data-testid="reject-error">{{ rejectError }}</p><div class="form-actions"><button class="primary" :disabled="saving">确认驳回</button><button type="button" @click="closeReject">取消</button></div></AccessibleDialog>

    <AccessibleDialog :open="Boolean(historyTarget)" labelled-by="admin-leader-history-title" initial-focus="[data-action='close-history']" class="panel leader-dialog" data-testid="leader-review-history" @close="closeHistory"><div class="panel-title"><h3 id="admin-leader-history-title">{{ historyTarget?.name }}的审核历史</h3><button type="button" class="mini reject" data-action="close-history" @click="closeHistory">关闭</button></div><p v-if="historyLoading" class="hint">正在加载审核历史…</p><p v-else-if="historyRows.length === 0" class="hint">暂无审核记录。</p><ol v-else class="leader-history-list"><li v-for="row in historyRows" :key="row.id"><strong>{{ actionText[row.action] || row.action }}</strong><span>{{ displayTime(row.createdAt) }}</span><p v-if="row.reason">{{ row.reason }}</p></li></ol></AccessibleDialog>

    <AccessibleDialog :open="Boolean(preview)" labelled-by="admin-leader-preview-title" initial-focus="[data-action='close-preview']" class="panel leader-dialog leader-preview-dialog" data-testid="leader-document-dialog" @close="closePreview"><div class="panel-title"><h3 id="admin-leader-preview-title">授权书预览：{{ preview?.document?.originalName }}</h3><button type="button" class="mini reject" data-action="close-preview" @click="closePreview">关闭</button></div><p v-if="previewLoading" class="hint">正在安全加载授权书…</p><p v-else-if="previewError" class="message">{{ previewError }}</p><embed v-else-if="preview?.document?.mimeType === 'application/pdf' && previewUrl" data-testid="leader-document-preview" :src="previewUrl" type="application/pdf" :title="`${preview.name}的授权书预览`" /><img v-else-if="previewUrl" data-testid="leader-document-preview" :src="previewUrl" :alt="preview.document.originalName" /></AccessibleDialog>
  </section>
</template>
