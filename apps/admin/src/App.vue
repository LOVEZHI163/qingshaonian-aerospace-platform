<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import AdminShell from "./components/AdminShell.vue";
import { api } from "./lib/api.js";
import AuthPage from "./pages/AuthPage.vue";
import CertificateManagementPage from "./pages/CertificateManagementPage.vue";
import DashboardPage from "./pages/DashboardPage.vue";
import EventManagementPage from "./pages/EventManagementPage.vue";
import MyCertificatesPage from "./pages/MyCertificatesPage.vue";
import OrganizationConsolePage from "./pages/OrganizationConsolePage.vue";
import OrganizationManagementPage from "./pages/OrganizationManagementPage.vue";
import RegistrationManagementPage from "./pages/RegistrationManagementPage.vue";
import RegistrationPage from "./pages/RegistrationPage.vue";
import RegistrationRecordsPage from "./pages/RegistrationRecordsPage.vue";
import SiteContentPage from "./pages/SiteContentPage.vue";
import UserManagementPage from "./pages/UserManagementPage.vue";
import { useSession } from "./state/session.js";

const session = useSession();
const currentUser = session.user;
const restoring = session.restoring;
const eventData = ref({ event: {}, projects: [], grades: [] });
const currentView = ref("login");
const message = ref("");
const certificateRegistrationId = ref("");
const DEEP_LINK_VIEWS = new Set(["overview", "events", "siteContent", "organizations", "registration", "registrationRecords", "records", "certificates", "users", "organization"]);
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const initialParams = new URLSearchParams(window.location.search);
const requestedView = DEEP_LINK_VIEWS.has(initialParams.get("view")) ? initialParams.get("view") : "";
const initialView = requestedView === "records" ? "registrationRecords" : requestedView;
const initialEventId = initialView && SAFE_EVENT_ID.test(initialParams.get("eventId") || "") ? initialParams.get("eventId") : "";
const registrationEventId = ref(initialView === "registration" ? initialEventId : "");
const recordsEventId = ref(initialView === "registrationRecords" ? initialEventId : "");
const certificateEventId = ref(initialView === "certificates" ? initialEventId : "");
const managementEventId = ref(["registration", "registrationRecords"].includes(initialView) ? initialEventId : "");
const selectedRegistrationEvent = ref(null);
const passwordChangeForm = reactive({ currentPassword: "", newPassword: "" });
const roleText = { ordinary: "普通用户", organization: "组织用户", admin: "超级管理员" };

const approvedOrganization = computed(() => (session.organizations.value || []).find((organization) => (
  organization.status === "active"
  && organization.reviewStatus === "approved"
  && ["owner", "manager", undefined].includes(organization.membershipRole)
)));
const adminActive = computed(() => currentView.value === "registration" ? "registrations" : currentView.value);
const userNavigation = computed(() => {
  if (currentUser.value?.type === "ordinary") {
    return [["registration", "报名"], ["registrationRecords", "报名记录"], ["certificates", "证书查询"]];
  }
  if (!approvedOrganization.value) return [["organization", "审核进度"]];
  return [["registration", "报名"], ["registrationRecords", "报名记录"], ["certificates", "证书查询"], ["organization", "组织控制台"]];
});
const userHeaderEvent = computed(() => {
  if (currentView.value !== "registration") return eventData.value.event;
  if (selectedRegistrationEvent.value) {
    const event = selectedRegistrationEvent.value;
    return {
      ...event,
      date: event.date || event.dateLabel || "",
      registrationDeadline: event.registrationDeadline || String(event.registrationEndAt || "").slice(0, 10)
    };
  }
  return registrationEventId.value ? { name: "正在加载目标赛事…", date: "", venue: "", registrationDeadline: "" } : eventData.value.event;
});

function defaultView(user = currentUser.value) {
  if (!user) return "login";
  if (user.type === "admin") return "overview";
  if (user.type === "organization") return "organization";
  return "registration";
}

function targetView(user = currentUser.value) {
  if (!user || !initialView) return defaultView(user);
  if (user.type === "organization" && !approvedOrganization.value) return "organization";
  if (user.type === "admin" && initialView === "registrationRecords") return "registration";
  const allowed = user.type === "admin"
    ? new Set(["overview", "events", "siteContent", "organizations", "registration", "certificates", "users"])
    : user.type === "organization"
      ? new Set(["registration", "registrationRecords", "certificates", "organization"])
      : new Set(["registration", "registrationRecords", "certificates"]);
  return allowed.has(initialView) ? initialView : defaultView(user);
}

async function loadEvent() {
  eventData.value = await api("/api/public/event");
}

async function login(credentials) {
  message.value = "";
  try {
    const user = await session.login(credentials);
    currentView.value = user.mustChangePassword ? "password" : targetView(user);
  } catch (error) {
    message.value = error.message;
  }
}

async function changePassword() {
  message.value = "";
  try {
    const payload = await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(passwordChangeForm) });
    session.setUser(payload.user, session.organizations.value);
    Object.assign(passwordChangeForm, { currentPassword: "", newPassword: "" });
    currentView.value = targetView(payload.user);
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

function navigateAdmin(key) {
  if (key === "registrations") managementEventId.value = "";
  if (key === "certificates") {
    certificateRegistrationId.value = "";
    certificateEventId.value = "";
  }
  currentView.value = key === "registrations" ? "registration" : key;
}

function navigateUser(key) {
  if (key === "registration") registrationEventId.value = "";
  if (key === "registrationRecords") recordsEventId.value = "";
  if (key === "certificates") certificateEventId.value = "";
  currentView.value = key;
}

function openCertificateManagement(registration) {
  certificateRegistrationId.value = registration?.id || "";
  certificateEventId.value = registration?.eventId || "";
  currentView.value = "certificates";
}

function handleError(error) {
  message.value = String(error || "操作失败，请稍后重试");
}

function useRegistrationEvent(event) {
  selectedRegistrationEvent.value = event || null;
}

watch(() => currentUser.value?.type, () => {
  if (currentUser.value && !currentUser.value.mustChangePassword) currentView.value = targetView();
});

watch(approvedOrganization, (organization) => {
  if (currentUser.value?.type !== "organization") return;
  if (!organization) currentView.value = "organization";
});

watch(currentView, (view) => {
  if (view !== "registration") selectedRegistrationEvent.value = null;
});

onMounted(async () => {
  try {
    await loadEvent();
  } catch (error) {
    message.value = error.message;
  }
  await session.restore();
  if (currentUser.value && !currentUser.value.mustChangePassword) currentView.value = targetView();
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

  <AdminShell v-else-if="currentUser.type === 'admin'" :active="adminActive" @navigate="navigateAdmin">
    <template #header><div><strong>{{ currentUser.name }}</strong><span>{{ eventData.event.name || "赛事管理平台" }}</span></div><button type="button" class="ghost" @click="logout">退出登录</button></template>
    <p v-if="message" class="message">{{ message }}</p>
    <DashboardPage v-if="currentView === 'overview'" @navigate="navigateAdmin" />
    <EventManagementPage v-else-if="currentView === 'events'" @event-changed="loadEvent" />
    <SiteContentPage v-else-if="currentView === 'siteContent'" />
    <OrganizationManagementPage v-else-if="currentView === 'organizations'" />
    <RegistrationManagementPage :key="`registration-management:${managementEventId}`" v-else-if="currentView === 'registration'" :initial-event-id="managementEventId" @open-certificates="openCertificateManagement" />
    <CertificateManagementPage :key="`certificate-management:${certificateEventId}:${certificateRegistrationId}`" v-else-if="currentView === 'certificates'" :initial-registration-id="certificateRegistrationId" :initial-event-id="certificateEventId" />
    <UserManagementPage v-else-if="currentView === 'users'" @error="handleError" />
  </AdminShell>

  <div v-else class="shell user-shell" data-testid="user-shell">
    <aside>
      <div class="logo">航</div><h1>赛事报名系统</h1>
      <div class="user-card"><strong>{{ currentUser.name }}</strong><span>{{ roleText[currentUser.type] }} · {{ currentUser.phone }}</span></div>
      <button v-for="item in userNavigation" :key="item[0]" type="button" :class="{ active: currentView === item[0] }" :data-user-nav="item[0]" @click="navigateUser(item[0])">{{ item[1] }}</button>
      <button class="ghost" @click="logout">退出登录</button>
    </aside>
    <main>
      <header class="topbar"><div><h2>{{ userHeaderEvent.name || "赛事报名平台" }}</h2><p>{{ userHeaderEvent.date }} · {{ userHeaderEvent.venue }} · 报名截止 {{ userHeaderEvent.registrationDeadline }}</p></div></header>
      <p v-if="message" class="message">{{ message }}</p>
      <RegistrationPage v-if="currentView === 'registration'" :event-id="registrationEventId" :fallback-context="{ projects: eventData.projects }" @context="useRegistrationEvent" @registered="message = '报名已提交，等待审核'" @error="handleError" />
      <RegistrationRecordsPage :key="`records:${recordsEventId}`" v-else-if="currentView === 'registrationRecords'" :event-id="recordsEventId" @error="handleError" />
      <MyCertificatesPage :key="`certificates:${certificateEventId}`" v-else-if="currentView === 'certificates'" :event-id="certificateEventId" @error="handleError" />
      <OrganizationConsolePage v-else-if="currentView === 'organization'" @error="handleError" />
    </main>
  </div>
</template>
