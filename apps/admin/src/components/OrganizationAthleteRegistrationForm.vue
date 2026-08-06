<script setup>
import { computed, reactive, ref, watch } from "vue";

import SchoolCombobox from "./SchoolCombobox.vue";
import SubmissionAssetUploader from "./SubmissionAssetUploader.vue";
import { api } from "../lib/api.js";

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
  athlete: { name: "", school: "", grade: "", phone: "" },
  projectId: "",
  instructor: ""
});
const submitting = ref(false);
const message = ref("");
const uploadSession = ref(null);
const uploadSessionLoading = ref(false);
const uploadSessionError = ref("");
const assetsComplete = ref(false);
let uploadSessionRequest = 0;
const hasEventContext = computed(() => Boolean(String(props.eventId || "").trim()));
const editing = computed(() => Boolean(props.registration?.id));
const gradeOptions = computed(() => props.grades.flatMap((group) => group.grades || []));
const selectedProject = computed(() => props.projects.find((project) => project.id === form.projectId) || null);
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
const submitDisabled = computed(() => submitting.value
  || !form.projectId
  || (!editing.value && (!form.registrationSource || (memberMode.value && !form.memberUserId)))
  || (requiresSubmission.value && (!uploadSession.value?.id || uploadSessionLoading.value || !assetsComplete.value)));

function blankAthlete() {
  return { name: "", school: props.defaultSchool || "", grade: "", phone: "" };
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
  form.projectId = registration?.projectId || props.projects[0]?.id || "";
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
  if (editing.value) return;
  if (source === previous) return;
  memberSearch.value = "";
  form.memberUserId = "";
  form.athlete.name = "";
  form.athlete.phone = "";
});

watch(() => props.defaultSchool, (defaultSchool) => {
  if (!editing.value && !form.athlete.school) form.athlete.school = defaultSchool || "";
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
  if (!hasEventContext.value || editing.value || project?.submissionMode !== "image_video") return;
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
  submitting.value = true;
  message.value = "";
  try {
    const path = editing.value
      ? `/api/organization/events/${encodeURIComponent(props.eventId)}/registrations/${encodeURIComponent(props.registration.id)}`
      : `/api/organization/events/${encodeURIComponent(props.eventId)}/registrations`;
    const body = editing.value
      ? { athlete: form.athlete, projectId: form.projectId, instructor: form.instructor }
      : {
          registrationSource: form.registrationSource,
          ...(memberMode.value ? { memberUserId: form.memberUserId } : {}),
          athlete: form.athlete,
          projectId: form.projectId,
          instructor: form.instructor,
          ...(requiresSubmission.value ? { uploadSessionId: uploadSession.value.id } : {})
        };
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
      clearUploadSession();
    }
    emit("registered", payload);
  } catch (error) {
    emit("error", error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form v-if="hasEventContext && !disabled" class="panel form-panel organization-athlete-registration-form" :data-testid="editing ? 'organization-registration-editor' : 'organization-registration-form'" @submit.prevent="submit">
    <fieldset v-if="!editing" class="organization-registration-source" aria-label="报名方式">
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
    <div class="two"><label>姓名<input v-model="form.athlete.name" data-field="athlete-name" :readonly="memberMode" required /></label><label>学校<SchoolCombobox v-model="form.athlete.school" /></label></div>
    <div class="two"><label>年级<select v-model="form.athlete.grade" data-field="athlete-grade" required><option value="" disabled>请选择年级</option><option v-for="grade in gradeOptions" :key="grade" :value="grade">{{ grade }}</option></select></label><label>手机/监护人手机<input v-model="form.athlete.phone" data-field="athlete-phone" :readonly="memberMode" required /></label></div>
    <div class="two"><label>赛项<select v-model="form.projectId" :disabled="editing" required><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>指导老师<input v-model="form.instructor" data-field="instructor" /></label></div>
    <p v-if="editing" class="hint">赛项在报名创建后不可修改；如需更换赛项，请取消后重新报名。</p>
    <section v-if="requiresSubmission" class="registration-submission" aria-label="作品材料">
      <p v-if="uploadSessionLoading" class="hint">正在创建作品上传会话…</p>
      <template v-else-if="uploadSession?.id">
        <SubmissionAssetUploader :key="uploadSession.id" :session-id="uploadSession.id" mode="image_video" :assets="uploadSession.assets || {}" @complete="assetsComplete = $event" @error="uploadSessionError = '作品材料上传失败，请重试'; emit('error', $event)" />
        <p v-if="!assetsComplete" class="hint">请先完成作品图片和作画视频的上传。</p>
      </template>
      <p v-else class="message" role="alert">{{ uploadSessionError || "作品上传会话不可用" }} <button type="button" class="mini" @click="retryUploadSession">重试</button></p>
    </section>
    <button class="primary" :disabled="submitDisabled">{{ submitting ? "正在提交…" : editing ? "保存修改" : "提交组织报名" }}</button>
    <p v-if="message" class="message">{{ message }}</p>
  </form>
</template>
