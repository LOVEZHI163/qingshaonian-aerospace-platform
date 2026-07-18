<script setup>
import { computed, onMounted, reactive, ref } from "vue";

import OrganizationRegistrationForm from "../components/OrganizationRegistrationForm.vue";
import { api } from "../lib/api.js";
import { useSession } from "../state/session.js";

const emit = defineEmits(["error", "organization-changed"]);
const session = useSession();
const organizations = ref(session.organizations.value || []);
const memberships = ref([]);
const message = ref("");
const resubmitOpen = ref(false);
const invite = reactive({ organizationId: "", name: "", phone: "", note: "" });
const statusText = { pending: "待审核", invited: "待接受", active: "已加入", approved: "已通过", rejected: "已驳回", removed: "已移除" };
const ownedOrganization = computed(() => organizations.value.find((item) => item.membershipRole === "owner") || organizations.value[0]);
const manageableOrganizations = computed(() => organizations.value.filter((item) => item.status === "active" && item.reviewStatus === "approved" && ["owner", "manager"].includes(item.membershipRole)));
const operational = computed(() => manageableOrganizations.value.length > 0);

function organizationName(id) {
  return organizations.value.find((item) => item.id === id)?.name || id;
}

async function load() {
  try {
    const payload = await api("/api/me/organizations");
    organizations.value = payload.rows || [];
    session.organizations.value = organizations.value;
    const approved = manageableOrganizations.value;
    invite.organizationId ||= approved[0]?.id || "";
    const memberPayloads = await Promise.all(approved.map((organization) => api(`/api/organizations/${organization.id}/members`)));
    memberships.value = memberPayloads.flatMap((item) => item.rows || []);
  } catch (error) {
    emit("error", error.message);
  }
}

async function inviteMember() {
  try {
    await api("/api/organizations/invite", { method: "POST", body: JSON.stringify(invite) });
    invite.name = "";
    invite.phone = "";
    invite.note = "";
    message.value = "邀请已发送";
    await load();
  } catch (error) {
    message.value = error.message;
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
    <div class="panel-title"><h3>组织控制台</h3><span>{{ manageableOrganizations.length }} 个可管理组织</span></div>
    <h4>邀请成员</h4>
    <form class="inline-form" @submit.prevent="inviteMember"><select v-model="invite.organizationId"><option v-for="organization in manageableOrganizations" :key="organization.id" :value="organization.id">{{ organization.name }}</option></select><input v-model="invite.name" placeholder="被邀请人姓名" required /><input v-model="invite.phone" placeholder="被邀请人手机号" required /><input v-model="invite.note" placeholder="备注（选填）" /><button class="dark">发送邀请</button></form>
    <p v-if="message" class="message">{{ message }}</p>
    <div class="table-wrap"><table><thead><tr><th>组织</th><th>成员</th><th>角色</th><th>来源</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="membership in memberships" :key="membership.id"><td>{{ organizationName(membership.organizationId) }}</td><td>{{ membership.invitedName || membership.userId || "未注册用户" }}<br /><span>{{ membership.invitedPhone }}</span></td><td>{{ membership.role }}</td><td>{{ membership.direction === "org_invite" ? "组织邀请" : membership.direction === "user_request" ? "用户申请" : "系统创建" }}</td><td><em :class="membership.status">{{ statusText[membership.status] || membership.status }}</em></td><td><button v-if="['pending','invited'].includes(membership.status)" class="mini" @click="updateMembership(membership, 'active')">通过</button><button v-if="['pending','invited'].includes(membership.status)" class="mini reject" @click="updateMembership(membership, 'rejected')">拒绝</button></td></tr></tbody></table></div>
  </section>
</template>
