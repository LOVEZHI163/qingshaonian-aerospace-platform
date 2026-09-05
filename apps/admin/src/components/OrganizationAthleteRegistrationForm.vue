<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import SchoolCombobox from "./SchoolCombobox.vue";
import SubmissionAssetUploader from "./SubmissionAssetUploader.vue";
import TeamRegistrationFields from "./TeamRegistrationFields.vue";
import { api } from "../lib/api.js";
import { useUnsavedForm } from "../state/unsaved-form.js";

const { markDirty, markSaved } = useUnsavedForm();

const props = defineProps({
  eventId: { type: String, required: true },
  projects: { type: Array, default: () => [] },
  grades: { type: Array, default: () => [] },
  members: { type: Array, default: () => [] },
  defaultSchool: { type: String, default: "" },
  registration: { type: Object, default: null },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(["registered", "error"]);
const memberSearch = ref("");
const form = reactive({
  registrationSource: "",
  memberUserId: "",
  studentIdNumber: "",
  athlete: { name: "", school: "", grade: "", phone: "" },
  participants: [],
  projectId: "",
  instructor: ""
});
const studentIdPattern = /^[0-9]{17}[0-9Xx]$/;
const submitting = ref(false);
const message = ref("");
const uploadSession = ref(null);
const uploadSessionLoading = ref(false);
const uploadSessionError = ref("");
const assetsComplete = ref(false);
const leaderEligibilityLoading = ref(true);
const hasApprovedLeader = ref(false);
const leaderEligibilityError = ref("");
let uploadSessionRequest = 0;
const hasEventContext = computed(() => Boolean(String(props.eventId || "").trim()));
const editing = computed(() => Boolean(props.registration?.id));
const newRegistrationAllowed = computed(() => editing.value || (!leaderEligibilityLoading.value && hasApprovedLeader.value));
const gradeOptions = computed(() => props.grades.flatMap((group) => group.grades || []));
const selectedProject = computed(() => props.projects.find((project) => project.id === form.projectId) || null);
const isTeam = computed(() => selectedProject.value?.type === "team");
const selectedMember = computed(() => props.members.find((member) => member.id === form.memberUserId) || null);
const memberMode = computed(() => form.registrationSource === "member_registration");
const filteredMembers = computed(() => {
  const query = memberSearch.value.trim().toLowerCase();
  if (!query) return props.members;
  return props.members.filter((member) => (
    String(member.name || "").toLowerCase().includes(query)
    || String(member.phone || "").toLowerCase().includes(query)
  ));
});
const requiresSubmission = computed(() => !editing.value && selectedProject.value?.submissionMode === "image_video");
const teamParticipantsValid = computed(() => !isTeam.value || (
  form.participants.length >= (selectedProject.value?.teamMinMembers ?? 1)
  && form.participants.length <= (selectedProject.value?.teamMaxMembers ?? 8)
  && form.participants.every((participant) => (
    participant.name?.trim()
    && participant.school?.trim()
    && participant.grade?.trim()
    && participant.phone?.trim()
    && studentIdPattern.test(participant.studentIdNumber?.trim() || "")
  ))
));
const submitDisabled = computed(() => submitting.value
  || !newRegistrationAllowed.value
  || !form.projectId
  || (!editing.value && !isTeam.value && (!form.registrationSource || (memberMode.value && !form.memberUserId)))
  || !teamParticipantsValid.value
  || (requiresSubmission.value && (!uploadSession.value?.id || uploadSessionLoading.value || !assetsComplete.value)));

function blankAthlete() {
  return { name: "", school: props.defaultSchool || "", grade: "", phone: "" };
}

function blankParticipant() {
  return { name: "", school: props.defaultSchool || "", grade: "", phone: "", studentIdNumber: "" };
}

function resetTeamParticipants(project = selectedProject.value) {
  const minimum = Math.max(1, Number(project?.teamMinMembers) || 1);
  form.participants = Array.from({ length: minimum }, blankParticipant);
}

watch(() => props.projects, (projects) => {
  if (!projects.some((project) => project.id === form.projectId)) form.projectId = projects[0]?.id || "";
}, { immediate: true });

watch(() => props.registration, (registration) => {
  const athlete = registration?.athlete ? JSON.parse(JSON.stringify(registration.athlete)) : {};
  Object.assign(form.athlete, blankAthlete(), athlete);
  form.registrationSource = registration?.id
    ? (registration.source === "organization_proxy" ? "organization_proxy" : "member_registration")
    : "";
  form.memberUserId = registration?.personalUserId || "";
  form.studentIdNumber = "";
  form.projectId = registration?.projectId || props.projects[0]?.id || "";
  const project = props.projects.find((item) => item.id === form.projectId);
  form.participants = project?.type === "team" && Array.isArray(registration?.participants) && registration.participants.length > 0
    ? registration.participants.map((participant) => ({ ...participant, studentIdNumber: participant.studentIdNumber || "" }))
    : [];
  if (project?.type === "team" && form.participants.length === 0) resetTeamParticipants(project);
  form.instructor = registration?.instructor || "";
  message.value = "";
}, { immediate: true });

watch(selectedMember, (member) => {
  if (!memberMode.value || editing.value) return;
  form.athlete.name = member?.name || "";
  form.athlete.phone = member?.phone || "";
  if (!form.athlete.school) form.athlete.school = props.defaultSchool || "";
});

watch(filteredMembers, (members) => {
  if (!memberMode.value || editing.value || !form.memberUserId) return;
  if (!members.some((member) => member.id === form.memberUserId)) form.memberUserId = "";
});

watch(() => form.registrationSource, (source, previous) => {
  if (editing.value || isTeam.value) return;
  if (source === previous) return;
  memberSearch.value = "";
  form.memberUserId = "";
  form.studentIdNumber = "";
  form.athlete.name = "";
  form.athlete.phone = "";
});

watch(() => props.defaultSchool, (defaultSchool) => {
  if (!editing.value && !form.athlete.school) form.athlete.school = defaultSchool || "";
  if (!editing.value) {
    form.participants = form.participants.map((participant) => (
      participant.school ? participant : { ...participant, school: defaultSchool || "" }
    ));
  }
}, { immediate: true });

watch(selectedProject, (project, previous) => {
  if (project?.type === "team") {
    form.registrationSource = "organization_proxy";
    form.memberUserId = "";
    if (form.participants.length === 0 || (!editing.value && previous?.id !== project.id)) resetTeamParticipants(project);
  } else if (!editing.value && previous?.type === "team") {
    form.registrationSource = "";
    form.participants = [];
  }
}, { immediate: true });

function clearUploadSession() {
  uploadSessionRequest += 1;
  uploadSession.value = null;
  uploadSessionLoading.value = false;
  uploadSessionError.value = "";
  assetsComplete.value = false;
}

async function createUploadSession() {
  const project = selectedProject.value;
  if (!hasEventContext.value || editing.value || !newRegistrationAllowed.value || project?.submissionMode !== "image_video") return;
  const request = uploadSessionRequest + 1;
  uploadSessionRequest = request;
  uploadSessionLoading.value = true;
  uploadSessionError.value = "";
  try {
    const payload = await api(`/api/organization/events/${encodeURIComponent(props.eventId)}/projects/${encodeURIComponent(project.id)}/upload-sessions`, { method: "POST" });
    if (request !== uploadSessionRequest || editing.value || form.projectId !== project.id) return;
    const session = payload?.row || payload;
    if (!session?.id) throw new Error("invalid upload session");
    uploadSession.value = session;
  } catch (error) {
    if (request !== uploadSessionRequest || editing.value || form.projectId !== project.id) return;
    uploadSessionError.value = "无法创建作品上传会话，请重试";
    emit("error", error);
  } finally {
    if (request === uploadSessionRequest) uploadSessionLoading.value = false;
  }
}

function retryUploadSession() {
  clearUploadSession();
  void createUploadSession();
}

watch(() => [form.projectId, editing.value], () => {
  clearUploadSession();
  if (requiresSubmission.value) void createUploadSession();
}, { immediate: true });

async function submit() {
  if (!hasEventContext.value || props.disabled || submitDisabled.value) return;
  const studentIdNumber = form.studentIdNumber.trim();
  if (!isTeam.value && !editing.value && !studentIdPattern.test(studentIdNumber)) {
    emit("error", new Error("请输入 18 位居民身份证号，末位可为 X"));
    return;
  }
  submitting.value = true;
  message.value = "";
  try {
    const path = editing.value
      ? `/api/organization/events/${encodeURIComponent(props.eventId)}/registrations/${encodeURIComponent(props.registration.id)}`
      : `/api/organization/events/${encodeURIComponent(props.eventId)}/registrations`;
    const participants = form.participants.map(({ name, school, grade, phone, studentIdNumber: identity }) => ({
      name: String(name || "").trim(),
      school: String(school || "").trim(),
      grade: String(grade || "").trim(),
      phone: String(phone || "").trim(),
      studentIdNumber: String(identity || "").trim()
    }));
    const body = editing.value
      ? (isTeam.value
          ? { participants, projectId: form.projectId, instructor: form.instructor }
          : { athlete: form.athlete, projectId: form.projectId, instructor: form.instructor })
      : (isTeam.value
        ? {
            registrationSource: "organization_proxy",
            participants,
            projectId: form.projectId,
            instructor: form.instructor,
            ...(requiresSubmission.value ? { uploadSessionId: uploadSession.value.id } : {})
          }
        : {
          registrationSource: form.registrationSource,
          ...(memberMode.value ? { memberUserId: form.memberUserId } : {}),
          studentIdNumber,
          athlete: form.athlete,
          projectId: form.projectId,
          instructor: form.instructor,
          ...(requiresSubmission.value ? { uploadSessionId: uploadSession.value.id } : {})
        });
    const payload = await api(path, {
      method: editing.value ? "PATCH" : "POST",
      body: JSON.stringify(body)
    });
    message.value = editing.value ? "组织报名已更新" : payload.merged ? "已与现有个人报名合并，未重复创建" : "组织报名已提交";
    if (!editing.value) {
      Object.assign(form.athlete, blankAthlete());
      form.instructor = "";
      form.projectId = "";
      form.registrationSource = "";
      form.memberUserId = "";
      form.studentIdNumber = "";
      form.participants = [];
      clearUploadSession();
    }
    markSaved();
    emit("registered", payload);
  } catch (error) {
    if (error?.code === "ORGANIZATION_LEADER_REQUIRED") {
      error.message = "请先在领队管理提交至少一名领队并等待平台审核通过";
    }
    emit("error", error);
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  if (editing.value) {
    leaderEligibilityLoading.value = false;
    return;
  }
  try {
    const payload = await api("/api/organization/leaders");
    hasApprovedLeader.value = (payload?.rows || []).some((row) => row.reviewStatus === "approved" && row.enabled === true);
  } catch (error) {
    leaderEligibilityError.value = "暂时无法确认领队报名资格，请稍后重试";
    emit("error", error);
  } finally {
    leaderEligibilityLoading.value = false;
    if (hasApprovedLeader.value && requiresSubmission.value) void createUploadSession();
  }
});
</script>

<template>
  <form v-if="hasEventContext && !disabled" class="panel form-panel organization-athlete-registration-form" :data-testid="editing ? 'organization-registration-editor' : 'organization-registration-form'" @input.capture="markDirty" @change.capture="markDirty" @submit.prevent="submit">
    <fieldset v-if="!editing && !isTeam" class="organization-registration-source" aria-label="报名方式">
      <legend>报名方式</legend>
      <label><input v-model="form.registrationSource" type="radio" value="member_registration" data-registration-source="member_registration" required />成员报名</label>
      <label><input v-model="form.registrationSource" type="radio" value="organization_proxy" data-registration-source="organization_proxy" required />组织代报名</label>
      <div v-if="memberMode" class="organization-member-picker">
        <label>搜索成员
          <input v-model="memberSearch" type="search" data-field="member-search" placeholder="输入姓名或手机号" autocomplete="off" />
        </label>
        <label>选择成员
          <select v-model="form.memberUserId" data-field="member-user-id" required>
            <option value="" disabled>请选择本组织有效成员</option>
            <option v-for="member in filteredMembers" :key="member.id" :value="member.id">{{ member.name }} · {{ member.phone }}</option>
          </select>
        </label>
        <p v-if="members.length === 0" class="hint" data-state="member-search-empty">本组织暂无可报名的有效普通成员。</p>
        <p v-else-if="filteredMembers.length === 0" class="hint" data-state="member-search-empty">未找到匹配的有效成员，请更换姓名或手机号。</p>
      </div>
      <p class="hint">成员报名会关联该成员账号；组织代报名仅保存参赛者资料，不关联个人账号。</p>
    </fieldset>
    <div class="panel-title"><h3>{{ editing ? "编辑组织报名" : "组织报名" }}</h3></div>
    <p class="hint">报名将自动归属当前组织；不支持切换个人身份或其他组织。</p>
    <div v-if="!editing && !leaderEligibilityLoading && !hasApprovedLeader" class="registration-eligibility-card" data-testid="organization-leader-guidance">
      <p class="hint">{{ leaderEligibilityError || "请先在领队管理提交至少一名领队并等待平台审核通过" }}</p>
      <a class="primary" data-action="open-leader-management" href="?view=leaders">前往领队管理</a>
    </div>
    <template v-if="!isTeam">
      <div class="two"><label>姓名<input v-model="form.athlete.name" data-field="athlete-name" :readonly="memberMode" required /></label><label>学校<SchoolCombobox v-model="form.athlete.school" /></label></div>
      <div class="two"><label>年级<select v-model="form.athlete.grade" data-field="athlete-grade" required><option value="" disabled>请选择年级</option><option v-for="grade in gradeOptions" :key="grade" :value="grade">{{ grade }}</option></select></label><label>手机/监护人手机<input v-model="form.athlete.phone" data-field="athlete-phone" :readonly="memberMode" required /></label></div>
      <label v-if="!editing">学生身份证号<input v-model="form.studentIdNumber" data-field="student-id-number" inputmode="text" autocomplete="off" minlength="18" maxlength="18" pattern="[0-9]{17}[0-9Xx]" placeholder="18 位居民身份证号，末位可为 X" required /></label>
    </template>
    <TeamRegistrationFields v-else v-model="form.participants" :min-members="selectedProject.teamMinMembers ?? 1" :max-members="selectedProject.teamMaxMembers ?? 8" :default-school="defaultSchool" />
    <div class="two"><label>赛项<select v-model="form.projectId" :disabled="editing" required><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>指导老师<input v-model="form.instructor" data-field="instructor" :required="selectedProject?.instructorRequired" /></label></div>
    <p v-if="editing" class="hint">赛项在报名创建后不可修改；如需更换赛项，请取消后重新报名。</p>
    <section v-if="requiresSubmission" class="registration-submission" aria-label="作品材料">
      <p v-if="uploadSessionLoading" class="hint">正在创建作品上传会话…</p>
      <template v-else-if="uploadSession?.id">
        <SubmissionAssetUploader :key="uploadSession.id" :session-id="uploadSession.id" mode="image_video" :assets="uploadSession.assets || {}" @complete="assetsComplete = $event" @error="uploadSessionError = '作品材料上传失败，请重试'; emit('error', $event)" />
        <p v-if="!assetsComplete" class="hint">请先完成作品图片和作画视频的上传。</p>
      </template>
      <p v-else class="message" role="alert">{{ uploadSessionError || "作品上传会话不可用" }} <button type="button" class="mini" @click="retryUploadSession">重试</button></p>
    </section>
    <p v-if="!editing" class="hint registration-identity-notice">学生身份证号是报名资料，将用于名单导出和证书信息核对，请本人或监护人确认填写正确。</p>
    <button class="primary" :disabled="submitDisabled">{{ submitting ? "正在提交…" : editing ? "保存修改" : "提交组织报名" }}</button>
    <p v-if="message" class="message">{{ message }}</p>
  </form>
</template>
