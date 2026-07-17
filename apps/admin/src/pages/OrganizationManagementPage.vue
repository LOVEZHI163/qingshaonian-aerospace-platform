<script setup>
import { computed, onMounted, ref } from "vue";

import { api, apiUrl } from "../lib/api.js";

const organizations = ref([]);
const users = ref([]);
const registrations = ref([]);
const statusFilter = ref("all");
const search = ref("");
const selected = ref(null);
const rejectTarget = ref(null);
const rejectReason = ref("");
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const success = ref("");

const statusText = { pending: "待审核", approved: "已通过", rejected: "已驳回" };
const documentTypeText = { business_license: "营业执照", legal_person_certificate: "事业单位法人证书", school_license: "办学许可证" };
const ownerById = computed(() => new Map(users.value.map((user) => [user.id, user])));
const filteredRows = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return organizations.value.filter((row) => {
    if (statusFilter.value !== "all" && row.reviewStatus !== statusFilter.value) return false;
    if (!keyword) return true;
    const owner = ownerById.value.get(row.ownerUserId);
    return [row.name, row.creditCode, owner?.name, owner?.phone].filter(Boolean).some((value) => String(value).toLowerCase().includes(keyword));
  });
});

function owner(row) { return ownerById.value.get(row.ownerUserId) || {}; }
function userName(userId) { return ownerById.value.get(userId)?.name || userId || "未审核"; }
function memberCount(row) { return Number(row.memberCount ?? row.membersCount ?? 0); }
function registrationCount(row) { return Number(row.registrationCount ?? registrations.value.filter((item) => item.organizationId === row.id).length); }
function currentDocument(row) { return row.documents?.find((document) => document.isCurrent) || row.documents?.[0]; }
function credentialUrl(row) {
  const document = currentDocument(row);
  return document ? apiUrl(`/api/organizations/${row.id}/credential/${document.id}`) : "";
}

async function loadOrganizations() {
  loading.value = true;
  error.value = "";
  try {
    const [organizationPayload, userPayload, registrationPayload] = await Promise.all([
      api("/api/admin/organizations"), api("/api/users"), api("/api/registrations")
    ]);
    organizations.value = organizationPayload.rows || [];
    users.value = userPayload.rows || [];
    registrations.value = registrationPayload.rows || [];
    if (selected.value) selected.value = organizations.value.find((row) => row.id === selected.value.id) || null;
  } catch (cause) { error.value = cause.message || "组织列表加载失败"; } finally { loading.value = false; }
}

async function review(row, status, reason = "") {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api(`/api/admin/organizations/${row.id}/review`, { method: "PATCH", body: JSON.stringify({ status, reason }) });
    rejectTarget.value = null;
    rejectReason.value = "";
    success.value = status === "approved" ? "组织已通过审核" : "已驳回组织申请";
    await loadOrganizations();
  } catch (cause) { error.value = cause.message || "组织审核失败"; } finally { saving.value = false; }
}

async function setOwnerEnabled(row, enabled) {
  const account = owner(row);
  if (!account.id || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api(`/api/admin/users/${account.id}`, { method: "PATCH", body: JSON.stringify({ status: enabled ? "active" : "disabled" }) });
    success.value = enabled ? "组织负责人账号已启用" : "组织负责人账号已停用";
    await loadOrganizations();
  } catch (cause) { error.value = cause.message || "账号状态更新失败"; } finally { saving.value = false; }
}

function openReject(row) { rejectTarget.value = row; rejectReason.value = ""; }

onMounted(loadOrganizations);
</script>

<template>
  <section class="organization-management">
    <div class="page-title-row"><div><h2>组织审核</h2><p>审核组织资质，查看负责人和关联报名情况。</p></div><button type="button" class="dark" :disabled="loading" @click="loadOrganizations">刷新</button></div>
    <p v-if="error" class="message">{{ error }}</p><p v-if="success" class="success-message">{{ success }}</p>
    <div class="organization-tabs" role="tablist"><button v-for="status in ['all', 'pending', 'approved', 'rejected']" :key="status" type="button" :class="{ active: statusFilter === status }" @click="statusFilter = status">{{ status === 'all' ? '全部' : statusText[status] }}</button></div>
    <section class="panel">
      <div class="organization-toolbar"><input v-model="search" placeholder="搜索组织名称 / 统一社会信用代码 / 负责人" /><span>{{ filteredRows.length }} 个组织</span></div>
      <p v-if="loading" class="hint">正在加载组织资料…</p>
      <div v-else class="table-wrap"><table class="organization-table"><thead><tr><th>组织</th><th>负责人</th><th>审核状态</th><th>成员/报名</th><th>审核信息</th><th>操作</th></tr></thead><tbody>
        <tr v-for="row in filteredRows" :key="row.id"><td><strong>{{ row.name }}</strong><br /><span>{{ row.creditCode || '-' }}</span></td><td>{{ owner(row).name || '-' }}<br /><span>{{ owner(row).phone || '-' }}</span></td><td><em :class="row.reviewStatus">{{ statusText[row.reviewStatus] || row.reviewStatus }}</em><p v-if="row.rejectReason" class="hint">{{ row.rejectReason }}</p></td><td>{{ memberCount(row) }} 名成员<br /><span>{{ registrationCount(row) }} 条报名</span></td><td>{{ userName(row.reviewedBy) }}<br /><span>{{ row.reviewedAt ? new Date(row.reviewedAt).toLocaleString('zh-CN') : '-' }}</span></td><td><button class="mini" @click="selected = row">详情</button><a v-if="credentialUrl(row)" class="mini credential-link" :href="credentialUrl(row)" target="_blank" rel="noopener">预览资质</a><button v-if="row.reviewStatus === 'pending'" class="mini" :data-action="`approve-${row.id}`" :disabled="saving" @click="review(row, 'approved')">通过</button><button v-if="row.reviewStatus === 'pending'" class="mini reject" :data-action="`reject-${row.id}`" :disabled="saving" @click="openReject(row)">驳回</button><button v-if="owner(row).status !== 'disabled'" class="mini reject" :disabled="saving || !owner(row).id" @click="setOwnerEnabled(row, false)">停用</button><button v-else class="mini" :disabled="saving" @click="setOwnerEnabled(row, true)">启用</button></td></tr>
      </tbody></table><p v-if="filteredRows.length === 0" class="hint empty-state">暂无符合条件的组织。</p></div>
    </section>
    <div v-if="selected" class="dialog-backdrop" @click.self="selected = null"><section class="panel organization-dialog"><div class="panel-title"><h3>{{ selected.name }}</h3><button class="mini reject" @click="selected = null">关闭</button></div><dl><dt>统一社会信用代码</dt><dd>{{ selected.creditCode }}</dd><dt>负责人</dt><dd>{{ owner(selected).name || '-' }} {{ owner(selected).phone || '' }}</dd><dt>成员数</dt><dd>{{ memberCount(selected) }}</dd><dt>报名数</dt><dd>{{ registrationCount(selected) }}</dd><dt>审核人</dt><dd>{{ userName(selected.reviewedBy) }}</dd><dt>审核时间</dt><dd>{{ selected.reviewedAt ? new Date(selected.reviewedAt).toLocaleString('zh-CN') : '-' }}</dd><dt>资质文件</dt><dd>{{ currentDocument(selected)?.originalName || '未上传' }}</dd></dl></section></div>
    <div v-if="rejectTarget" class="dialog-backdrop" @click.self="rejectTarget = null"><form class="panel organization-dialog" @submit.prevent="review(rejectTarget, 'rejected', rejectReason)"><h3>驳回组织申请</h3><p class="hint">请说明需要补充或修改的内容，负责人可据此重新提交。</p><label>驳回原因<textarea data-testid="reject-reason" v-model="rejectReason" required /></label><div class="form-actions"><button class="primary" data-action="confirm-reject" :disabled="saving">确认驳回</button><button type="button" @click="rejectTarget = null">取消</button></div></form></div>
  </section>
</template>
