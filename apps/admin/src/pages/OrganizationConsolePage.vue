<script setup>
import { computed, onMounted, ref } from "vue";

import OrganizationRegistrationForm from "../components/OrganizationRegistrationForm.vue";
import { api } from "../lib/api.js";
import { accessMessage, accessMessages } from "../state/access.js";
import { useSession } from "../state/session.js";

const emit = defineEmits(["error", "organization-changed"]);
const session = useSession();
const organizations = ref(session.organizations.value || []);
const memberships = ref([]);
const summary = ref({ total: 0, pending: 0, active: 0 });
const memberPhone = ref("");
const candidate = ref(null);
const busyAction = ref("");
const message = ref("");
const resubmitOpen = ref(false);
const reviewStatusText = { pending: "待审核", active: "已加入", approved: "已通过", rejected: "已驳回", removed: "已移除" };
const membershipStatusText = { rejected: "已拒绝", removed: "已移除" };
const ownerActions = {
  approve: "通过申请",
  reject: "拒绝申请",
  cancel: "撤销邀请",
  remove: "移除成员"
};
const ownedOrganizations = computed(() => session.user.value?.type === "organization" ? organizations.value : []);
const ownedOrganization = computed(() => ownedOrganizations.value.length === 1 ? ownedOrganizations.value[0] : null);
const operational = computed(() => ownedOrganization.value?.status === "active" && ownedOrganization.value?.reviewStatus === "approved");
const restrictionCode = computed(() => {
  if (ownedOrganization.value?.reviewStatus === "pending") return "ORGANIZATION_REVIEW_PENDING";
  if (ownedOrganization.value?.reviewStatus === "rejected") return "ORGANIZATION_REJECTED";
  if (ownedOrganization.value && ownedOrganization.value.status !== "active") return "ORGANIZATION_DISABLED";
  return ownedOrganization.value ? "" : "ORGANIZATION_OWNER_REQUIRED";
});
const restrictionMessage = computed(() => accessMessages[restrictionCode.value] || "组织资料加载中");
const requests = computed(() => memberships.value.filter((row) => row.status === "pending" && row.direction === "user_request"));
const invitations = computed(() => memberships.value.filter((row) => row.status === "pending" && row.direction === "organization_invite"));
const activeMembers = computed(() => memberships.value.filter((row) => row.status === "active" && row.role === "member" && row.user?.id));
const history = computed(() => memberships.value.filter((row) => row.status === "rejected" || row.status === "removed"));

function reportError(error, fallback) {
  message.value = accessMessage(error, fallback);
  emit("error", message.value);
}

function calculateSummary(rows) {
  return {
    total: rows.length,
    pending: rows.filter((row) => row.status === "pending").length,
    active: rows.filter((row) => row.status === "active").length
  };
}

async function loadMemberships() {
  const payload = await api("/api/organization/memberships");
  memberships.value = Array.isArray(payload.rows) ? payload.rows : [];
  summary.value = payload.summary || calculateSummary(memberships.value);
}

async function load() {
  try {
    const payload = await api("/api/me/organizations");
    organizations.value = payload.rows || [];
    session.organizations.value = organizations.value;
    if (operational.value) await loadMemberships();
    else {
      memberships.value = [];
      summary.value = { total: 0, pending: 0, active: 0 };
    }
  } catch (error) {
    reportError(error, "组织信息加载失败");
  }
}

async function findMember() {
  const phone = memberPhone.value.trim();
  candidate.value = null;
  message.value = "";
  if (!/^1\d{10}$/.test(phone)) {
    message.value = "请输入完整的 11 位手机号";
    return;
  }
  busyAction.value = "find";
  try {
    const payload = await api(`/api/organization/member-candidate?phone=${encodeURIComponent(phone)}`);
    const user = payload?.user;
    candidate.value = user?.id && user?.name && user?.phone === phone ? user : null;
    if (!candidate.value) message.value = "未找到可邀请的已注册普通用户";
  } catch (error) {
    reportError(error, "成员查询失败");
  } finally {
    busyAction.value = "";
  }
}

async function inviteMember() {
  if (!candidate.value) return;
  busyAction.value = "invite";
  message.value = "";
  try {
    await api("/api/organization/invitations", {
      method: "POST",
      body: JSON.stringify({ phone: candidate.value.phone })
    });
    memberPhone.value = "";
    candidate.value = null;
    await loadMemberships();
    message.value = "邀请已发送，等待用户本人接受。";
  } catch (error) {
    reportError(error, "邀请发送失败");
  } finally {
    busyAction.value = "";
  }
}

async function updateMembership(row, action) {
  busyAction.value = `${row.id}:${action}`;
  message.value = "";
  let mutated = false;
  try {
    await api(`/api/organization/memberships/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ action })
    });
    mutated = true;
    await loadMemberships();
    message.value = `${ownerActions[action]}成功。`;
  } catch (error) {
    if (["MEMBERSHIP_ACTIVE_CONFLICT", "MEMBERSHIP_TRANSITION_INVALID"].includes(error?.code)) void loadMemberships();
    reportError(error, mutated ? "操作已成功，但刷新成员关系失败" : "成员关系操作失败");
  } finally {
    busyAction.value = "";
  }
}

function removeMember(row) {
  const name = row.user?.name || "未知用户";
  if (!window.confirm(`确认移除成员 ${name}？历史报名和证书不会删除。`)) return;
  void updateMembership(row, "remove");
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
    <h3>{{ restrictionMessage }}</h3>
    <p>当前组织：{{ ownedOrganization?.name || "组织资料加载中" }}</p>
    <em :class="ownedOrganization?.reviewStatus">{{ reviewStatusText[ownedOrganization?.reviewStatus] || "待审核" }}</em>
    <p v-if="restrictionCode === 'ORGANIZATION_DISABLED'" class="hint">该组织已由平台管理员停用，请联系平台管理员处理。</p>
    <p v-if="ownedOrganization?.rejectReason" class="hint">驳回原因：{{ ownedOrganization.rejectReason }}</p>
    <template v-if="ownedOrganization?.reviewStatus === 'rejected'">
      <button type="button" class="dark" data-action="resubmit-organization" @click="resubmitOpen = !resubmitOpen">重新提交资质</button>
      <OrganizationRegistrationForm v-if="resubmitOpen" endpoint="/api/me/organization" method="PATCH" submit-label="重新提交组织资料" resubmission :initial-form="{ name: session.user.value?.name, phone: session.user.value?.phone, organizationName: ownedOrganization?.name, creditCode: ownedOrganization?.creditCode }" @registered="resubmitted" @error="message = $event" />
    </template>
    <p v-if="message" class="message" role="alert">{{ message }}</p>
  </section>

  <section v-else class="panel organization-console-page" data-testid="organization-console-page">
    <div class="panel-title"><h3>组织与成员</h3><span>{{ ownedOrganization?.name }}</span></div>
    <p class="hint">当前账号仅负责此组织；邀请只会发送给已注册且可加入组织的普通用户，并须由用户本人接受。</p>
    <p v-if="message" class="message" role="alert">{{ message }}</p>

    <div class="organization-member-summary" aria-label="成员关系概览">
      <article data-summary="total"><span>全部关系</span><strong>{{ summary.total }}</strong></article>
      <article data-summary="pending"><span>待处理</span><strong>{{ summary.pending }}</strong></article>
      <article data-summary="active"><span>正式成员</span><strong>{{ summary.active }}</strong></article>
    </div>

    <section class="organization-invite-panel" aria-label="邀请成员">
      <div>
        <h4>邀请成员</h4>
        <p class="hint">输入已注册普通用户的完整手机号，核对身份后发送邀请。</p>
      </div>
      <div class="organization-member-search">
        <label>成员手机号
          <input v-model="memberPhone" data-field="member-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="请输入 11 位手机号" @keyup.enter="findMember" />
        </label>
        <button type="button" class="primary" data-action="find-member" :disabled="Boolean(busyAction)" @click="findMember">{{ busyAction === "find" ? "正在查询…" : "查找用户" }}</button>
      </div>
      <article v-if="candidate" class="organization-member-candidate">
        <div><strong>{{ candidate.name }}</strong><p>{{ candidate.phone }}</p></div>
        <button type="button" class="mini" data-action="invite-member" :disabled="Boolean(busyAction)" @click="inviteMember">{{ busyAction === "invite" ? "正在发送…" : "确认邀请" }}</button>
      </article>
    </section>

    <div class="organization-membership-groups">
      <section class="organization-membership-group" aria-label="加入申请">
        <h4>加入申请</h4>
        <div v-if="requests.length" class="table-wrap"><table><thead><tr><th>成员</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="row in requests" :key="row.id"><td><strong>{{ row.user?.name || "未知用户" }}</strong><br /><span>{{ row.user?.phone }}</span></td><td><em class="pending">待审核</em></td><td class="membership-actions"><button type="button" class="mini" :data-action="`approve-${row.id}`" :disabled="Boolean(busyAction)" @click="updateMembership(row, 'approve')">通过申请</button><button type="button" class="mini reject" :data-action="`reject-${row.id}`" :disabled="Boolean(busyAction)" @click="updateMembership(row, 'reject')">拒绝申请</button></td></tr></tbody></table></div>
        <p v-else class="hint empty-state">暂无待审核申请。</p>
      </section>

      <section class="organization-membership-group" aria-label="已发送邀请">
        <h4>已发送邀请</h4>
        <div v-if="invitations.length" class="table-wrap"><table><thead><tr><th>成员</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="row in invitations" :key="row.id"><td><strong>{{ row.user?.name || "未知用户" }}</strong><br /><span>{{ row.user?.phone }}</span></td><td><em class="pending">待本人接受</em></td><td><button type="button" class="mini reject" :data-action="`cancel-${row.id}`" :disabled="Boolean(busyAction)" @click="updateMembership(row, 'cancel')">撤销邀请</button></td></tr></tbody></table></div>
        <p v-else class="hint empty-state">暂无待接受邀请。</p>
      </section>

      <section class="organization-membership-group" aria-label="正式成员">
        <h4>正式成员</h4>
        <div v-if="activeMembers.length" class="table-wrap"><table><thead><tr><th>成员</th><th>来源</th><th>操作</th></tr></thead><tbody><tr v-for="row in activeMembers" :key="row.id"><td><strong>{{ row.user?.name || "未知用户" }}</strong><br /><span>{{ row.user?.phone }}</span></td><td>{{ row.direction === "user_request" ? "用户申请" : "组织邀请" }}</td><td><button type="button" class="mini reject" :data-action="`remove-${row.id}`" :disabled="Boolean(busyAction)" @click="removeMember(row)">移除成员</button></td></tr></tbody></table></div>
        <p v-else class="hint empty-state">暂无正式成员。</p>
        <p class="hint">移除成员不会删除其历史报名和证书。</p>
      </section>

      <section class="organization-membership-group" aria-label="历史关系">
        <h4>历史关系</h4>
        <div v-if="history.length" class="table-wrap"><table><thead><tr><th>成员</th><th>来源</th><th>结果</th></tr></thead><tbody><tr v-for="row in history" :key="row.id"><td><strong>{{ row.user?.name || "未知用户" }}</strong><br /><span>{{ row.user?.phone }}</span></td><td>{{ row.direction === "user_request" ? "用户申请" : "组织邀请" }}</td><td><em :class="row.status">{{ membershipStatusText[row.status] || row.status }}</em></td></tr></tbody></table></div>
        <p v-else class="hint empty-state">暂无历史关系。</p>
      </section>
    </div>
  </section>
</template>
