<script setup>
import { computed, onMounted, ref } from "vue";

import OrganizationRegistrationForm from "../components/OrganizationRegistrationForm.vue";
import { api } from "../lib/api.js";
import { useSession } from "../state/session.js";

const emit = defineEmits(["error", "organization-changed"]);
const session = useSession();
const organizations = ref(session.organizations.value || []);
const memberships = ref([]);
const message = ref("");
const resubmitOpen = ref(false);
const statusText = { pending: "待审核", active: "已加入", approved: "已通过", rejected: "已驳回", removed: "已移除" };
const ownedOrganization = computed(() => organizations.value.find((item) => item.ownerUserId === session.user.value?.id) || null);
const operational = computed(() => ownedOrganization.value?.status === "active" && ownedOrganization.value?.reviewStatus === "approved");

async function load() {
  try {
    const payload = await api("/api/me/organizations");
    organizations.value = payload.rows || [];
    session.organizations.value = organizations.value;
    memberships.value = ownedOrganization.value ? (await api(`/api/organizations/${ownedOrganization.value.id}/members`)).rows || [] : [];
  } catch (error) {
    emit("error", error.message);
  }
}

async function updateMembership(row, status) {
  try {
    await api(`/api/memberships/${row.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    await load();
  } catch (error) {
    message.value = error.message;
  }
}

async function resubmitted() {
  resubmitOpen.value = false;
  message.value = "组织资料已重新提交，等待管理员审核";
  await session.restore();
  await load();
  emit("organization-changed");
}

onMounted(load);
</script>

<template>
  <section v-if="!operational" class="panel organization-review-progress" data-testid="organization-review-progress">
    <h3>组织资料正在审核</h3>
    <p>当前组织：{{ ownedOrganization?.name || "组织资料加载中" }}</p>
    <em :class="ownedOrganization?.reviewStatus">{{ statusText[ownedOrganization?.reviewStatus] || "待审核" }}</em>
    <p v-if="ownedOrganization?.rejectReason" class="hint">驳回原因：{{ ownedOrganization.rejectReason }}</p>
    <template v-if="ownedOrganization?.reviewStatus === 'rejected'">
      <button type="button" class="dark" @click="resubmitOpen = !resubmitOpen">重新提交资质</button>
      <OrganizationRegistrationForm v-if="resubmitOpen" endpoint="/api/me/organization" method="PATCH" submit-label="重新提交组织资料" resubmission :initial-form="{ name: session.user.value?.name, phone: session.user.value?.phone, organizationName: ownedOrganization?.name, creditCode: ownedOrganization?.creditCode }" @registered="resubmitted" @error="message = $event" />
    </template>
    <p v-if="message" class="message">{{ message }}</p>
  </section>

  <section v-else class="panel organization-console-page" data-testid="organization-console-page">
    <div class="panel-title"><h3>组织与成员</h3><span>{{ ownedOrganization?.name }}</span></div>
    <p class="hint">当前账号仅负责此组织；成员申请由普通用户发起，审核通过后成为 active 成员。</p>
    <p v-if="message" class="message">{{ message }}</p>
    <div class="table-wrap"><table><thead><tr><th>成员</th><th>来源</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="membership in memberships" :key="membership.id"><td>{{ membership.invitedName || membership.userId || "未注册用户" }}<br /><span>{{ membership.invitedPhone }}</span></td><td>{{ membership.direction === "user_request" ? "用户申请" : "系统记录" }}</td><td><em :class="membership.status">{{ statusText[membership.status] || membership.status }}</em></td><td><button v-if="membership.status === 'pending'" class="mini" @click="updateMembership(membership, 'active')">通过</button><button v-if="membership.status === 'pending'" class="mini reject" @click="updateMembership(membership, 'rejected')">拒绝</button></td></tr></tbody></table><p v-if="!memberships.length" class="hint empty-state">暂无成员申请。</p></div>
  </section>
</template>
