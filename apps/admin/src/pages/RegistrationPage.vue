<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import SchoolCombobox from "../components/SchoolCombobox.vue";
import SubmissionAssetUploader from "../components/SubmissionAssetUploader.vue";
import { api } from "../lib/api.js";
import { accessMessage } from "../state/access.js";
import { useUnsavedForm } from "../state/unsaved-form.js";
import { registrationSuccessMessage } from "../state/registration-feedback.js";

const { markDirty, markSaved } = useUnsavedForm();

const props = defineProps({
  eventId: { type: String, default: "" },
  accountType: { type: String, default: "legacy" },
  registrationState: { type: String, default: "" },
  fallbackContext: { type: Object, default: () => ({}) }
});
const emit = defineEmits(["context", "registered", "error", "navigate"]);
const context = ref({ organizations: [], projects: [], grades: [] });
const loading = ref(true);
const submitting = ref(false);
const submitFeedback = ref(null);
const uploadSession = ref(null);
const uploadSessionLoading = ref(false);
const uploadSessionError = ref("");
const assetsComplete = ref(false);
let uploadSessionRequest = 0;
const form = reactive({ eventId: props.eventId, studentIdNumber: "", athlete: { name: "", school: "", grade: "", phone: "" }, projectId: "", instructor: "" });
const studentIdPattern = /^[0-9]{17}[0-9Xx]$/;
const ordinaryUser = computed(() => props.accountType === "ordinary");
const eligibility = computed(() => context.value?.eligibility || { eligible: false, code: "ACTIVE_ORGANIZATION_REQUIRED", organization: null });
const registrationEligible = computed(() => eligibility.value.eligible === true && Boolean(String(eligibility.value.organization?.id || "").trim()));
const leaderRequired = computed(() => eligibility.value.code === "ORGANIZATION_LEADER_REQUIRED");
const eligibleOrganization = computed(() => String(eligibility.value.organization?.id || "").trim() ? eligibility.value.organization : null);
const eligibilityMessage = computed(() => accessMessage({ code: eligibility.value.code }, "请先加入已通过审核的组织后再报名"));
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
const eligibleProjects = computed(() => (context.value.projects || []).filter((project) => project.type === "individual" && selectedGroup.value && (!project.allowedGroups || project.allowedGroups.includes(selectedGroup.value))));
const selectedProject = computed(() => (context.value.projects || []).find((project) => project.id === form.projectId) || null);
const requiresSubmission = computed(() => selectedProject.value?.submissionMode === "image_video");
const submitDisabled = computed(() => !registrationEligible.value || submitting.value || (requiresSubmission.value && (!uploadSession.value?.id || uploadSessionLoading.value || !assetsComplete.value)));
function applyOrganization() {
  if (eligibleOrganization.value && !form.athlete.school) form.athlete.school = eligibleOrganization.value.name;
}
watch(eligibleProjects, (projects) => { if (!projects.some((project) => project.id === form.projectId)) form.projectId = projects[0]?.id || ""; });
function clearUploadSession() {
  uploadSessionRequest += 1;
  uploadSession.value = null;
  uploadSessionLoading.value = false;
  uploadSessionError.value = "";
  assetsComplete.value = false;
}

async function createUploadSession() {
  const project = selectedProject.value;
  if (!ordinaryUser.value || !registrationEligible.value || !hasEventContext.value || project?.submissionMode !== "image_video") return;
  const request = uploadSessionRequest + 1;
  uploadSessionRequest = request;
  uploadSessionLoading.value = true;
  uploadSessionError.value = "";
  try {
    const payload = await api(`/api/me/events/${encodeURIComponent(props.eventId)}/projects/${encodeURIComponent(project.id)}/upload-sessions`, { method: "POST" });
    if (request !== uploadSessionRequest || form.projectId !== project.id) return;
    const session = payload?.row || payload;
    if (!session?.id) throw new Error("invalid upload session");
    uploadSession.value = session;
  } catch {
    if (request !== uploadSessionRequest || form.projectId !== project.id) return;
    uploadSessionError.value = "无法创建作品上传会话，请重试";
  } finally {
    if (request === uploadSessionRequest) uploadSessionLoading.value = false;
  }
}

function retryUploadSession() {
  clearUploadSession();
  void createUploadSession();
}

watch(() => form.projectId, () => {
  clearUploadSession();
  if (requiresSubmission.value) void createUploadSession();
});
watch(() => [form.studentIdNumber, form.athlete.name, form.athlete.school, form.athlete.grade, form.athlete.phone, form.projectId], async () => {
  if (ordinaryUser.value) return;
  if (!studentIdPattern.test(form.studentIdNumber.trim()) || !form.athlete.name || !form.athlete.school || !form.athlete.grade || !form.athlete.phone || !form.projectId) return;
  try { await api("/api/registrations/check", { method: "POST", body: JSON.stringify({ eventId: form.eventId, studentIdNumber: form.studentIdNumber.trim(), athlete: form.athlete, projectId: form.projectId, group: selectedGroup.value }) }); } catch { /* Submission remains the authoritative validation. */ }
});

async function submit() {
  submitFeedback.value = null;
  if (!hasEventContext.value) {
    const message = "请先从赛事中心选择赛事";
    submitFeedback.value = { tone: "error", message };
    emit("error", message);
    return;
  }
  if (!registrationOpen.value) {
    submitFeedback.value = { tone: "error", message: registrationStateMessage.value };
    emit("error", registrationStateMessage.value);
    return;
  }
  if (!ordinaryUser.value) {
    const message = "请从组织赛事工作台提交报名";
    submitFeedback.value = { tone: "error", message };
    emit("error", message);
    return;
  }
  if (!registrationEligible.value) {
    submitFeedback.value = { tone: "error", message: eligibilityMessage.value };
    emit("error", eligibilityMessage.value);
    return;
  }
  const studentIdNumber = form.studentIdNumber.trim();
  if (!studentIdPattern.test(studentIdNumber)) {
    const message = "请输入 18 位居民身份证号，末位可为 X";
    submitFeedback.value = { tone: "error", message };
    emit("error", message);
    return;
  }
  if (submitDisabled.value) return;
  submitting.value = true;
  try {
    const payload = {
      organizationId: eligibleOrganization.value.id,
      studentIdNumber,
      athlete: form.athlete,
      projectId: form.projectId,
      instructor: form.instructor
    };
    if (requiresSubmission.value) payload.uploadSessionId = uploadSession.value.id;
    const result = await api(`/api/me/events/${encodeURIComponent(props.eventId)}/registrations`, { method: "POST", body: JSON.stringify(payload) });
    Object.assign(form.athlete, { name: "", school: eligibleOrganization.value?.name || "", grade: "", phone: "" });
    form.studentIdNumber = "";
    form.instructor = "";
    form.projectId = "";
    clearUploadSession();
    markSaved();
    submitFeedback.value = { tone: "success", message: registrationSuccessMessage(result) };
    emit("registered");
  } catch (error) {
    const message = accessMessage(error);
    submitFeedback.value = { tone: "error", message };
    emit("error", message);
  }
  finally { submitting.value = false; }
}

onMounted(async () => {
  if (!hasEventContext.value) {
    loading.value = false;
    return;
  }
  try {
    const query = props.eventId ? `?eventId=${encodeURIComponent(props.eventId)}` : "";
    const payload = await api(`/api/me/registration-context${query}`);
    const hasContext = Array.isArray(payload?.projects) && Array.isArray(payload?.grades) && payload?.eligibility && typeof payload.eligibility.eligible === "boolean";
    context.value = hasContext ? payload : {
      organizations: [], defaultOrganizationId: "", eligibility: { eligible: false, code: "ACTIVE_ORGANIZATION_REQUIRED", organization: null }, projects: props.fallbackContext.projects || [], grades: GRADE_GROUPS
    };
    form.eventId = context.value.event?.id || props.eventId || "";
    emit("context", context.value.event || null);
    applyOrganization();
  } catch (error) {
    context.value = { ...context.value, eligibility: { eligible: false, code: error?.code || "ACTIVE_ORGANIZATION_REQUIRED", organization: null } };
    emit("error", accessMessage(error));
  } finally { loading.value = false; }
});
</script>

<template>
  <section v-if="!hasEventContext" class="content-grid registration-page"><div class="panel event-context-empty"><h3>请先选择赛事</h3><p class="hint">报名必须在明确的赛事上下文中进行。请返回赛事中心后再继续。</p></div></section>
  <section v-else-if="!registrationOpen" class="content-grid registration-page"><div class="panel event-context-empty"><h3>当前不可报名</h3><p class="hint">{{ registrationStateMessage }}</p></div></section>
  <section v-else-if="loading" class="content-grid registration-page"><div class="panel event-context-empty"><h3>正在加载报名资料…</h3></div></section>
  <section v-else-if="ordinaryUser && !registrationEligible && !leaderRequired" class="content-grid registration-page"><div class="panel registration-eligibility-card" data-testid="registration-eligibility-guidance"><h3>请先加入组织</h3><p class="hint">{{ eligibilityMessage }}</p><button type="button" class="primary" data-action="open-my-organization" @click="emit('navigate', 'myOrganization')">前往“我的组织”</button></div></section>
  <section v-else class="content-grid registration-page"><form class="panel form-panel" @input.capture="markDirty" @change.capture="markDirty" @submit.prevent="submit">
    <div class="panel-title"><h3>报名端<span v-if="context.event?.name"> · {{ context.event.name }}</span></h3><span v-if="selectedGroup">{{ selectedGroup }}</span></div>
    <div v-if="leaderRequired" class="registration-eligibility-card registration-leader-required" data-testid="registration-eligibility-guidance" role="alert">
      <span class="registration-blocked-label">报名条件未满足</span>
      <h4>所属组织尚未完成领队申报</h4>
      <p>您已加入“{{ eligibleOrganization?.name || "当前组织" }}”，但该组织目前没有审核通过且已启用的领队，因此暂时无法提交报名。</p>
      <ol>
        <li>请联系组织负责人进入“领队管理”；</li>
        <li>提交领队资料和授权书，等待平台管理员审核通过并启用；</li>
        <li>完成后返回本页面，即可继续报名。</li>
      </ol>
      <p class="registration-leader-note">无需退出组织或重新申请加入。</p>
    </div>
    <div v-if="eligibleOrganization" class="registration-organization-readonly" data-testid="eligible-organization"><span>所属组织</span><strong>{{ eligibleOrganization.name }}</strong><small>报名将自动归属该组织</small></div>
      <div class="two"><label>姓名<input v-model="form.athlete.name" required /></label><label data-field="registration-school">学校<SchoolCombobox v-model="form.athlete.school" /></label></div>
      <div class="two"><label>年级<input v-model="form.athlete.grade" list="grade-options" placeholder="请选择实际年级" required /><datalist id="grade-options"><template v-for="group in context.grades" :key="group.id"><option v-for="grade in group.grades" :key="grade" :value="grade">{{ group.name }}</option></template></datalist></label><label>手机号/家长手机号<input v-model="form.athlete.phone" required /></label></div>
      <label>学生身份证号<input v-model="form.studentIdNumber" data-field="student-id-number" inputmode="text" autocomplete="off" minlength="18" maxlength="18" pattern="[0-9]{17}[0-9Xx]" placeholder="18 位居民身份证号，末位可为 X" required /></label>
      <div class="two"><label>组别<input :value="selectedGroup" readonly /></label><label>赛项<select v-model="form.projectId" required :disabled="!selectedGroup"><option v-for="project in eligibleProjects" :key="project.id" :value="project.id">{{ project.name }}（{{ project.type === 'team' ? '团体赛' : '个人赛' }}）</option></select></label></div>
      <label>指导老师<input v-model="form.instructor" placeholder="选填" /></label>
      <section v-if="requiresSubmission" class="registration-submission" aria-label="作品材料">
        <p v-if="uploadSessionLoading" class="hint">正在创建作品上传会话…</p>
        <template v-else-if="uploadSession?.id">
          <SubmissionAssetUploader :key="uploadSession.id" :session-id="uploadSession.id" mode="image_video" :assets="uploadSession.assets || {}" @complete="assetsComplete = $event" @error="uploadSessionError = '作品材料上传失败，请重试'" />
          <p v-if="!assetsComplete" class="hint">请先完成作品图片和作画视频的上传。</p>
        </template>
        <p v-else class="message" role="alert">{{ uploadSessionError || "作品上传会话不可用" }} <button type="button" class="mini" @click="retryUploadSession">重试</button></p>
      </section>
    <p class="hint registration-identity-notice">学生身份证号是报名资料，将用于名单导出和证书信息核对，请本人或监护人确认填写正确。</p>
    <button class="primary" :disabled="submitDisabled">{{ submitting ? "正在提交…" : "提交报名" }}</button>
    <p v-if="submitFeedback" class="message" :class="submitFeedback.tone === 'error' ? 'danger-message' : 'success-message'" :role="submitFeedback.tone === 'error' ? 'alert' : 'status'" data-testid="ordinary-registration-feedback">{{ submitFeedback.message }}</p>
    <button v-if="submitFeedback?.tone === 'success'" type="button" class="mini" data-action="view-registration-records" @click="emit('navigate', 'registrationRecords')">查看报名记录</button>
  </form></section>
</template>
