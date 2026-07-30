<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import AdminShell from "./components/AdminShell.vue";
import { api } from "./lib/api.js";
import AuthPage from "./pages/AuthPage.vue";
import CertificateManagementPage from "./pages/CertificateManagementPage.vue";
import DashboardPage from "./pages/DashboardPage.vue";
import EventCenterPage from "./pages/EventCenterPage.vue";
import EventManagementPage from "./pages/EventManagementPage.vue";
import MyCertificatesPage from "./pages/MyCertificatesPage.vue";
import OrganizationConsolePage from "./pages/OrganizationConsolePage.vue";
import OrganizationEventWorkspacePage from "./pages/OrganizationEventWorkspacePage.vue";
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
const DEEP_LINK_VIEWS = new Set(["overview", "events", "siteContent", "organizations", "registration", "registrationRecords", "records", "certificates", "users", "organization", "eventCenter", "organizationWorkspace"]);
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const initialParams = new URLSearchParams(window.location.search);
const requestedView = DEEP_LINK_VIEWS.has(initialParams.get("view")) ? initialParams.get("view") : "";
const initialView = requestedView === "records" ? "registrationRecords" : requestedView;
const initialEventContext = initialView && SAFE_EVENT_ID.test(initialParams.get("eventId") || initialParams.get("eventSlug") || "")
  ? initialParams.get("eventId") || initialParams.get("eventSlug")
  : "";
const initialEventId = initialEventContext;
const adminEvents = ref([]);
const adminEventId = ref(initialEventId);
const initialContentId = initialView === "siteContent" && SAFE_EVENT_ID.test(initialParams.get("contentId") || "")
  ? initialParams.get("contentId")
  : "";
const registrationEventId = ref(initialView === "registration" ? initialEventId : "");
const recordsEventId = ref(initialView === "registrationRecords" ? initialEventId : "");
const certificateEventId = ref(initialView === "certificates" ? initialEventId : "");
const managementEventId = ref(["registration", "registrationRecords"].includes(initialView) ? initialEventId : "");
const selectedEventId = ref(initialEventId);
const selectedRegistrationEvent = ref(null);
const siteContentPage = ref(null);
const siteContentId = ref(initialContentId);
const passwordChangeForm = reactive({ currentPassword: "", newPassword: "" });
const roleText = { ordinary: "普通用户", organization: "组织用户", admin: "超级管理员" };

const accountEvents = computed(() => session.accountEvents?.value || []);
const selectedAccountEvent = computed(() => accountEvents.value.find((row) => row?.event?.id === selectedEventId.value) || null);

const approvedOrganization = computed(() => (session.organizations.value || []).find((organization) => (
  organization.status === "active"
  && organization.reviewStatus === "approved"
  && organization.ownerUserId === currentUser.value?.id
)));
const adminActive = computed(() => currentView.value === "registration" ? "registrations" : currentView.value);
const userNavigation = computed(() => {
  if (currentUser.value?.type === "ordinary") {
    const navigation = [["eventCenter", "赛事中心"]];
    if (selectedEventId.value) navigation.push(["registration", "报名"], ["registrationRecords", "当前报名"]);
    navigation.push(["certificates", "证书查询"]);
    return navigation;
  }
  if (!approvedOrganization.value) return [["eventCenter", "赛事中心"], ["organization", "审核进度"]];
  return [["eventCenter", "赛事中心"], ["organizationWorkspace", "赛事工作台"], ["organization", "组织与成员"], ["certificates", "历史证书"]];
});
const userHeaderEvent = computed(() => {
  if (currentView.value === "eventCenter") return { name: "赛事中心", date: "", venue: "", registrationDeadline: "" };
  if (currentUser.value?.type === "ordinary" && currentView.value === "certificates" && certificateEventId.value && certificateEventId.value !== selectedEventId.value) {
    return { name: "历史赛事证书查询", date: "", venue: "", registrationDeadline: "" };
  }
  if (currentUser.value?.type === "ordinary" && selectedAccountEvent.value?.event) {
    const event = selectedAccountEvent.value.event;
    return {
      ...event,
      date: event.date || event.dateLabel || "",
      registrationDeadline: event.registrationDeadline || String(event.registrationEndAt || "").slice(0, 10)
    };
  }
  if (currentView.value !== "registration" && currentView.value !== "organizationWorkspace") return eventData.value.event;
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
  return "eventCenter";
}

function resolveAccountEventId(value) {
  if (!value) return "";
  const row = accountEvents.value.find((item) => item?.event?.id === value || item?.event?.slug === value);
  return row?.event?.id || "";
}

function selectEventContext(eventId) {
  const validEventId = eventId || "";
  selectedEventId.value = validEventId;
  registrationEventId.value = validEventId;
  recordsEventId.value = validEventId;
  certificateEventId.value = validEventId;
  managementEventId.value = validEventId;
}

function restoreAccountEventContext() {
  if (!initialEventContext) return true;
  if (!session.accountEvents) return true;
  const resolvedEventId = resolveAccountEventId(initialEventContext);
  if (!resolvedEventId) {
    selectEventContext("");
    return false;
  }
  selectEventContext(resolvedEventId);
  return true;
}

function restoreCertificateEventContext() {
  const resolvedEventId = resolveAccountEventId(initialEventContext);
  if (resolvedEventId) {
    selectEventContext(resolvedEventId);
    return;
  }
  selectedEventId.value = "";
  registrationEventId.value = "";
  recordsEventId.value = "";
  certificateEventId.value = initialEventId;
}

async function loadAccountEvents() {
  try {
    await session.loadAccountEvents?.();
    return true;
  } catch (error) {
    message.value = error.message || "赛事列表加载失败，请稍后重试";
    return false;
  }
}

async function loadAdminEvents() {
  if (currentUser.value?.type !== "admin") return;
  try {
    const payload = await api("/api/admin/events");
    adminEvents.value = payload.rows || [];
    if (adminEventId.value && !adminEvents.value.some((event) => event.id === adminEventId.value)) adminEventId.value = "";
  } catch (error) {
    message.value = error.message || "赛事列表加载失败，请稍后重试";
  }
}

function setAdminEventId(eventId) {
  adminEventId.value = eventId || "";
  certificateRegistrationId.value = "";
}

function targetView(user = currentUser.value) {
  if (!user || !initialView) return defaultView(user);
  if (user.type === "organization" && initialView === "organizationWorkspace") {
    if (!initialEventId) return "eventCenter";
    selectEventContext(initialEventId);
    return "organizationWorkspace";
  }
  if (user.type === "ordinary" && initialView === "certificates") {
    restoreCertificateEventContext();
    return "certificates";
  }
  if (user.type !== "admin" && ["registration", "registrationRecords", "organizationWorkspace"].includes(initialView) && !restoreAccountEventContext()) {
    message.value = "赛事链接无效或暂无访问权限";
    return "eventCenter";
  }
  if (user.type === "admin" && initialView === "registrationRecords") return "registration";
  const allowed = user.type === "admin"
    ? new Set(["overview", "events", "siteContent", "organizations", "registration", "certificates", "users"])
    : user.type === "organization"
      ? new Set(["eventCenter", "organizationWorkspace", "certificates", "organization"])
      : new Set(["eventCenter", "registration", "registrationRecords", "certificates"]);
  if (user.type === "organization") return new Set(["eventCenter", "organizationWorkspace", "certificates", "organization"]).has(initialView)
    ? initialView
    : defaultView(user);
  return allowed.has(initialView) ? initialView : defaultView(user);
}

async function loadEvent() {
  eventData.value = await api("/api/public/event");
}

async function login(credentials) {
  message.value = "";
  try {
    const user = await session.login(credentials);
    await loadAccountEvents();
    await loadAdminEvents();
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
    await loadAccountEvents();
    await loadAdminEvents();
    currentView.value = targetView(payload.user);
    message.value = "密码修改成功";
  } catch (error) {
    message.value = error.message;
  }
}

async function performLogout() {
  await session.logout();
  currentView.value = "login";
  message.value = "";
}

function requestSiteContentLeave(callback) {
  if (currentView.value === "siteContent" && siteContentPage.value) {
    siteContentPage.value.requestLeave(callback);
    return;
  }
  callback();
}

function logout() {
  if (currentUser.value?.type === "admin") {
    requestSiteContentLeave(() => { void performLogout(); });
    return;
  }
  void performLogout();
}

function commitAdminNavigation(key) {
  if (key !== "certificates") certificateRegistrationId.value = "";
  if (key !== "siteContent") siteContentId.value = "";
  currentView.value = key === "registrations" ? "registration" : key;
}

function navigateAdmin(key) {
  requestSiteContentLeave(() => commitAdminNavigation(key));
}

function navigateUser(key) {
  if (key === "eventCenter") selectEventContext("");
  if (currentUser.value?.type === "ordinary" && ["registration", "registrationRecords"].includes(key) && !selectedEventId.value) {
    currentView.value = "eventCenter";
    return;
  }
  currentView.value = key;
}

function setCertificateEventId(eventId) {
  if (!SAFE_EVENT_ID.test(eventId || "")) return;
  if (certificateEventId.value === eventId && !selectedEventId.value) return;
  if (eventId !== selectedEventId.value) {
    selectedEventId.value = "";
    registrationEventId.value = "";
    recordsEventId.value = "";
  }
  certificateEventId.value = eventId;
}

function openAccountEvent({ eventId, mode }) {
  selectEventContext(eventId);
  currentView.value = mode;
}

function openCertificateManagement(registration) {
  if (!registration?.eventId || registration.eventId !== adminEventId.value) {
    message.value = "报名与当前赛事不一致，请重新选择赛事后再管理证书";
    return;
  }
  certificateRegistrationId.value = registration?.id || "";
  currentView.value = "certificates";
}

function handleError(error) {
  message.value = String(error || "操作失败，请稍后重试");
}

function handleWorkspaceAccessDenied(error) {
  selectEventContext("");
  currentView.value = "eventCenter";
  handleError(error?.message || "无权访问该赛事工作台");
}

function useRegistrationEvent(event) {
  selectedRegistrationEvent.value = event || null;
}

watch(() => currentUser.value?.type, () => {
  if (currentUser.value && !currentUser.value.mustChangePassword) currentView.value = targetView();
});

watch(approvedOrganization, (organization) => {
  if (currentUser.value?.type !== "organization") return;
  if (!organization && currentView.value !== "eventCenter") currentView.value = "organization";
});

watch(currentView, (view) => {
  if (!["registration", "organizationWorkspace"].includes(view)) selectedRegistrationEvent.value = null;
});

watch([currentView, selectedEventId, certificateEventId, siteContentId, adminEventId, () => currentUser.value?.type], ([view, eventId, certificateId, contentId, _adminEvent, userType]) => {
  if (!userType || !DEEP_LINK_VIEWS.has(view)) return;
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  if (userType === "admin") {
    if (view === "siteContent" && contentId) url.searchParams.set("contentId", contentId);
    else url.searchParams.delete("contentId");
    if (["overview", "registration", "certificates"].includes(view) && adminEventId.value) url.searchParams.set("eventId", adminEventId.value);
    else url.searchParams.delete("eventId");
  } else {
    url.searchParams.delete("contentId");
    url.searchParams.delete("eventSlug");
    const visibleEventId = view === "certificates" ? certificateId : eventId;
    if (visibleEventId) url.searchParams.set("eventId", visibleEventId);
    else url.searchParams.delete("eventId");
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}, { flush: "post" });

onMounted(async () => {
  try {
    await loadEvent();
  } catch (error) {
    message.value = error.message;
  }
  await session.restore();
  if (currentUser.value && !currentUser.value.mustChangePassword) {
    await loadAccountEvents();
    await loadAdminEvents();
    currentView.value = targetView();
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

  <AdminShell v-else-if="currentUser.type === 'admin'" :active="adminActive" :events="adminEvents" :event-id="adminEventId" @update:event-id="setAdminEventId" @navigate="navigateAdmin">
    <template #header><div><strong>{{ currentUser.name }}</strong><span>{{ eventData.event.name || "赛事管理平台" }}</span></div><button type="button" class="ghost" data-action="logout" @click="logout">退出登录</button></template>
    <p v-if="message" class="message">{{ message }}</p>
    <DashboardPage v-if="currentView === 'overview'" :event-id="adminEventId" @navigate="navigateAdmin" />
    <EventManagementPage v-else-if="currentView === 'events'" @event-changed="loadEvent" />
    <SiteContentPage v-else-if="currentView === 'siteContent'" ref="siteContentPage" :initial-content-id="siteContentId" @content-id="siteContentId = $event || ''" @navigate="navigateAdmin" />
    <OrganizationManagementPage v-else-if="currentView === 'organizations'" />
    <RegistrationManagementPage :key="`registration-management:${adminEventId}`" v-else-if="currentView === 'registration'" :event-id="adminEventId" :event-archived="adminEvents.find((event) => event.id === adminEventId)?.status === 'archived'" @open-certificates="openCertificateManagement" />
    <CertificateManagementPage :key="`certificate-management:${adminEventId}:${certificateRegistrationId}`" v-else-if="currentView === 'certificates'" :event-id="adminEventId" :initial-registration-id="certificateRegistrationId" />
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
      <EventCenterPage v-if="currentView === 'eventCenter'" :account-type="currentUser.type" @open-event="openAccountEvent" />
      <RegistrationPage v-if="currentUser.type === 'ordinary' && currentView === 'registration'" :event-id="registrationEventId" :account-type="currentUser.type" :event-organizations="selectedAccountEvent?.organizations || []" :registration-state="selectedAccountEvent?.registrationState || ''" :fallback-context="{ projects: eventData.projects }" @context="useRegistrationEvent" @registered="message = '报名已提交，等待审核'" @error="handleError" />
      <RegistrationRecordsPage :key="`records:${recordsEventId}`" v-else-if="currentView === 'registrationRecords'" :event-id="recordsEventId" @error="handleError" />
      <MyCertificatesPage v-else-if="currentView === 'certificates'" :event-id="certificateEventId" @event-id="setCertificateEventId" @error="handleError" />
      <OrganizationEventWorkspacePage v-else-if="currentView === 'organizationWorkspace'" :event-id="selectedEventId" @context="useRegistrationEvent" @access-denied="handleWorkspaceAccessDenied" @error="handleError" />
      <OrganizationConsolePage v-else-if="currentView === 'organization'" @error="handleError" />
    </main>
  </div>
</template>
