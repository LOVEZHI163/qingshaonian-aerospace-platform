<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import AdminShell from "./components/AdminShell.vue";
import { ApiError, api } from "./lib/api.js";
import { checkReleaseCompatibility } from "./lib/release.js";
import { recoverReleaseMismatch } from "./lib/release-recovery.js";
import AdminLeaderReviewPage from "./pages/AdminLeaderReviewPage.vue";
import AuthPage from "./pages/AuthPage.vue";
import CertificateManagementPage from "./pages/CertificateManagementPage.vue";
import DashboardPage from "./pages/DashboardPage.vue";
import EventCenterPage from "./pages/EventCenterPage.vue";
import EventManagementPage from "./pages/EventManagementPage.vue";
import MyCertificatesPage from "./pages/MyCertificatesPage.vue";
import MyOrganizationPage from "./pages/MyOrganizationPage.vue";
import OrganizationConsolePage from "./pages/OrganizationConsolePage.vue";
import OrganizationCertificatesPage from "./pages/OrganizationCertificatesPage.vue";
import OrganizationEventWorkspacePage from "./pages/OrganizationEventWorkspacePage.vue";
import OrganizationLeadersPage from "./pages/OrganizationLeadersPage.vue";
import OrganizationManagementPage from "./pages/OrganizationManagementPage.vue";
import OrganizationRegistrationRecordsPage from "./pages/OrganizationRegistrationRecordsPage.vue";
import PasswordSettingsPage from "./pages/PasswordSettingsPage.vue";
import RegistrationManagementPage from "./pages/RegistrationManagementPage.vue";
import RegistrationPage from "./pages/RegistrationPage.vue";
import RegistrationRecordsPage from "./pages/RegistrationRecordsPage.vue";
import SiteContentPage from "./pages/SiteContentPage.vue";
import UserManagementPage from "./pages/UserManagementPage.vue";
import { accessMessage, isOrganizationRestrictionError, organizationAccessFor } from "./state/access.js";
import { useSession } from "./state/session.js";

const session = useSession();
const currentUser = session.user;
const restoring = session.restoring;
const eventData = ref({ event: {}, projects: [], grades: [] });
const currentView = ref("login");
const message = ref("");
const loginMessage = ref("");
const releaseReady = ref(false);
const releaseBlocked = ref(false);
const releaseMessage = ref("");
const userSidebarOpen = ref(false);
const certificateRegistrationId = ref("");
const DEEP_LINK_VIEWS = new Set(["overview", "events", "siteContent", "organizations", "leaders", "registration", "registrationRecords", "organizationRecords", "records", "certificates", "users", "organization", "eventCenter", "organizationWorkspace", "myOrganization", "password", "passwordSettings"]);
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const initialParams = new URLSearchParams(window.location.search);
const requestedView = DEEP_LINK_VIEWS.has(initialParams.get("view")) ? initialParams.get("view") : "";
const initialView = requestedView === "records" ? "registrationRecords" : requestedView;
let initialRoutePending = Boolean(initialView);
const initialEventContext = initialView && SAFE_EVENT_ID.test(initialParams.get("eventId") || initialParams.get("eventSlug") || "")
  ? initialParams.get("eventId") || initialParams.get("eventSlug")
  : "";
const initialEventId = initialEventContext;
const adminEvents = ref([]);
const adminProjects = ref([]);
const adminEventId = ref(initialEventId);
const adminContextMessage = ref("");
let adminEventsRequestSequence = 0;
let publicEventRequestSequence = 0;
let adminContextRefreshSequence = 0;
let adminEventContextGeneration = 0;
const initialContentId = initialView === "siteContent" && SAFE_EVENT_ID.test(initialParams.get("contentId") || "")
  ? initialParams.get("contentId")
  : "";
const registrationEventId = ref(initialView === "registration" ? initialEventId : "");
const recordsEventId = ref(initialView === "registrationRecords" ? initialEventId : "");
const certificateEventId = ref(initialView === "certificates" ? initialEventId : "");
const certificateInitialSection = ref("");
const managementEventId = ref(["registration", "registrationRecords"].includes(initialView) ? initialEventId : "");
const selectedEventId = ref(initialEventId);
const selectedRegistrationEvent = ref(null);
const siteContentPage = ref(null);
const siteContentId = ref(initialContentId);
const roleText = { ordinary: "普通用户", organization: "组织用户", admin: "超级管理员" };
const sessionIdentity = computed(() => currentUser.value ? `${currentUser.value.type || ""}:${currentUser.value.id || ""}` : "");

const accountEvents = computed(() => session.accountEvents?.value || []);
const selectedAccountEvent = computed(() => accountEvents.value.find((row) => row?.event?.id === selectedEventId.value) || null);

const organizationAccess = computed(() => organizationAccessFor(currentUser.value, session.organizations.value));
const adminActive = computed(() => currentView.value === "registration" ? "registrations" : currentView.value);
const userActive = computed(() => {
  if (currentUser.value?.type === "ordinary" && currentView.value === "registration") return "eventCenter";
  if (currentUser.value?.type === "organization" && currentView.value === "organizationWorkspace") return "eventCenter";
  return currentView.value;
});
const userNavigation = computed(() => {
  if (currentUser.value?.type === "ordinary") {
    return [["eventCenter", "赛事中心", "赛"], ["myOrganization", "我的组织", "组"], ["registrationRecords", "报名记录", "录"], ["certificates", "证书查询", "证"], ["password", "修改密码", "密"]];
  }
  if (!organizationAccess.value.operational) {
    return [["organization", "审核进度", "审"], ["passwordSettings", "修改密码", "密"]];
  }
  return [["eventCenter", "赛事工作台", "赛"], ["organizationRecords", "报名记录", "录"], ["organization", "组织与成员", "组"], ["leaders", "领队管理", "领"], ["certificates", "证书查询", "证"], ["password", "修改密码", "密"]];
});
const userHeaderEvent = computed(() => {
  if (currentView.value === "eventCenter") return { name: currentUser.value?.type === "organization" ? "赛事工作台" : "赛事中心", date: "", venue: "", registrationDeadline: "" };
  if (currentView.value === "myOrganization") return { name: "我的组织", date: "", venue: "", registrationDeadline: "" };
  if (currentView.value === "organization") return { name: "组织与成员", date: "", venue: "", registrationDeadline: "" };
  if (currentView.value === "leaders") return { name: "领队管理", date: "", venue: "", registrationDeadline: "" };
  if (currentView.value === "organizationRecords") return { name: "报名记录", date: "", venue: "", registrationDeadline: "" };
  if (currentView.value === "registrationRecords" && !recordsEventId.value) return { name: "报名记录", date: "", venue: "", registrationDeadline: "" };
  if (currentView.value === "certificates" && !certificateEventId.value) return { name: "我的证书", date: "", venue: "", registrationDeadline: "" };
  if (["password", "passwordSettings"].includes(currentView.value)) return { name: "修改密码", date: "", venue: "", registrationDeadline: "" };
  if (selectedAccountEvent.value?.event) {
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
  if (user.type === "organization" && !organizationAccessFor(user, session.organizations.value).operational) return "organization";
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
  if (currentUser.value?.type === "organization" && !organizationAccess.value.operational) {
    if (session.accountEvents) session.accountEvents.value = [];
    return true;
  }
  try {
    await session.loadAccountEvents?.();
    return true;
  } catch (error) {
    if (currentUser.value?.type === "organization" && isOrganizationRestrictionError(error)) {
      await handleOrganizationBusinessError(error);
      return false;
    }
    message.value = error.message || "赛事列表加载失败，请稍后重试";
    return false;
  }
}

function invalidateAdminEventContextRequests({ clearContext = false, clearMessages = false } = {}) {
  adminEventContextGeneration += 1;
  adminEventsRequestSequence += 1;
  publicEventRequestSequence += 1;
  adminContextRefreshSequence += 1;
  if (clearMessages) {
    message.value = "";
    loginMessage.value = "";
    adminContextMessage.value = "";
  }
  if (clearContext) {
    adminEvents.value = [];
    adminProjects.value = [];
    setAdminEventId("");
    const url = new URL(window.location.href);
    const hadEventContext = url.searchParams.has("eventId") || url.searchParams.has("eventSlug");
    url.searchParams.delete("eventId");
    url.searchParams.delete("eventSlug");
    if (hadEventContext) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

async function loadAdminEvents({ reconcileSelection = true } = {}) {
  if (currentUser.value?.type !== "admin") return { applied: false, skipped: true };
  const contextGeneration = adminEventContextGeneration;
  const requestSequence = ++adminEventsRequestSequence;
  try {
    const payload = await api("/api/admin/events");
    if (contextGeneration !== adminEventContextGeneration || requestSequence !== adminEventsRequestSequence) return { applied: false, stale: true };
    adminEvents.value = payload.rows || [];
    adminProjects.value = payload.projects || [];
    if (reconcileSelection && adminEventId.value && !adminEvents.value.some((event) => event.id === adminEventId.value)) setAdminEventId("");
    return { applied: true };
  } catch (error) {
    if (contextGeneration !== adminEventContextGeneration || requestSequence !== adminEventsRequestSequence) return { applied: false, stale: true };
    throw error;
  }
}

async function loadAdminEventsSafely() {
  try {
    return await loadAdminEvents();
  } catch {
    message.value = "管理员赛事目录加载失败，请稍后重试";
    return { applied: false, failed: true };
  }
}

function setAdminEventId(eventId) {
  adminEventId.value = eventId || "";
  certificateRegistrationId.value = "";
}

function targetView(user = currentUser.value) {
  const routeView = initialRoutePending ? initialView : "";
  initialRoutePending = false;
  if (!user || !routeView) return defaultView(user);
  const access = organizationAccessFor(user, session.organizations.value);
  if (user.type === "organization" && !access.operational) {
    selectEventContext("");
    return ["password", "passwordSettings"].includes(routeView) ? "passwordSettings" : "organization";
  }
  if (user.type === "organization" && routeView === "organizationWorkspace") {
    if (!initialEventId) return "eventCenter";
    selectEventContext(initialEventId);
    return "organizationWorkspace";
  }
  if (user.type === "organization" && routeView === "certificates") {
    selectEventContext("");
    return "certificates";
  }
  if (user.type === "ordinary" && routeView === "certificates") {
    restoreCertificateEventContext();
    return "certificates";
  }
  if (user.type !== "admin" && ["registration", "registrationRecords", "organizationWorkspace"].includes(routeView) && !restoreAccountEventContext()) {
    message.value = "赛事链接无效或暂无访问权限";
    return "eventCenter";
  }
  if (user.type === "admin" && routeView === "registrationRecords") return "registration";
  const allowed = user.type === "admin"
    ? new Set(["overview", "events", "siteContent", "organizations", "leaders", "registration", "certificates", "users"])
    : user.type === "organization"
      ? new Set(["eventCenter", "organizationWorkspace", "organizationRecords", "certificates", "organization", "leaders", "password"])
      : new Set(["eventCenter", "registration", "registrationRecords", "certificates", "myOrganization", "password"]);
  if (user.type === "organization") return new Set(["eventCenter", "organizationWorkspace", "organizationRecords", "certificates", "organization", "leaders", "password"]).has(routeView)
    ? routeView
    : defaultView(user);
  return allowed.has(routeView) ? routeView : defaultView(user);
}

async function loadEvent() {
  const contextGeneration = adminEventContextGeneration;
  const requestSequence = ++publicEventRequestSequence;
  try {
    const payload = await api("/api/public/event");
    if (contextGeneration !== adminEventContextGeneration || requestSequence !== publicEventRequestSequence) return { applied: false, stale: true };
    eventData.value = payload;
    return { applied: true };
  } catch (error) {
    if (contextGeneration !== adminEventContextGeneration || requestSequence !== publicEventRequestSequence) return { applied: false, stale: true };
    throw error;
  }
}

async function refreshAdminEventContext() {
  const contextGeneration = adminEventContextGeneration;
  const refreshSequence = ++adminContextRefreshSequence;
  const [publicResult, adminResult] = await Promise.allSettled([
    loadEvent(),
    loadAdminEvents({ reconcileSelection: false })
  ]);
  if (contextGeneration !== adminEventContextGeneration || refreshSequence !== adminContextRefreshSequence) return;

  const publicFailed = publicResult.status === "rejected";
  const adminFailed = adminResult.status === "rejected";
  const adminApplied = adminResult.status === "fulfilled" && adminResult.value?.applied;

  if (adminApplied && adminEventId.value && !adminEvents.value.some((event) => event.id === adminEventId.value)) {
    setAdminEventId("");
  }

  if (publicFailed && adminFailed) {
    adminContextMessage.value = "赛事上下文刷新失败，已保留上次内容和当前赛事选择，请稍后重试。";
  } else if (adminFailed) {
    adminContextMessage.value = "管理员赛事目录刷新失败，已保留当前赛事选择，请稍后重试。";
  } else if (publicFailed) {
    adminContextMessage.value = "公开赛事信息刷新失败，已保留上次显示内容；赛事目录已更新。";
  } else {
    adminContextMessage.value = "";
  }
}

async function verifyRelease() {
  try {
    const result = await checkReleaseCompatibility(api, import.meta.env.VITE_RELEASE_SHA);
    if (!result.compatible && recoverReleaseMismatch(result.apiRelease)) {
      releaseBlocked.value = true;
      releaseMessage.value = "正在加载最新版本…";
      return;
    }
    releaseBlocked.value = !result.compatible;
    releaseMessage.value = releaseBlocked.value ? "系统版本不一致，请刷新页面或联系管理员" : "";
  } catch (error) {
    releaseBlocked.value = true;
    releaseMessage.value = error instanceof ApiError
      ? error.message
      : "无法检查系统版本，请刷新页面后重试";
  } finally {
    releaseReady.value = true;
  }
}

async function login(credentials) {
  invalidateAdminEventContextRequests({ clearMessages: true });
  try {
    const user = await session.login(credentials);
    invalidateAdminEventContextRequests({ clearMessages: true });
    await loadAccountEvents();
    await loadAdminEventsSafely();
    currentView.value = user.mustChangePassword ? "password" : targetView(user);
  } catch (error) {
    loginMessage.value = error?.message || "登录失败，请稍后重试";
  }
}

async function passwordChanged(user) {
  const wasForced = Boolean(currentUser.value?.mustChangePassword);
  session.setUser(user, session.organizations.value);
  if (wasForced) {
    await loadAccountEvents();
    await loadAdminEventsSafely();
    currentView.value = targetView(user);
  }
}

async function performLogout() {
  invalidateAdminEventContextRequests({ clearContext: true, clearMessages: true });
  await session.logout();
  initialRoutePending = false;
  selectEventContext("");
  currentView.value = "login";
  message.value = "";
  loginMessage.value = "";
  adminContextMessage.value = "";
  const url = new URL(window.location.href);
  ["view", "eventId", "eventSlug", "contentId", "panel"].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
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

function navigateAdmin(key, section = "") {
  if (key === "certificates") certificateInitialSection.value = section;
  requestSiteContentLeave(() => commitAdminNavigation(key));
}

function navigateUser(key) {
  userSidebarOpen.value = false;
  message.value = "";
  if (currentUser.value?.type === "organization" && !organizationAccess.value.operational) {
    selectEventContext("");
    currentView.value = ["password", "passwordSettings"].includes(key) ? "passwordSettings" : "organization";
    return;
  }
  if (key === "eventCenter") selectEventContext("");
  if ((currentUser.value?.type === "ordinary" && ["registrationRecords", "certificates"].includes(key))
    || (currentUser.value?.type === "organization" && key === "certificates")) selectEventContext("");
  if (currentUser.value?.type === "ordinary" && key === "registration" && !selectedEventId.value) {
    currentView.value = "eventCenter";
    message.value = "请先在赛事中心选择赛事";
    return;
  }
  currentView.value = key;
}

function setCertificateEventId(eventId) {
  if (!eventId) {
    certificateEventId.value = "";
    return;
  }
  if (!SAFE_EVENT_ID.test(eventId)) return;
  if (certificateEventId.value === eventId && !selectedEventId.value) return;
  if (eventId !== selectedEventId.value) {
    selectedEventId.value = "";
    registrationEventId.value = "";
    recordsEventId.value = "";
  }
  certificateEventId.value = eventId;
}

function openAccountEvent({ eventId, mode }) {
  if (currentUser.value?.type === "organization" && !organizationAccess.value.operational) {
    selectEventContext("");
    currentView.value = "organization";
    return;
  }
  const resolvedEventId = resolveAccountEventId(eventId);
  const expectedMode = currentUser.value?.type === "organization" ? "organizationWorkspace" : "registration";
  if (!resolvedEventId || mode !== expectedMode) {
    selectEventContext("");
    currentView.value = "eventCenter";
    message.value = "赛事链接无效或暂无访问权限";
    return;
  }
  message.value = "";
  selectEventContext(resolvedEventId);
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

async function refreshPersonalOrganization() {
  await session.restore();
  await loadAccountEvents();
}

async function handleOrganizationBusinessError(error) {
  if (currentUser.value?.type === "organization" && isOrganizationRestrictionError(error)) {
    const deniedMessage = accessMessage(error, "当前组织暂时无法使用该功能");
    selectEventContext("");
    await session.restore();
    currentView.value = "organization";
    message.value = deniedMessage;
    return;
  }
  if ([403, 404].includes(error?.status) && currentView.value === "organizationWorkspace") {
    selectEventContext("");
    currentView.value = "eventCenter";
  }
  handleError(accessMessage(error, "组织业务操作失败，请稍后重试"));
}

function useRegistrationEvent(event) {
  selectedRegistrationEvent.value = event || null;
}

watch(organizationAccess, (access) => {
  if (currentUser.value?.type !== "organization") return;
  if (!access.operational && !["organization", "passwordSettings"].includes(currentView.value)) {
    selectEventContext("");
    currentView.value = "organization";
  }
});

watch(sessionIdentity, (identity, previousIdentity) => {
  if (identity === previousIdentity) return;
  invalidateAdminEventContextRequests({
    clearContext: !identity || Boolean(previousIdentity),
    clearMessages: true
  });
}, { flush: "sync" });

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
    if (view !== "overview") url.searchParams.delete("panel");
  } else {
    url.searchParams.delete("contentId");
    url.searchParams.delete("eventSlug");
    url.searchParams.delete("panel");
    const visibleEventId = view === "certificates"
      ? certificateId
      : ["registration", "registrationRecords", "organizationWorkspace"].includes(view) ? eventId : "";
    if (visibleEventId) url.searchParams.set("eventId", visibleEventId);
    else url.searchParams.delete("eventId");
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}, { flush: "post" });

onMounted(async () => {
  await verifyRelease();
  if (releaseBlocked.value) return;
  try {
    await loadEvent();
  } catch (error) {
    message.value = error.message;
  }
  await session.restore();
  if (currentUser.value && !currentUser.value.mustChangePassword) {
    await loadAccountEvents();
    await loadAdminEventsSafely();
    currentView.value = targetView();
  }
});
</script>

<template>
  <div v-if="!releaseReady" class="app-loading">正在检查系统版本…</div>

  <section v-else-if="releaseBlocked" class="auth-shell release-blocked-shell" role="alert">
    <div class="panel auth-panel">
      <h3>系统版本检查失败</h3>
      <p class="message">{{ releaseMessage }}</p>
    </div>
  </section>

  <div v-else-if="restoring" class="app-loading">正在恢复登录状态…</div>

  <AuthPage v-else-if="!currentUser" :event-name="eventData.event.name" :login-error="loginMessage" @login="login" @clear-message="loginMessage = ''" />

  <section v-else-if="currentUser.mustChangePassword" class="auth-shell force-password-shell">
    <PasswordSettingsPage forced @changed="passwordChanged" @logout="logout" />
  </section>

  <AdminShell v-else-if="currentUser.type === 'admin'" :active="adminActive" @navigate="navigateAdmin">
    <template #header><div><strong>{{ currentUser.name }}</strong><span>{{ eventData.event.name || "赛事管理平台" }}</span></div></template>
    <template #sidebar-footer><button type="button" class="ghost admin-logout-button" data-action="logout" aria-label="退出登录" title="退出登录" @click="logout"><span class="admin-nav-label">退出登录</span></button></template>
    <p v-if="message" class="message">{{ message }}</p>
    <p v-if="adminContextMessage" class="message">{{ adminContextMessage }}</p>
    <DashboardPage v-if="currentView === 'overview'" :event-id="adminEventId" :events="adminEvents" @update:event-id="setAdminEventId" @navigate="navigateAdmin" />
    <EventManagementPage v-else-if="currentView === 'events'" :events="adminEvents" :projects="adminProjects" @event-changed="refreshAdminEventContext" />
    <SiteContentPage v-else-if="currentView === 'siteContent'" ref="siteContentPage" :initial-content-id="siteContentId" @content-id="siteContentId = $event || ''" @navigate="navigateAdmin" />
    <OrganizationManagementPage v-else-if="currentView === 'organizations'" />
    <AdminLeaderReviewPage v-else-if="currentView === 'leaders'" />
    <RegistrationManagementPage :key="`registration-management:${adminEventId}`" v-else-if="currentView === 'registration'" :event-id="adminEventId" :event-archived="adminEvents.find((event) => event.id === adminEventId)?.status === 'archived'" @open-certificates="openCertificateManagement" />
    <CertificateManagementPage :key="`certificate-management:${adminEventId}:${certificateRegistrationId}:${certificateInitialSection}`" v-else-if="currentView === 'certificates'" :event-id="adminEventId" :initial-registration-id="certificateRegistrationId" :initial-section="certificateInitialSection" />
    <UserManagementPage v-else-if="currentView === 'users'" @error="handleError" />
  </AdminShell>

  <div v-else class="shell user-shell" :class="{ 'user-sidebar-mobile-open': userSidebarOpen }" data-testid="user-shell">
    <button v-if="userSidebarOpen" type="button" class="user-sidebar-backdrop" aria-label="关闭导航" @click="userSidebarOpen = false" />
    <aside id="user-sidebar" class="user-sidebar">
      <div class="user-brand"><span class="user-brand-mark"><img :src="'/brand/mark.svg'" alt="温州市青少年航空航天创新比赛 Logo" /></span><h1>赛事报名系统</h1></div>
      <div class="user-card"><strong>{{ currentUser.name }}</strong><span>{{ roleText[currentUser.type] }} · {{ currentUser.phone }}</span></div>
      <nav aria-label="用户导航">
        <button v-for="item in userNavigation" :key="item[0]" type="button" :class="{ active: userActive === item[0] }" :data-user-nav="item[0]" :aria-label="item[1]" :title="item[1]" @click="navigateUser(item[0])"><span class="user-nav-icon" aria-hidden="true">{{ item[2] }}</span><span class="user-nav-label">{{ item[1] }}</span></button>
        <button class="ghost user-logout-button" aria-label="退出登录" title="退出登录" @click="logout"><span class="user-nav-icon" aria-hidden="true">退</span><span class="user-nav-label">退出登录</span></button>
      </nav>
    </aside>
    <main>
      <header class="topbar">
        <button type="button" class="user-sidebar-mobile-trigger" aria-controls="user-sidebar" :aria-expanded="userSidebarOpen" aria-label="打开用户导航" @click="userSidebarOpen = true">☰</button>
        <div><h2>{{ userHeaderEvent.name || "赛事报名平台" }}</h2><p>{{ userHeaderEvent.date }} · {{ userHeaderEvent.venue }} · 报名截止 {{ userHeaderEvent.registrationDeadline }}</p></div>
      </header>
      <p v-if="message" class="message">{{ message }}</p>
      <EventCenterPage v-if="currentView === 'eventCenter'" :account-type="currentUser.type" @open-event="openAccountEvent" @access-denied="handleOrganizationBusinessError" />
      <RegistrationPage v-else-if="currentUser.type === 'ordinary' && currentView === 'registration'" :event-id="registrationEventId" :account-type="currentUser.type" :registration-state="selectedAccountEvent?.registrationState || ''" :fallback-context="{ projects: eventData.projects }" @context="useRegistrationEvent" @registered="message = '报名已提交，等待审核'" @navigate="navigateUser" @error="handleError" />
      <MyOrganizationPage v-else-if="currentView === 'myOrganization'" @organization-changed="refreshPersonalOrganization" @error="handleError" />
      <RegistrationRecordsPage :key="`records:${recordsEventId}`" v-else-if="currentView === 'registrationRecords'" :event-id="recordsEventId" @error="handleError" />
      <OrganizationCertificatesPage v-else-if="currentUser.type === 'organization' && currentView === 'certificates'" @access-denied="handleOrganizationBusinessError" />
      <MyCertificatesPage :key="`certificates:${certificateEventId}`" v-else-if="currentView === 'certificates'" :event-id="certificateEventId" @event-id="setCertificateEventId" @error="handleError" />
      <OrganizationEventWorkspacePage v-else-if="currentView === 'organizationWorkspace'" :event-id="selectedEventId" @back-to-events="navigateUser('eventCenter')" @context="useRegistrationEvent" @access-denied="handleOrganizationBusinessError" @error="handleOrganizationBusinessError" />
      <OrganizationRegistrationRecordsPage v-else-if="currentView === 'organizationRecords'" @back-to-events="navigateUser('eventCenter')" @access-denied="handleOrganizationBusinessError" />
      <OrganizationConsolePage v-else-if="currentView === 'organization'" @error="handleOrganizationBusinessError" />
      <OrganizationLeadersPage v-else-if="currentUser.type === 'organization' && currentView === 'leaders'" />
      <PasswordSettingsPage v-else-if="['password', 'passwordSettings'].includes(currentView)" @changed="passwordChanged" />
    </main>
  </div>
</template>
