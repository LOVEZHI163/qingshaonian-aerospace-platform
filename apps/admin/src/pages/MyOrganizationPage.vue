<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";

import { api } from "../lib/api.js";

const emit = defineEmits(["error", "organization-changed"]);
const relations = ref({ active: [], requests: [], invitations: [] });
const query = ref("");
const results = ref([]);
const note = ref("");
const loading = ref(false);
const busyAction = ref("");
const message = ref("");

function reportError(error, fallback) {
  message.value = error?.message || fallback;
  emit("error", message.value);
}

async function loadRelations({ rethrow = false } = {}) {
  loading.value = true;
  try {
    const payload = await api("/api/me/organization-relations");
    relations.value = {
      active: Array.isArray(payload.active) ? payload.active : [],
      requests: Array.isArray(payload.requests) ? payload.requests : [],
      invitations: Array.isArray(payload.invitations) ? payload.invitations : []
    };
  } catch (error) {
    if (rethrow) throw error;
    reportError(error, "组织关系加载失败");
  } finally {
    loading.value = false;
  }
}

async function searchOrganizations() {
  const keyword = query.value.trim();
  if (!keyword) {
    results.value = [];
    return;
  }
  loading.value = true;
  message.value = "";
  try {
    const payload = await api(`/api/organizations/search?q=${encodeURIComponent(keyword)}`);
    results.value = Array.isArray(payload.rows) ? payload.rows : [];
  } catch (error) {
    reportError(error, "组织搜索失败");
  } finally {
    loading.value = false;
  }
}

async function requestOrganization(organization) {
  busyAction.value = `request:${organization.id}`;
  message.value = "";
  let mutated = false;
  try {
    await api("/api/me/organization-requests", {
      method: "POST",
      body: JSON.stringify({ organizationId: organization.id, note: note.value.trim() })
    });
    mutated = true;
    await loadRelations({ rethrow: true });
    message.value = "已提交加入申请，等待组织审核。";
    emit("organization-changed");
  } catch (error) {
    if (["MEMBERSHIP_ACTIVE_CONFLICT", "MEMBERSHIP_TRANSITION_INVALID"].includes(error?.code)) void loadRelations();
    reportError(error, mutated ? "操作已成功，但刷新组织关系失败" : "组织加入申请失败");
  } finally {
    busyAction.value = "";
  }
}

async function updateRelation(row, action) {
  busyAction.value = `${row.id}:${action}`;
  let mutated = false;
  try {
    await api(`/api/me/organization-relations/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ action })
    });
    mutated = true;
    await loadRelations({ rethrow: true });
    emit("organization-changed");
  } catch (error) {
    if (["MEMBERSHIP_ACTIVE_CONFLICT", "MEMBERSHIP_TRANSITION_INVALID"].includes(error?.code)) void loadRelations();
    reportError(error, mutated ? "操作已成功，但刷新组织关系失败" : "组织关系操作失败");
  } finally {
    busyAction.value = "";
  }
}

function leaveOrganization(row) {
  if (!window.confirm("确认退出该组织？历史报名、成绩和证书不会删除。")) return;
  void updateRelation(row, "leave");
}

function refreshRelationsOnFocus() {
  void loadRelations();
}

onMounted(() => {
  void loadRelations();
  window.addEventListener("focus", refreshRelationsOnFocus);
});
onBeforeUnmount(() => window.removeEventListener("focus", refreshRelationsOnFocus));
</script>

<template>
  <section class="panel my-organization-page" data-testid="my-organization-page">
    <div class="panel-title"><h3>我的组织</h3><span>个人组织关系</span><button type="button" class="mini" data-action="refresh-organization-relations" :disabled="loading" @click="loadRelations">{{ loading ? "正在刷新…" : "刷新" }}</button></div>
    <p class="hint">可申请加入已通过审核的组织；组织邀请须由本人确认后才会生效。</p>
    <p v-if="message" class="message" role="alert">{{ message }}</p>
    <p v-if="loading" class="hint">正在更新组织关系…</p>

    <section v-if="relations.active.length" class="organization-active-card" aria-label="已加入组织">
      <h4>已加入组织</h4>
      <article v-for="row in relations.active" :key="row.id" class="organization-result-card">
        <div><strong>{{ row.organization?.name }}</strong><p>{{ row.organization?.code || "组织编码待补充" }}</p></div>
        <div class="relation-card-actions"><em class="active">已加入</em><button type="button" class="mini reject" :data-action="`leave-organization-${row.id}`" :disabled="Boolean(busyAction)" @click="leaveOrganization(row)">{{ busyAction === `${row.id}:leave` ? "正在退出…" : "退出组织" }}</button></div>
      </article>
      <p class="hint">退出不会删除历史报名、成绩和证书。</p>
    </section>

    <div v-if="relations.requests.length || relations.invitations.length" class="organization-relation-grid">
      <section v-if="relations.requests.length" class="relation-status-list" aria-label="我的加入申请">
        <h4>我的加入申请</h4>
        <article v-for="row in relations.requests" :key="row.id" class="organization-result-card">
          <div><strong>{{ row.organization?.name }}</strong><p>{{ row.note || "等待组织审核" }}</p></div>
          <div class="relation-card-actions"><em class="pending">待审核</em><button type="button" class="mini" :data-action="`withdraw-organization-request-${row.id}`" :disabled="Boolean(busyAction)" @click="updateRelation(row, 'withdraw')">{{ busyAction === `${row.id}:withdraw` ? "正在撤回…" : "撤回申请" }}</button></div>
        </article>
      </section>
      <section v-if="relations.invitations.length" class="relation-status-list" aria-label="收到的组织邀请">
        <h4>收到的组织邀请</h4>
        <article v-for="row in relations.invitations" :key="row.id" class="organization-result-card">
          <div><strong>{{ row.organization?.name }}</strong><p>{{ row.note || "该组织邀请你加入" }}</p></div>
          <div class="relation-card-actions"><em class="pending">待确认</em><button type="button" class="mini" :data-action="`accept-organization-invitation-${row.id}`" :disabled="Boolean(busyAction)" @click="updateRelation(row, 'accept')">{{ busyAction === `${row.id}:accept` ? "正在接受…" : "接受邀请" }}</button><button type="button" class="mini reject" :data-action="`reject-organization-invitation-${row.id}`" :disabled="Boolean(busyAction)" @click="updateRelation(row, 'reject')">拒绝</button></div>
        </article>
      </section>
    </div>

    <template v-if="!relations.active.length">
      <section class="organization-search-form" aria-label="搜索组织">
        <label>搜索组织
          <input v-model="query" data-field="organization-search" type="search" placeholder="输入组织名称或组织编码" @keyup.enter="searchOrganizations" />
        </label>
        <label>申请说明（可选）
          <input v-model="note" data-field="organization-note" type="text" maxlength="200" placeholder="可简要说明申请原因" />
        </label>
        <button type="button" class="primary" data-action="search-organizations" :disabled="loading" @click="searchOrganizations">搜索组织</button>
      </section>
      <div v-if="results.length" class="organization-result-list" aria-label="组织搜索结果">
        <article v-for="organization in results" :key="organization.id" class="organization-result-card">
          <div><strong>{{ organization.name }}</strong><p>{{ organization.code || "组织编码待补充" }}</p></div>
          <button type="button" class="mini" :data-action="`request-organization-${organization.id}`" :disabled="Boolean(busyAction)" @click="requestOrganization(organization)">{{ busyAction === `request:${organization.id}` ? "正在提交…" : "申请加入" }}</button>
        </article>
      </div>
      <p v-else-if="query && !loading" class="hint empty-state">暂无匹配的可加入组织。</p>
    </template>

  </section>
</template>
