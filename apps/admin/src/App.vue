<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import AdminShell from "./components/AdminShell.vue";
import OrganizationRegistrationForm from "./components/OrganizationRegistrationForm.vue";
import { api } from "./lib/api.js";
import AuthPage from "./pages/AuthPage.vue";
import EventManagementPage from "./pages/EventManagementPage.vue";
import OrganizationManagementPage from "./pages/OrganizationManagementPage.vue";
import { useSession } from "./state/session.js";

const API = import.meta.env.VITE_API_URL || "";
const session = useSession();
const currentUser = session.user;
const restoring = session.restoring;

const statusText = {
  pending: "待审核",
  invited: "待接受",
  active: "已加入",
  approved: "已通过",
  rejected: "已驳回",
  cancelled: "已取消",
  removed: "已移除"
};

const certificateStatusText = {
  draft: "未发布",
  published: "已发布"
};

const roleText = {
  ordinary: "普通用户",
  organization: "组织用户",
  admin: "超级管理员"
};

const eventData = ref({ event: {}, projects: [], grades: [] });
const currentView = ref("login");
const message = ref("");
const rows = ref([]);
const users = ref([]);
const organizations = ref([]);
const memberships = ref([]);
const certificates = ref([]);
const batchResult = ref(null);
const duplicate = ref(null);
const filter = ref("all");
const registrationSearch = ref("");
const userFilter = ref("all");
const userSearch = ref("");
const orgSearch = ref("");

const passwordChangeForm = reactive({ currentPassword: "", newPassword: "" });
const resubmitOrganizationOpen = ref(false);

const joinForm = reactive({ organizationId: "", note: "" });
const inviteForm = reactive({ organizationId: "", name: "", phone: "", note: "" });
const registrationForm = reactive({
  organizationId: "",
  athlete: { name: "", school: "", grade: "", phone: "" },
  group: "小学中高组（4-6年级）",
  projectId: "paper-plane-gate",
  instructor: ""
});
const resultForm = reactive({});
const certificateForm = reactive({});
const batchUploadForm = reactive({ file: null });
const userForm = reactive({ id: "", name: "", phone: "", password: "", type: "ordinary", status: "active", organizationName: "", organizationCode: "" });
const registrationEditForm = reactive({
  id: "",
  organizationId: "",
  athlete: { name: "", school: "", grade: "", phone: "" },
  group: "",
  projectId: "",
  instructor: ""
});

const projects = computed(() => eventData.value.projects || []);
const myOrganizations = computed(() => {
  if (!currentUser.value) return [];
  const active = memberships.value.filter((item) => item.userId === currentUser.value.id && item.status === "active");
  return active.map((item) => organizations.value.find((org) => org.id === item.organizationId)).filter(Boolean);
});
const manageableOrganizations = computed(() => {
  if (currentUser.value?.type === "admin") return organizations.value;
  const managed = memberships.value.filter(
    (item) => item.userId === currentUser.value?.id && item.status === "active" && ["owner", "manager"].includes(item.role)
  );
  return managed.map((item) => organizations.value.find((org) => org.id === item.organizationId)).filter(Boolean);
});
const filteredOrganizations = computed(() => {
  const keyword = orgSearch.value.trim().toLowerCase();
  if (!keyword) return organizations.value;
  return organizations.value.filter((org) => {
    return [org.name, org.code, org.contactName, org.contactPhone]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });
});
const canUseOrganizationConsole = computed(() => {
  if (currentUser.value?.type === "admin") return true;
  const owned = organizations.value.find((organization) => organization.ownerUserId === currentUser.value?.id);
  return currentUser.value?.type === "organization" && owned?.reviewStatus === "approved" && owned.status === "active";
});
const selectedProject = computed(() => projects.value.find((item) => item.id === registrationForm.projectId));
const filteredRows = computed(() => {
  const keyword = registrationSearch.value.trim().toLowerCase();
  return rows.value.filter((row) => {
    const statusMatched = filter.value === "all" || row.status === filter.value;
    if (!statusMatched) return false;
    if (!keyword) return true;
    return [row.id, row.athlete?.name, row.athlete?.school, row.athlete?.grade, row.athlete?.phone, row.organization, row.projectName]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });
});
const certificateByRegistration = computed(() => {
  return Object.fromEntries(certificates.value.map((item) => [item.registrationId, item]));
});
const myRegistrationRows = computed(() => {
  if (!currentUser.value) return [];
  return rows.value.filter((row) => row.userId === currentUser.value.id);
});
const myCertificateRows = computed(() => {
  if (!currentUser.value) return [];
  return certificates.value.filter((item) => item.userId === currentUser.value.id && item.status === "published");
});
const managedMemberIds = computed(() => {
  const orgIds = manageableOrganizations.value.map((org) => org.id);
  return [...new Set(memberships.value
    .filter((item) => orgIds.includes(item.organizationId) && item.status === "active" && item.userId)
    .map((item) => item.userId))];
});
const organizationRegistrationRows = computed(() => rows.value.filter((row) => managedMemberIds.value.includes(row.userId)));
const organizationCertificateRows = computed(() => certificates.value.filter((item) => item.status === "published" && managedMemberIds.value.includes(item.userId)));
const registrationQueryRows = computed(() => {
  if (!currentUser.value) return [];
  if (currentUser.value.type === "admin") return rows.value;
  if (currentUser.value.type === "organization") return organizationRegistrationRows.value;
  return myRegistrationRows.value;
});
const certificateQueryRows = computed(() => {
  if (!currentUser.value) return [];
  if (currentUser.value.type === "admin") return certificates.value;
  if (currentUser.value.type === "organization") return organizationCertificateRows.value;
  return myCertificateRows.value;
});
const filteredUsers = computed(() => {
  const keyword = userSearch.value.trim().toLowerCase();
  return users.value.filter((user) => {
    const typeMatched = userFilter.value === "all" || user.type === userFilter.value;
    if (!typeMatched) return false;
    if (!keyword) return true;
    const ownedOrg = organizations.value.find((org) => org.ownerUserId === user.id);
    return [user.name, user.phone, roleText[user.type], user.status, ownedOrg?.name, ownedOrg?.code]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });
});
const orgMemberships = computed(() => {
  const orgIds = manageableOrganizations.value.map((org) => org.id);
  return memberships.value.filter((item) => orgIds.includes(item.organizationId));
});
const myInvites = computed(() => memberships.value.filter((item) => {
  if (!currentUser.value) return false;
  return item.status === "invited" && (item.userId === currentUser.value.id || item.invitedPhone === currentUser.value.phone);
}));
const duplicateBlocksSelectedType = computed(() => {
  if (!duplicate.value || !selectedProject.value) return false;
  return selectedProject.value.type === "individual" ? duplicate.value.individualUsed : duplicate.value.teamUsed;
});
const adminActive = computed(() => currentView.value === "registration" ? "registrations" : currentView.value);

function orgName(id) {
  return organizations.value.find((item) => item.id === id)?.name || "未关联组织";
}

function userName(id, fallback = "") {
  return users.value.find((item) => item.id === id)?.name || fallback || "未注册用户";
}

function ownerOrganization(userId) {
  return organizations.value.find((item) => item.ownerUserId === userId);
}

async function loadEvent() {
  eventData.value = await api("/api/public/event");
  if (!eventData.value.grades?.includes(registrationForm.group)) {
    registrationForm.group = eventData.value.grades?.[0] || "";
  }
  if (!eventData.value.projects?.some((project) => project.id === registrationForm.projectId)) {
    registrationForm.projectId = eventData.value.projects?.[0]?.id || "";
  }
}

async function loadData() {
  if (!currentUser.value || currentUser.value.mustChangePassword) return;
  const [orgRes, profileRes, userRes] = await Promise.all([
    api("/api/organizations"),
    api(`/api/me/${currentUser.value.id}`),
    currentUser.value.type === "admin" ? api("/api/users") : Promise.resolve({ rows: [currentUser.value] })
  ]);
  organizations.value = orgRes.rows;
  memberships.value = profileRes.memberships || [];
  users.value = userRes.rows;

  if (!currentUser.value) {
    rows.value = [];
    certificates.value = [];
  } else if (currentUser.value.type === "admin") {
    const [registrationRes, certificateRes] = await Promise.all([
      api("/api/admin/registrations?pageSize=100"),
      api("/api/admin/certificates")
    ]);
    rows.value = registrationRes.rows;
    certificates.value = certificateRes.rows;
  } else if (currentUser.value.type === "organization") {
    const orgIds = manageableOrganizations.value.map((org) => org.id);
    const [registrationResults, certificateResults] = await Promise.all([
      Promise.all(orgIds.map((orgId) => api(`/api/organizations/${orgId}/registrations`))),
      Promise.all(orgIds.map((orgId) => api(`/api/organizations/${orgId}/certificates`)))
    ]);
    rows.value = registrationResults.flatMap((result) => result.rows);
    certificates.value = certificateResults.flatMap((result) => result.rows);
  } else {
    const [registrationRes, certificateRes] = await Promise.all([
      api("/api/me/registrations"),
      api("/api/me/certificates")
    ]);
    rows.value = registrationRes.rows;
    certificates.value = certificateRes.rows;
  }

  if (!joinForm.organizationId && organizations.value[0]) joinForm.organizationId = organizations.value[0].id;
  if (!inviteForm.organizationId && manageableOrganizations.value[0]) inviteForm.organizationId = manageableOrganizations.value[0].id;
  if (!registrationForm.organizationId && myOrganizations.value[0]) registrationForm.organizationId = myOrganizations.value[0].id;
}

async function login(credentials) {
  message.value = "";
  try {
    const user = await session.login(credentials);
    if (user.mustChangePassword) return;
    await loadData();
    currentView.value = user.type === "admin" ? "overview" : user.type === "organization" ? "organization" : "registration";
  } catch (error) {
    message.value = error.message;
  }
}

function resetUserForm() {
  Object.assign(userForm, { id: "", name: "", phone: "", password: "", type: "ordinary", status: "active", organizationName: "", organizationCode: "" });
}

function resetRegistrationEditForm() {
  Object.assign(registrationEditForm, {
    id: "",
    organizationId: "",
    athlete: { name: "", school: "", grade: "", phone: "" },
    group: "",
    projectId: "",
    instructor: ""
  });
}

function editRegistration(row) {
  Object.assign(registrationEditForm, {
    id: row.id,
    organizationId: row.organizationId || "",
    athlete: { ...row.athlete },
    group: row.group,
    projectId: row.projectId,
    instructor: row.instructor || ""
  });
}

async function saveRegistrationEdit() {
  message.value = "";
  try {
    await api(`/api/admin/registrations/${registrationEditForm.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...registrationEditForm })
    });
    resetRegistrationEditForm();
    await loadData();
    message.value = "报名信息已修改";
  } catch (error) {
    message.value = error.message;
  }
}

function editUser(user) {
  const org = ownerOrganization(user.id);
  Object.assign(userForm, {
    id: user.id,
    name: user.name,
    phone: user.phone,
    password: "",
    type: user.type,
    status: user.status || "active",
    organizationName: org?.name || "",
    organizationCode: org?.code || ""
  });
}

async function saveUser() {
  message.value = "";
  if (!userForm.id && !userForm.password) {
    message.value = "创建用户时请设置至少 8 位、包含字母和数字的初始密码";
    return;
  }
  try {
    const body = {
      name: userForm.name,
      phone: userForm.phone,
      type: userForm.type,
      status: userForm.status,
      organizationName: userForm.organizationName,
      organizationCode: userForm.organizationCode
    };
    if (userForm.password) body.password = userForm.password;
    if (userForm.id) {
      await api(`/api/admin/users/${userForm.id}`, { method: "PATCH", body: JSON.stringify(body) });
      message.value = "用户已更新";
    } else {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
      message.value = "用户已创建";
    }
    resetUserForm();
    await loadData();
  } catch (error) {
    message.value = error.message;
  }
}

async function deleteUser(user) {
  if (!window.confirm(`确认删除用户 ${user.name}？关联的组织关系会同步清理。`)) return;
  message.value = "";
  try {
    await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
    await loadData();
    message.value = "用户已删除";
  } catch (error) {
    message.value = error.message;
  }
}

async function changePassword() {
  message.value = "";
  try {
    const payload = await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify(passwordChangeForm)
    });
    session.setUser(payload.user, session.organizations.value);
    Object.assign(passwordChangeForm, { currentPassword: "", newPassword: "" });
    await loadData();
    currentView.value = payload.user.type === "admin" ? "overview" : payload.user.type === "organization" ? "organization" : "registration";
    message.value = "密码修改成功";
  } catch (error) {
    message.value = error.message;
  }
}

async function logout() {
  await session.logout();
  currentView.value = "login";
  message.value = "";
}

async function organizationResubmitted() {
  resubmitOrganizationOpen.value = false;
  message.value = "组织资料已重新提交，等待管理员审核";
  await session.restore();
  await loadData();
}

function navigateAdmin(key) {
  currentView.value = key === "registrations" ? "registration" : key;
}

async function checkDuplicate() {
  const athlete = registrationForm.athlete;
  if (!athlete.name || !athlete.school || !athlete.grade || !athlete.phone) {
    duplicate.value = null;
    return;
  }
  duplicate.value = await api("/api/registrations/check", {
    method: "POST",
    body: JSON.stringify({ athlete, projectId: registrationForm.projectId, group: registrationForm.group })
  });
}

async function submitRegistration() {
  message.value = "";
  try {
    await api("/api/registrations", {
      method: "POST",
      body: JSON.stringify({
        ...registrationForm,
        source: currentUser.value.type === "organization" ? "组织用户" : "普通用户"
      })
    });
    Object.assign(registrationForm.athlete, { name: "", school: "", grade: "", phone: "" });
    registrationForm.instructor = "";
    duplicate.value = null;
    await loadData();
    message.value = "报名已提交，等待审核";
  } catch (error) {
    message.value = error.message;
  }
}

async function requestJoin() {
  message.value = "";
  try {
    await api("/api/organizations/request", {
      method: "POST",
      body: JSON.stringify({ organizationId: joinForm.organizationId, note: joinForm.note })
    });
    joinForm.note = "";
    await loadData();
    message.value = "已向组织发送加入申请";
  } catch (error) {
    message.value = error.message;
  }
}

async function inviteUser() {
  message.value = "";
  try {
    await api("/api/organizations/invite", {
      method: "POST",
      body: JSON.stringify({ ...inviteForm })
    });
    inviteForm.name = "";
    inviteForm.phone = "";
    inviteForm.note = "";
    await loadData();
    message.value = "邀请已发送";
  } catch (error) {
    message.value = error.message;
  }
}

async function updateMembership(row, status) {
  message.value = "";
  try {
    await api(`/api/memberships/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    await loadData();
  } catch (error) {
    message.value = error.message;
  }
}

async function setRegistrationStatus(row, status) {
  const rejectReason = status === "rejected" ? window.prompt("请输入驳回原因", "信息需补充") : "";
  await api(`/api/registrations/${row.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, rejectReason })
  });
  await loadData();
}

function resultDraft(row) {
  if (!resultForm[row.id]) {
    resultForm[row.id] = { awardName: row.awardName || "", rank: row.rank || "", score: row.score || "" };
  }
  return resultForm[row.id];
}

function certificateDraft(row) {
  if (!certificateForm[row.id]) {
    certificateForm[row.id] = { certificateNo: certificateByRegistration.value[row.id]?.certificateNo || `CERT-${row.id}`, file: null };
  }
  return certificateForm[row.id];
}

function setCertificateFile(row, event) {
  certificateDraft(row).file = event.target.files?.[0] || null;
}

function setBatchFile(event) {
  batchUploadForm.file = event.target.files?.[0] || null;
}

async function saveResult(row) {
  message.value = "";
  try {
    await api(`/api/admin/registrations/${row.id}/result`, {
      method: "POST",
      body: JSON.stringify({ ...resultDraft(row) })
    });
    await loadData();
    message.value = "成绩奖项已保存";
  } catch (error) {
    message.value = error.message;
  }
}

async function uploadCertificate(row) {
  message.value = "";
  const draft = certificateDraft(row);
  if (!draft.file) {
    message.value = "请先选择证书 PDF";
    return;
  }
  try {
    const formData = new FormData();
    formData.append("certificateNo", draft.certificateNo);
    formData.append("certificate", draft.file);
    await api(`/api/admin/registrations/${row.id}/certificate`, { method: "POST", body: formData });
    draft.file = null;
    await loadData();
    message.value = "证书已上传，当前为未发布";
  } catch (error) {
    message.value = error.message;
  }
}

async function publishCertificate(certificate, status) {
  message.value = "";
  try {
    await api(`/api/admin/certificates/${certificate.id}/publish`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    await loadData();
    message.value = status === "published" ? "证书已发布" : "证书已撤回";
  } catch (error) {
    message.value = error.message;
  }
}

async function uploadCertificateBatch() {
  message.value = "";
  batchResult.value = null;
  if (!batchUploadForm.file) {
    message.value = "请先选择 ZIP 文件";
    return;
  }
  try {
    const formData = new FormData();
    formData.append("zip", batchUploadForm.file);
    batchResult.value = await api("/api/admin/certificates/batch", { method: "POST", body: formData });
    batchUploadForm.file = null;
    await loadData();
    message.value = "批量导入已完成，请查看匹配结果";
  } catch (error) {
    message.value = error.message;
  }
}

function downloadCertificate(certificate) {
  window.open(`${API}/api/certificates/${certificate.id}/download`, "_blank");
}

function exportCsv() {
  window.open(`${API}/api/registrations/export.csv`, "_blank");
}

async function resetTemporaryPassword(user) {
  const password = window.prompt(`请输入 ${user.name} 的临时密码（至少 8 位，含字母和数字）`, "");
  if (!password) return;
  message.value = "";
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(password)) {
    message.value = "临时密码至少 8 位且必须同时包含字母和数字";
    return;
  }
  try {
    await api(`/api/admin/users/${user.id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password })
    });
    message.value = "临时密码已重置；请安全告知用户，用户首次登录必须修改。";
  } catch (error) {
    message.value = error.message;
  }
}

watch(
  () => [registrationForm.athlete.name, registrationForm.athlete.school, registrationForm.athlete.grade, registrationForm.athlete.phone],
  () => checkDuplicate()
);

watch(
  () => [currentUser.value?.type, currentView.value],
  () => {
    if (currentUser.value && currentView.value === "admin" && currentUser.value.type !== "admin") {
      currentView.value = "registration";
    }
    if (currentUser.value?.type === "admin" && ["admin", "registrationRecords"].includes(currentView.value)) {
      currentView.value = "registration";
    }
    if (currentUser.value?.type === "admin" && currentView.value === "organization") {
      currentView.value = "registration";
    }
  }
);

onMounted(async () => {
  try {
    await loadEvent();
  } catch (error) {
    message.value = error.message;
  }
  await session.restore();
  if (currentUser.value && !currentUser.value.mustChangePassword) {
    currentView.value = currentUser.value.type === "admin" ? "overview" : currentUser.value.type === "organization" ? "organization" : "registration";
    try {
      await loadData();
    } catch (error) {
      message.value = error.message;
    }
  }
});
</script>

<template>
  <div v-if="restoring" class="app-loading">正在恢复登录状态…</div>

  <AuthPage v-else-if="!currentUser" :event-name="eventData.event.name" @login="login" />

  <section v-else-if="currentUser.mustChangePassword" class="auth-shell force-password-shell">
    <form class="panel auth-panel" @submit.prevent="changePassword">
      <h3>首次登录请修改密码</h3>
      <p class="hint">管理员为你设置的是临时密码。修改完成后才能进入系统，不能跳过此步骤。</p>
      <label>当前临时密码<input v-model="passwordChangeForm.currentPassword" type="password" /></label>
      <label>新密码<input v-model="passwordChangeForm.newPassword" type="password" placeholder="至少 8 位，含字母和数字" /></label>
      <button class="primary">修改密码并进入系统</button>
      <p v-if="message" class="message">{{ message }}</p>
    </form>
  </section>

  <component
    :is="currentUser.type === 'admin' ? AdminShell : 'div'"
    v-else
    :active="adminActive"
    :class="{ shell: currentUser.type !== 'admin' }"
    @navigate="navigateAdmin"
  >
    <template v-if="currentUser.type === 'admin'" #header>
      <div><strong>{{ currentUser.name }}</strong><span>{{ eventData.event.name || "赛事管理平台" }}</span></div>
      <button type="button" class="ghost" @click="logout">退出登录</button>
    </template>
    <aside v-if="currentUser.type !== 'admin'">
      <div class="logo">航</div>
      <h1>赛事报名系统</h1>
      <div class="user-card">
        <strong>{{ currentUser.name }}</strong>
        <span>{{ roleText[currentUser.type] }} · {{ currentUser.phone }}</span>
      </div>
      <button :class="{ active: currentView === 'registration' }" @click="currentView = 'registration'">{{ currentUser.type === "admin" ? "报名管理" : "报名端" }}</button>
      <button v-if="currentUser.type !== 'admin'" :class="{ active: currentView === 'registrationRecords' }" @click="currentView = 'registrationRecords'">报名记录</button>
      <button :class="{ active: currentView === 'certificates' }" @click="currentView = 'certificates'">证书查询</button>
      <button v-if="currentUser.type === 'organization'" :class="{ active: currentView === 'organization' }" @click="currentView = 'organization'">组织端</button>
      <button v-if="currentUser.type === 'admin'" :class="{ active: currentView === 'users' }" @click="currentView = 'users'">用户管理</button>
      <button class="ghost" @click="logout">退出登录</button>
    </aside>

    <main>
      <header class="topbar">
        <div>
          <h2>{{ eventData.event.name || "2026年温州市青少年航空航天创新比赛" }}</h2>
          <p>{{ eventData.event.date }} · {{ eventData.event.venue }} · 报名截止 {{ eventData.event.registrationDeadline }}</p>
        </div>
        <button v-if="currentUser?.type === 'admin'" class="dark" @click="exportCsv">导出名单</button>
      </header>

      <p v-if="message" class="message">{{ message }}</p>

      <EventManagementPage
        v-if="currentUser.type === 'admin' && ['events', 'projects'].includes(currentView)"
        @event-changed="loadEvent"
      />

      <OrganizationManagementPage v-else-if="currentUser.type === 'admin' && currentView === 'organizations'" />

      <section v-else-if="currentUser.type === 'admin' && currentView === 'overview'" class="panel admin-overview">
        <h3>管理概览</h3>
        <p>从左侧进入赛事管理、赛项与组别、报名、证书或用户管理。</p>
        <div class="overview-metrics"><span>报名 {{ rows.length }} 条</span><span>证书 {{ certificates.length }} 张</span><span>用户 {{ users.length }} 个</span></div>
      </section>

      <section v-if="currentView === 'organization' && currentUser.type === 'organization' && !canUseOrganizationConsole" class="panel organization-review-progress">
        <h3>组织审核进度</h3>
        <p>当前组织：{{ ownerOrganization(currentUser.id)?.name || '组织资料加载中' }}</p>
        <em :class="ownerOrganization(currentUser.id)?.reviewStatus">{{ statusText[ownerOrganization(currentUser.id)?.reviewStatus] || '待审核' }}</em>
        <p v-if="ownerOrganization(currentUser.id)?.rejectReason" class="hint">驳回原因：{{ ownerOrganization(currentUser.id).rejectReason }}</p>
        <p v-if="ownerOrganization(currentUser.id)?.reviewStatus === 'rejected'" class="hint">请根据驳回原因重新提交组织资料和资质文件。</p>
        <button v-if="ownerOrganization(currentUser.id)?.reviewStatus === 'rejected'" type="button" class="dark" @click="resubmitOrganizationOpen = !resubmitOrganizationOpen">重新提交资质</button>
        <OrganizationRegistrationForm
          v-if="resubmitOrganizationOpen && ownerOrganization(currentUser.id)?.reviewStatus === 'rejected'"
          endpoint="/api/me/organization"
          method="PATCH"
          submit-label="重新提交组织资料"
          resubmission
          :initial-form="{ name: currentUser.name, phone: currentUser.phone, organizationName: ownerOrganization(currentUser.id)?.name, creditCode: ownerOrganization(currentUser.id)?.creditCode }"
          @registered="organizationResubmitted"
          @error="message = $event"
        />
      </section>

      <section v-else-if="currentView === 'registration' && currentUser.type !== 'admin'" class="content-grid">
        <form class="panel form-panel" @submit.prevent="submitRegistration">
          <div class="panel-title">
            <h3>报名端</h3>
            <span>{{ selectedProject?.type === "team" ? "团体赛" : "个人赛" }}</span>
          </div>
          <label>关联组织
            <select v-model="registrationForm.organizationId">
              <option value="">不关联组织</option>
              <option v-for="org in myOrganizations" :key="org.id" :value="org.id">{{ org.name }}</option>
            </select>
          </label>
          <div class="two">
            <label>姓名<input v-model="registrationForm.athlete.name" required /></label>
            <label>学校<input v-model="registrationForm.athlete.school" required /></label>
          </div>
          <div class="two">
            <label>年级<input v-model="registrationForm.athlete.grade" required /></label>
            <label>手机号/家长手机号<input v-model="registrationForm.athlete.phone" required /></label>
          </div>
          <div class="two">
            <label>组别
              <select v-model="registrationForm.group">
                <option v-for="grade in eventData.grades" :key="grade">{{ grade }}</option>
              </select>
            </label>
            <label>赛项
              <select v-model="registrationForm.projectId">
                <option v-for="project in projects" :key="project.id" :value="project.id">
                  {{ project.name }}（{{ project.type === "team" ? "团体赛" : "个人赛" }}）
                </option>
              </select>
            </label>
          </div>
          <label>指导老师<input v-model="registrationForm.instructor" placeholder="选填" /></label>
          <div v-if="duplicate" class="duplicate">
            <strong :class="{ danger: duplicateBlocksSelectedType }">{{ duplicate.duplicate ? "已发现同身份键报名记录" : "身份键查重通过" }}</strong>
            <span>姓名 + 学校 + 年级 + 手机号/家长手机号</span>
            <p v-if="duplicate.individualUsed">个人赛名额已使用。</p>
            <p v-if="duplicate.teamUsed">团体赛名额已使用。</p>
          </div>
          <button class="primary">提交报名</button>
        </form>

        <section class="panel">
          <div class="panel-title">
            <h3>我的组织关系</h3>
          </div>
          <form class="inline-form" @submit.prevent="requestJoin">
            <input v-model="orgSearch" placeholder="搜索组织名称/代码/联系人" />
            <select v-model="joinForm.organizationId">
              <option v-for="org in filteredOrganizations" :key="org.id" :value="org.id">{{ org.name }}</option>
            </select>
            <input v-model="joinForm.note" placeholder="申请说明" />
            <button class="dark">申请加入组织</button>
          </form>
          <p v-if="filteredOrganizations.length === 0" class="hint">没有找到匹配的组织。</p>
          <div class="list">
            <article v-for="membership in memberships.filter(item => item.userId === currentUser?.id || item.invitedPhone === currentUser?.phone)" :key="membership.id">
              <strong>{{ orgName(membership.organizationId) }}</strong>
              <span>{{ statusText[membership.status] }} · {{ membership.direction === "org_invite" ? "组织邀请" : "用户申请" }}</span>
              <button v-if="membership.status === 'invited'" class="mini" @click="updateMembership(membership, 'active')">接受邀请</button>
            </article>
          </div>
        </section>

      </section>

      <section v-else-if="currentView === 'organization' && canUseOrganizationConsole" class="content-grid">
        <section class="panel">
          <div class="panel-title">
            <h3>组织端</h3>
            <span>{{ manageableOrganizations.length }} 个可管理组织</span>
          </div>
          <form class="inline-form" @submit.prevent="inviteUser">
            <select v-model="inviteForm.organizationId">
              <option v-for="org in manageableOrganizations" :key="org.id" :value="org.id">{{ org.name }}</option>
            </select>
            <input v-model="inviteForm.name" placeholder="被邀请人姓名" />
            <input v-model="inviteForm.phone" placeholder="被邀请人手机号" />
            <button class="dark">邀请用户</button>
          </form>
          <div class="table-wrap">
            <table>
              <thead><tr><th>组织</th><th>用户</th><th>来源</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="membership in orgMemberships" :key="membership.id">
                  <td>{{ orgName(membership.organizationId) }}</td>
                  <td>{{ userName(membership.userId, membership.invitedName) }}<br /><span>{{ membership.invitedPhone }}</span></td>
                  <td>{{ membership.direction === "org_invite" ? "组织邀请" : membership.direction === "user_request" ? "用户申请" : "系统创建" }}</td>
                  <td><em :class="membership.status">{{ statusText[membership.status] }}</em></td>
                  <td>
                    <button v-if="['pending','invited'].includes(membership.status)" class="mini" @click="updateMembership(membership, 'active')">通过</button>
                    <button v-if="['pending','invited'].includes(membership.status)" class="mini reject" @click="updateMembership(membership, 'rejected')">拒绝</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

      </section>

      <section v-else-if="currentView === 'registrationRecords'" class="panel">
        <div class="panel-title">
          <h3>报名记录</h3>
          <span>{{ registrationQueryRows.length }} 条</span>
        </div>
        <p class="hint certificate-scope">
          {{ currentUser.type === "admin" ? "管理员可查看全部报名记录。" : currentUser.type === "organization" ? "组织端显示 active 成员的报名记录。" : "普通用户显示本人报名记录。" }}
        </p>
        <div class="table-wrap">
          <table class="registration-record-table">
            <thead>
              <tr><th>编号</th><th>姓名</th><th>学校/年级</th><th>组织</th><th>赛项</th><th>审核状态</th><th>成绩/奖项</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in registrationQueryRows" :key="row.id">
                <td>{{ row.id }}</td>
                <td>{{ row.athlete.name }}</td>
                <td>{{ row.athlete.school }}<br /><span>{{ row.athlete.grade }}</span></td>
                <td>{{ row.organization || "个人报名" }}</td>
                <td>{{ row.projectName }}<br /><span>{{ row.projectType === "team" ? "团体赛" : "个人赛" }}</span></td>
                <td>
                  <em :class="row.status">{{ statusText[row.status] }}</em>
                  <p v-if="row.rejectReason" class="hint">驳回原因：{{ row.rejectReason }}</p>
                  <span>{{ row.createdAt?.slice(0, 10) }}</span>
                </td>
                <td>{{ row.awardName || "未录入" }}<br /><span>名次 {{ row.rank || "-" }} · 成绩 {{ row.score || "-" }}</span></td>
              </tr>
            </tbody>
          </table>
          <p v-if="registrationQueryRows.length === 0" class="hint empty-state">暂无报名记录。</p>
        </div>
      </section>

      <section v-else-if="currentView === 'certificates'" class="panel">
        <div class="panel-title">
          <h3>证书查询</h3>
          <span>{{ certificateQueryRows.length }} 张</span>
        </div>
        <p class="hint certificate-scope">
          {{ currentUser.type === "admin" ? "管理员可查看全部证书，未发布证书仅管理员可见。" : currentUser.type === "organization" ? "组织端显示 active 成员的已发布证书。" : "普通用户显示本人已发布证书。" }}
        </p>
        <div class="table-wrap">
          <table class="certificate-table">
            <thead>
              <tr><th>证书编号</th><th>姓名</th><th>学校/年级</th><th>赛项</th><th>奖项/成绩</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="certificate in certificateQueryRows" :key="certificate.id">
                <td>{{ certificate.certificateNo }}</td>
                <td>{{ certificate.athlete?.name || "-" }}</td>
                <td>{{ certificate.athlete?.school || "-" }}<br /><span>{{ certificate.athlete?.grade || "-" }}</span></td>
                <td>{{ certificate.projectName }}<br /><span>{{ certificate.organization || "个人报名" }}</span></td>
                <td>{{ certificate.awardName || "证书" }}<br /><span>名次 {{ certificate.rank || "-" }} · 成绩 {{ certificate.score || "-" }}</span></td>
                <td>
                  <em :class="certificate.status">{{ certificateStatusText[certificate.status] }}</em>
                  <br />
                  <span>{{ certificate.publishedAt ? certificate.publishedAt.slice(0, 10) : "未发布" }}</span>
                </td>
                <td>
                  <button class="mini" @click="downloadCertificate(certificate)">下载 PDF</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="certificateQueryRows.length === 0" class="hint empty-state">暂无可查询证书。</p>
        </div>
      </section>

      <section v-else-if="currentView === 'users' && currentUser.type === 'admin'" class="content-grid">
        <form class="panel form-panel" @submit.prevent="saveUser">
          <div class="panel-title">
            <h3>{{ userForm.id ? "编辑用户" : "新增用户" }}</h3>
            <button v-if="userForm.id" type="button" class="mini reject" @click="resetUserForm">取消编辑</button>
          </div>
          <div class="two">
            <label>姓名<input v-model="userForm.name" required /></label>
            <label>手机号<input v-model="userForm.phone" required /></label>
          </div>
          <div class="two">
            <label>账号类型
              <select v-model="userForm.type">
                <option value="ordinary">普通用户</option>
                <option value="organization">组织用户</option>
              </select>
            </label>
            <label>状态
              <select v-model="userForm.status">
                <option value="active">启用</option>
                <option value="disabled">停用</option>
              </select>
            </label>
          </div>
          <label v-if="!userForm.id">初始密码<input v-model="userForm.password" type="password" placeholder="至少 8 位，含字母和数字" required /></label>
          <template v-if="userForm.type === 'organization'">
            <label>组织名称<input v-model="userForm.organizationName" placeholder="学校、青少年宫或活动中心" /></label>
            <label>组织代码<input v-model="userForm.organizationCode" placeholder="如 WZ-SYXX" /></label>
          </template>
          <button class="primary">{{ userForm.id ? "保存修改" : "创建用户" }}</button>
        </form>

        <section class="panel">
          <div class="panel-title">
            <h3>用户列表</h3>
            <span>{{ filteredUsers.length }} 个</span>
          </div>
          <div class="toolbar-inline user-toolbar">
            <input v-model="userSearch" placeholder="搜索姓名/手机号/组织" />
            <select v-model="userFilter">
              <option value="all">全部用户</option>
              <option value="ordinary">普通用户</option>
              <option value="organization">组织用户</option>
              <option value="admin">超级管理员</option>
            </select>
          </div>
          <div class="table-wrap">
            <table class="user-table">
              <thead><tr><th>姓名</th><th>手机号</th><th>类型</th><th>组织</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="user in filteredUsers" :key="user.id">
                  <td>{{ user.name }}</td>
                  <td>{{ user.phone }}</td>
                  <td>{{ roleText[user.type] }}</td>
                  <td>{{ ownerOrganization(user.id)?.name || "-" }}<br /><span>{{ ownerOrganization(user.id)?.code || "" }}</span></td>
                  <td><em :class="user.status">{{ user.status === "disabled" ? "停用" : "启用" }}</em></td>
                  <td>
                    <button v-if="user.type !== 'admin'" class="mini" @click="editUser(user)">编辑</button>
                    <button v-if="user.type !== 'admin'" class="mini" @click="resetTemporaryPassword(user)">重置临时密码</button>
                    <button v-if="user.type !== 'admin'" class="mini reject" @click="deleteUser(user)">删除</button>
                    <span v-else>系统账号</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <section v-else-if="currentView === 'registration' && currentUser.type === 'admin'" class="panel">
        <div class="panel-title">
          <h3>报名管理</h3>
          <div class="toolbar-inline">
            <input v-model="registrationSearch" placeholder="搜索编号/姓名/学校/手机号/组织/赛项" />
            <select v-model="filter">
              <option value="all">全部状态</option>
              <option value="pending">待审核</option>
              <option value="approved">已通过</option>
              <option value="rejected">已驳回</option>
            </select>
          </div>
        </div>
        <form v-if="registrationEditForm.id" class="edit-panel" @submit.prevent="saveRegistrationEdit">
          <div class="panel-title">
            <h3>修改报名信息</h3>
            <button type="button" class="mini reject" @click="resetRegistrationEditForm">取消</button>
          </div>
          <div class="two">
            <label>姓名<input v-model="registrationEditForm.athlete.name" required /></label>
            <label>学校<input v-model="registrationEditForm.athlete.school" required /></label>
          </div>
          <div class="two">
            <label>年级<input v-model="registrationEditForm.athlete.grade" required /></label>
            <label>手机号/家长手机号<input v-model="registrationEditForm.athlete.phone" required /></label>
          </div>
          <div class="two">
            <label>关联组织
              <select v-model="registrationEditForm.organizationId">
                <option value="">不关联组织</option>
                <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
              </select>
            </label>
            <label>组别
              <select v-model="registrationEditForm.group">
                <option v-for="grade in eventData.grades" :key="grade">{{ grade }}</option>
              </select>
            </label>
          </div>
          <label>赛项
            <select v-model="registrationEditForm.projectId">
              <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}（{{ project.type === "team" ? "团体赛" : "个人赛" }}）</option>
            </select>
          </label>
          <label>指导老师<input v-model="registrationEditForm.instructor" placeholder="选填" /></label>
          <button class="primary">保存报名信息</button>
        </form>
        <form class="batch-panel" @submit.prevent="uploadCertificateBatch">
          <div>
            <strong>批量导入证书 PDF</strong>
            <p class="hint">上传 ZIP，文件名格式：姓名_学校_赛项关键字.pdf。匹配成功后生成未发布证书。</p>
          </div>
          <input type="file" accept=".zip,application/zip" @change="setBatchFile" />
          <button class="dark">导入 ZIP</button>
        </form>
        <div v-if="batchResult" class="batch-result">
          <span>成功 {{ batchResult.matched.length }} 个</span>
          <span>未匹配 {{ batchResult.unmatched.length }} 个</span>
          <span>多重匹配 {{ batchResult.ambiguous.length }} 个</span>
          <p v-if="batchResult.unmatched.length" class="hint">未匹配：{{ batchResult.unmatched.map(item => item.fileName).join("，") }}</p>
          <p v-if="batchResult.ambiguous.length" class="hint">多重匹配：{{ batchResult.ambiguous.map(item => item.fileName).join("，") }}</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>编号</th><th>姓名</th><th>学校/年级</th><th>组织</th><th>赛项</th><th>状态</th><th>审核</th><th>成绩/证书</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredRows" :key="row.id">
                <td>{{ row.id }}</td>
                <td>{{ row.athlete.name }}</td>
                <td>{{ row.athlete.school }}<br /><span>{{ row.athlete.grade }}</span></td>
                <td>{{ row.organization || "个人报名" }}</td>
                <td>{{ row.projectName }}<br /><span>{{ row.projectType === "team" ? "团体赛" : "个人赛" }}</span></td>
                <td><em :class="row.status">{{ statusText[row.status] }}</em></td>
                <td>
                  <button class="mini" @click="editRegistration(row)">修改</button>
                  <button class="mini" @click="setRegistrationStatus(row, 'approved')">通过</button>
                  <button class="mini reject" @click="setRegistrationStatus(row, 'rejected')">驳回</button>
                </td>
                <td class="admin-actions">
                  <div class="mini-form">
                    <input v-model="resultDraft(row).awardName" placeholder="奖项/等级" />
                    <input v-model="resultDraft(row).rank" placeholder="名次" />
                    <input v-model="resultDraft(row).score" placeholder="成绩/分数" />
                    <button class="mini" @click="saveResult(row)">保存成绩</button>
                  </div>
                  <div class="mini-form certificate-upload">
                    <input v-model="certificateDraft(row).certificateNo" placeholder="证书编号" />
                    <input type="file" accept="application/pdf,.pdf" @change="setCertificateFile(row, $event)" />
                    <button class="mini" @click="uploadCertificate(row)">上传证书</button>
                  </div>
                  <div v-if="certificateByRegistration[row.id]" class="certificate-state">
                    <span>{{ certificateByRegistration[row.id].certificateNo }} · {{ certificateStatusText[certificateByRegistration[row.id].status] }}</span>
                    <button v-if="certificateByRegistration[row.id].status !== 'published'" class="mini" @click="publishCertificate(certificateByRegistration[row.id], 'published')">发布</button>
                    <button v-else class="mini reject" @click="publishCertificate(certificateByRegistration[row.id], 'draft')">撤回</button>
                    <button class="mini" @click="downloadCertificate(certificateByRegistration[row.id])">下载</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </component>
</template>

