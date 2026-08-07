<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";

import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

const leaders = ref([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const success = ref("");
const editingId = ref("");
const authorizationFile = ref(null);
const historyTarget = ref(null);
const historyRows = ref([]);
const historyLoading = ref(false);
const fileInput = ref(null);
const downloads = createBlobDownloadManager();

const emptyForm = () => ({ name: "", phone: "", email: "", notes: "" });
const form = reactive(emptyForm());
const statusText = { pending: "待审核", approved: "已通过", rejected: "已驳回" };
const actionText = { submitted: "提交审核", approved: "审核通过", rejected: "审核驳回", enabled: "启用", disabled: "停用" };

function replaceLeader(row) {
  const index = leaders.value.findIndex((item) => item.id === row.id);
  if (index >= 0) leaders.value.splice(index, 1, row);
  else leaders.value.unshift(row);
}

function resetForm() {
  editingId.value = "";
  Object.assign(form, emptyForm());
  authorizationFile.value = null;
  if (fileInput.value) fileInput.value.value = "";
}

function editLeader(row) {
  editingId.value = row.id;
  Object.assign(form, { name: row.name || "", phone: row.phone || "", email: row.email || "", notes: row.notes || "" });
  authorizationFile.value = null;
  if (fileInput.value) fileInput.value.value = "";
  error.value = "";
  success.value = "";
}

function chooseAuthorization(event) {
  authorizationFile.value = event.target.files?.[0] || null;
}

async function loadLeaders() {
  loading.value = true;
  error.value = "";
  try {
    const payload = await api("/api/organization/leaders");
    leaders.value = payload.rows || [];
  } catch (cause) {
    error.value = cause.message || "领队资料加载失败";
  } finally {
    loading.value = false;
  }
}

async function downloadTemplate() {
  error.value = "";
  if (!form.name.trim() || !form.phone.trim()) {
    error.value = "请先填写领队姓名和手机，再下载预填授权书";
    return;
  }
  try {
    const blob = await apiBlob("/api/organization/leaders/authorization-template.docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: form.name.trim(), phone: form.phone.trim() })
    });
    downloads.save(blob, "组织领队授权书.docx");
  } catch (cause) {
    error.value = cause.message || "授权书模板下载失败";
  }
}

async function downloadAuthorization(row) {
  if (!row.document?.id) return;
  error.value = "";
  try {
    const blob = await apiBlob(`/api/organization/leaders/${row.id}/authorization/${row.document.id}`);
    downloads.save(blob, row.document.originalName || "领队授权书");
  } catch (cause) {
    error.value = cause.message || "授权书下载失败";
  }
}

async function submitLeader() {
  if (saving.value) return;
  error.value = "";
  success.value = "";
  if (!form.name.trim() || !form.phone.trim()) {
    error.value = "请填写领队姓名和手机";
    return;
  }
  if (!editingId.value && !authorizationFile.value) {
    error.value = "请上传 PDF、JPG 或 PNG 格式的授权书";
    return;
  }
  const body = new FormData();
  for (const key of ["name", "phone", "email", "notes"]) body.append(key, form[key].trim());
  if (authorizationFile.value) body.append("authorization", authorizationFile.value);
  saving.value = true;
  try {
    const leaderId = editingId.value;
    const payload = await api(leaderId ? `/api/organization/leaders/${leaderId}` : "/api/organization/leaders", {
      method: leaderId ? "PATCH" : "POST",
      body
    });
    replaceLeader(payload.row);
    success.value = leaderId ? "领队资料已更新" : "领队资料已提交审核";
    resetForm();
  } catch (cause) {
    error.value = cause.message || "领队资料提交失败";
  } finally {
    saving.value = false;
  }
}

async function setEnabled(row, enabled) {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  success.value = "";
  try {
    const payload = await api(`/api/organization/leaders/${row.id}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled })
    });
    replaceLeader(payload.row);
    success.value = enabled ? "领队已启用" : "领队已停用";
  } catch (cause) {
    error.value = cause.message || "领队启停操作失败";
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
    error.value = cause.message || "审核历史加载失败";
  } finally {
    historyLoading.value = false;
  }
}

function closeHistory() {
  historyTarget.value = null;
  historyRows.value = [];
}

function displayTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

onMounted(loadLeaders);
onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="leader-management-page" data-testid="organization-leaders-page">
    <div class="page-title-row">
      <div><h2>领队管理</h2><p>提交组织领队资料和授权书，平台审核通过后可启用。</p></div>
      <button type="button" class="dark" :disabled="loading" @click="loadLeaders">刷新</button>
    </div>

    <section class="panel leader-guidance" aria-label="领队资料修改说明">
      <h3>资料修改说明</h3>
      <ul>
        <li>姓名、手机或授权书变化会重新审核。</li>
        <li>邮箱、备注变化不会影响已通过状态。</li>
        <li>只要仍有其他已通过且启用的领队，报名不受影响。</li>
      </ul>
    </section>

    <p v-if="error" class="message">{{ error }}</p>
    <p v-if="success" class="success-message">{{ success }}</p>

    <form class="panel leader-form" data-testid="leader-form" @submit.prevent="submitLeader">
      <div class="panel-title"><h3>{{ editingId ? "修改领队资料" : "新增领队" }}</h3><button v-if="editingId" type="button" class="mini" @click="resetForm">取消修改</button></div>
      <div class="leader-form-grid">
        <label>姓名<input v-model="form.name" data-testid="leader-name" required /></label>
        <label>手机<input v-model="form.phone" data-testid="leader-phone" inputmode="tel" required /></label>
        <label>邮箱<input v-model="form.email" data-testid="leader-email" type="email" /></label>
        <label>备注<textarea v-model="form.notes" data-testid="leader-notes" rows="3" /></label>
      </div>
      <div class="leader-document-row">
        <label>授权书
          <input ref="fileInput" data-testid="leader-authorization" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" :required="!editingId" @change="chooseAuthorization" />
          <span>仅支持 PDF/JPG/PNG，最大 10MB。</span>
        </label>
        <button type="button" data-action="download-template" :disabled="saving" @click="downloadTemplate">下载已预填 DOCX</button>
      </div>
      <p v-if="editingId" class="hint">只修改邮箱或备注时无需重复上传；修改姓名、手机时请同时上传与新资料一致的授权书。</p>
      <div class="form-actions"><button class="primary" :disabled="saving">{{ saving ? "正在提交…" : editingId ? "保存修改" : "提交审核" }}</button></div>
    </form>

    <section class="panel leader-list-panel">
      <div class="panel-title"><h3>本组织领队</h3><span>{{ leaders.length }} 人</span></div>
      <p v-if="loading" class="hint">正在加载领队资料…</p>
      <p v-else-if="leaders.length === 0" class="hint empty-state">尚未提交领队资料。</p>
      <div v-else class="leader-card-grid">
        <article v-for="row in leaders" :key="row.id" class="leader-card">
          <div class="leader-card-header"><div><h4>{{ row.name }}</h4><p>{{ row.phone }}<span v-if="row.email"> · {{ row.email }}</span></p></div><div class="leader-statuses"><em :class="row.reviewStatus">{{ statusText[row.reviewStatus] || row.reviewStatus }}</em><em :class="row.enabled ? 'approved' : 'disabled'">{{ row.enabled ? "已启用" : "已停用" }}</em></div></div>
          <p v-if="row.notes" class="leader-notes">{{ row.notes }}</p>
          <p v-if="row.rejectionReason" class="leader-rejection">驳回原因：{{ row.rejectionReason }}</p>
          <p class="hint">授权书：{{ row.document?.originalName || "未上传" }}</p>
          <div class="leader-actions">
            <button type="button" class="mini" :data-action="`edit-${row.id}`" @click="editLeader(row)">修改资料</button>
            <button v-if="row.document" type="button" class="mini" :data-action="`download-${row.id}`" @click="downloadAuthorization(row)">下载授权书</button>
            <button type="button" class="mini" :data-action="`history-${row.id}`" @click="openHistory(row)">审核历史</button>
            <button v-if="row.enabled" type="button" class="mini reject" :data-action="`disable-${row.id}`" :disabled="saving" @click="setEnabled(row, false)">停用</button>
            <button v-else type="button" class="mini" :data-action="`enable-${row.id}`" :disabled="saving" @click="setEnabled(row, true)">启用</button>
          </div>
        </article>
      </div>
    </section>

    <div v-if="historyTarget" class="dialog-backdrop" @click.self="closeHistory">
      <section class="panel leader-dialog" data-testid="leader-review-history">
        <div class="panel-title"><h3>{{ historyTarget.name }}的审核历史</h3><button type="button" class="mini reject" data-action="close-history" @click="closeHistory">关闭</button></div>
        <p v-if="historyLoading" class="hint">正在加载审核历史…</p>
        <p v-else-if="historyRows.length === 0" class="hint">暂无审核记录。</p>
        <ol v-else class="leader-history-list"><li v-for="row in historyRows" :key="row.id"><strong>{{ actionText[row.action] || row.action }}</strong><span>{{ displayTime(row.createdAt) }}</span><p v-if="row.reason">{{ row.reason }}</p></li></ol>
      </section>
    </div>
  </section>
</template>
