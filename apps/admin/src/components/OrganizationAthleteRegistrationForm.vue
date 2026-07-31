<script setup>
import { computed, reactive, ref, watch } from "vue";

import SchoolCombobox from "./SchoolCombobox.vue";
import SubmissionAssetUploader from "./SubmissionAssetUploader.vue";
import { api } from "../lib/api.js";

const props = defineProps({
  eventId: { type: String, required: true },
  projects: { type: Array, default: () => [] },
  registration: { type: Object, default: null },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(["registered", "error"]);
const form = reactive({
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
const selectedProject = computed(() => props.projects.find((project) => project.id === form.projectId) || null);
const requiresSubmission = computed(() => !editing.value && selectedProject.value?.submissionMode === "image_video");
const submitDisabled = computed(() => submitting.value || !form.projectId || (requiresSubmission.value && (!uploadSession.value?.id || uploadSessionLoading.value || !assetsComplete.value)));

watch(() => props.projects, (projects) => {
  if (!projects.some((project) => project.id === form.projectId)) form.projectId = projects[0]?.id || "";
}, { immediate: true });

watch(() => props.registration, (registration) => {
  const athlete = registration?.athlete ? JSON.parse(JSON.stringify(registration.athlete)) : {};
  Object.assign(form.athlete, { name: "", school: "", grade: "", phone: "" }, athlete);
  form.projectId = registration?.projectId || props.projects[0]?.id || "";
  form.instructor = registration?.instructor || "";
  message.value = "";
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
  } catch {
    if (request !== uploadSessionRequest || editing.value || form.projectId !== project.id) return;
    uploadSessionError.value = "无法创建作品上传会话，请重试";
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
    const payload = await api(path, {
      method: editing.value ? "PATCH" : "POST",
      body: JSON.stringify({ athlete: form.athlete, projectId: form.projectId, instructor: form.instructor, ...(requiresSubmission.value ? { uploadSessionId: uploadSession.value.id } : {}) })
    });
    message.value = editing.value ? "组织报名已更新" : payload.merged ? "已与现有个人报名合并，未重复创建" : "组织报名已提交";
    if (!editing.value) {
      Object.assign(form.athlete, { name: "", school: "", grade: "", phone: "" });
      form.instructor = "";
      form.projectId = "";
      clearUploadSession();
    }
    emit("registered", payload);
  } catch (error) {
    emit("error", error.message || "组织报名提交失败");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form v-if="hasEventContext && !disabled" class="panel form-panel organization-athlete-registration-form" :data-testid="editing ? 'organization-registration-editor' : 'organization-registration-form'" @submit.prevent="submit">
    <div class="panel-title"><h3>{{ editing ? "编辑组织报名" : "组织报名" }}</h3></div>
    <p class="hint">报名将自动归属当前组织；不支持切换个人身份或其他组织。</p>
    <div class="two"><label>姓名<input v-model="form.athlete.name" data-field="athlete-name" required /></label><label>学校<SchoolCombobox v-model="form.athlete.school" /></label></div>
    <div class="two"><label>年级<input v-model="form.athlete.grade" data-field="athlete-grade" required /></label><label>手机/监护人手机<input v-model="form.athlete.phone" data-field="athlete-phone" required /></label></div>
    <div class="two"><label>赛项<select v-model="form.projectId" required><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>指导老师<input v-model="form.instructor" data-field="instructor" /></label></div>
    <section v-if="requiresSubmission" class="registration-submission" aria-label="作品材料">
      <p v-if="uploadSessionLoading" class="hint">正在创建作品上传会话…</p>
      <template v-else-if="uploadSession?.id">
        <SubmissionAssetUploader :key="uploadSession.id" :session-id="uploadSession.id" mode="image_video" :assets="uploadSession.assets || {}" @complete="assetsComplete = $event" @error="uploadSessionError = '作品材料上传失败，请重试'" />
        <p v-if="!assetsComplete" class="hint">请先完成作品图片和作画视频的上传。</p>
      </template>
      <p v-else class="message" role="alert">{{ uploadSessionError || "作品上传会话不可用" }} <button type="button" class="mini" @click="retryUploadSession">重试</button></p>
    </section>
    <button class="primary" :disabled="submitDisabled">{{ submitting ? "正在提交…" : editing ? "保存修改" : "提交组织报名" }}</button>
    <p v-if="message" class="message">{{ message }}</p>
  </form>
</template>
