<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import SchoolCombobox from "../components/SchoolCombobox.vue";
import { api } from "../lib/api.js";

const props = defineProps({
  eventId: { type: String, default: "" },
  accountType: { type: String, default: "legacy" },
  eventOrganizations: { type: Array, default: () => [] },
  registrationState: { type: String, default: "" },
  fallbackContext: { type: Object, default: () => ({}) }
});
const emit = defineEmits(["context", "registered", "error"]);
const context = ref({ organizations: [], projects: [], grades: [] });
const loading = ref(true);
const form = reactive({ eventId: props.eventId, organizationId: "", athlete: { name: "", school: "", grade: "", phone: "" }, projectId: "", instructor: "" });
const ordinaryUser = computed(() => props.accountType === "ordinary");
const hasEventContext = computed(() => Boolean(String(props.eventId || "").trim()));
const registrationOpen = computed(() => !ordinaryUser.value || props.registrationState === "" || props.registrationState === "open");
const registrationStateMessage = computed(() => props.registrationState === "not_started" ? "本赛事报名尚未开始，请留意开放时间。" : "本赛事报名已截止，暂不能新增或修改报名。" );
const GRADE_GROUPS = [
  { id: "primary_lower", name: "小学低段", grades: ["一年级", "二年级", "三年级"] },
  { id: "primary_upper", name: "小学高段", grades: ["四年级", "五年级", "六年级"] },
  { id: "middle_school", name: "中学组", grades: ["初一", "初二", "初三"] },
  { id: "high_vocational", name: "职高/高中组", grades: ["高一", "高二", "高三", "职高一年级", "职高二年级", "职高三年级"] }
];
const selectedGroup = computed(() => (context.value.grades || []).find((item) => item.grades?.includes(form.athlete.grade))?.name || "");
const eligibleProjects = computed(() => (context.value.projects || []).filter((project) => selectedGroup.value && (!project.allowedGroups || project.allowedGroups.includes(selectedGroup.value))));
const organizations = computed(() => (context.value.organizations || []).map((organization) => {
  const eventOrganization = (props.eventOrganizations || []).find((item) => item?.organization?.id === organization.id || item?.id === organization.id);
  return {
    ...organization,
    organizationJoined: ordinaryUser.value
      ? eventOrganization?.organizationJoined === true || organization.organizationJoined === true
      : true
  };
}));
const selectedOrganization = computed(() => organizations.value.find((item) => item.id === form.organizationId));
const organizationAvailable = (organization) => !ordinaryUser.value || organization?.organizationJoined === true;

function applyOrganization() {
  if (selectedOrganization.value && organizationAvailable(selectedOrganization.value)) form.athlete.school = selectedOrganization.value.name;
}
watch(() => form.organizationId, applyOrganization);
watch(eligibleProjects, (projects) => { if (!projects.some((project) => project.id === form.projectId)) form.projectId = projects[0]?.id || ""; });
watch(() => [form.athlete.name, form.athlete.school, form.athlete.grade, form.athlete.phone, form.projectId], async () => {
  if (ordinaryUser.value) return;
  if (!form.athlete.name || !form.athlete.school || !form.athlete.grade || !form.athlete.phone || !form.projectId) return;
  try { await api("/api/registrations/check", { method: "POST", body: JSON.stringify({ eventId: form.eventId, athlete: form.athlete, projectId: form.projectId, group: selectedGroup.value }) }); } catch { /* Submission remains the authoritative validation. */ }
});

async function submit() {
  if (!hasEventContext.value) {
    emit("error", "请先从赛事中心选择赛事");
    return;
  }
  if (!registrationOpen.value) {
    emit("error", registrationStateMessage.value);
    return;
  }
  if (selectedOrganization.value && !organizationAvailable(selectedOrganization.value)) {
    emit("error", "该组织尚未加入本赛事，暂不能关联组织");
    return;
  }
  try {
    const payload = {
      organizationId: form.organizationId || null,
      athlete: form.athlete,
      projectId: form.projectId,
      instructor: form.instructor
    };
    if (ordinaryUser.value) {
      await api(`/api/me/events/${encodeURIComponent(props.eventId)}/registrations`, { method: "POST", body: JSON.stringify(payload) });
    } else {
      await api("/api/registrations", { method: "POST", body: JSON.stringify({ ...payload, eventId: form.eventId }) });
    }
    Object.assign(form.athlete, { name: "", school: selectedOrganization.value?.name || "", grade: "", phone: "" });
    form.instructor = "";
    emit("registered");
  } catch (error) { emit("error", error.message); }
}

onMounted(async () => {
  if (!hasEventContext.value) {
    loading.value = false;
    return;
  }
  try {
    const query = props.eventId ? `?eventId=${encodeURIComponent(props.eventId)}` : "";
    const payload = await api(`/api/me/registration-context${query}`);
    const hasContext = Array.isArray(payload?.projects) && Array.isArray(payload?.grades);
    context.value = hasContext ? payload : {
      organizations: [], defaultOrganizationId: "", projects: props.fallbackContext.projects || [], grades: GRADE_GROUPS
    };
    form.eventId = context.value.event?.id || props.eventId || "";
    emit("context", context.value.event || null);
    const defaultOrganization = organizations.value.find((organization) => organization.id === context.value.defaultOrganizationId && organizationAvailable(organization));
    form.organizationId = defaultOrganization?.id || organizations.value.find(organizationAvailable)?.id || "";
    applyOrganization();
  } catch (error) { emit("error", error.message); } finally { loading.value = false; }
});
</script>

<template>
  <section v-if="!hasEventContext" class="content-grid registration-page"><div class="panel event-context-empty"><h3>请先选择赛事</h3><p class="hint">报名必须在明确的赛事上下文中进行。请返回赛事中心后再继续。</p></div></section>
  <section v-else-if="!registrationOpen" class="content-grid registration-page"><div class="panel event-context-empty"><h3>当前不可报名</h3><p class="hint">{{ registrationStateMessage }}</p></div></section>
  <section v-else class="content-grid registration-page"><form class="panel form-panel" @submit.prevent="submit">
    <div class="panel-title"><h3>报名端<span v-if="context.event?.name"> · {{ context.event.name }}</span></h3><span v-if="selectedGroup">{{ selectedGroup }}</span></div>
    <p v-if="loading" class="hint">正在加载报名资料…</p>
    <template v-else>
      <label v-if="organizations.length">关联组织<select v-model="form.organizationId"><option value="">不关联组织</option><option v-for="org in organizations" :key="org.id" :value="org.id" :disabled="!organizationAvailable(org)">{{ org.name }}{{ !organizationAvailable(org) ? "（该组织尚未加入本赛事）" : "" }}</option></select></label>
      <p v-if="selectedOrganization && organizationAvailable(selectedOrganization)" class="hint">关联组织：{{ selectedOrganization.name }}</p>
      <p v-if="organizations.some((org) => !organizationAvailable(org))" class="hint organization-unavailable">该组织尚未加入本赛事，暂不能关联组织。</p>
      <div class="two"><label>姓名<input v-model="form.athlete.name" required /></label><label>学校<SchoolCombobox v-model="form.athlete.school" /></label></div>
      <div class="two"><label>年级<input v-model="form.athlete.grade" list="grade-options" placeholder="请选择实际年级" required /><datalist id="grade-options"><template v-for="group in context.grades" :key="group.id"><option v-for="grade in group.grades" :key="grade" :value="grade">{{ group.name }}</option></template></datalist></label><label>手机号/家长手机号<input v-model="form.athlete.phone" required /></label></div>
      <div class="two"><label>组别<input :value="selectedGroup" readonly /></label><label>赛项<select v-model="form.projectId" required :disabled="!selectedGroup"><option v-for="project in eligibleProjects" :key="project.id" :value="project.id">{{ project.name }}（{{ project.type === 'team' ? '团体赛' : '个人赛' }}）</option></select></label></div>
      <label>指导老师<input v-model="form.instructor" placeholder="选填" /></label><button class="primary">提交报名</button>
    </template>
  </form></section>
</template>
