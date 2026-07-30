<script setup>
import { computed, reactive, ref, watch } from "vue";

import SchoolCombobox from "./SchoolCombobox.vue";
import { api } from "../lib/api.js";

const props = defineProps({
  eventId: { type: String, required: true },
  projects: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(["registered", "error"]);
const form = reactive({ athlete: { name: "", school: "", grade: "", phone: "" }, projectId: "", instructor: "" });
const submitting = ref(false);
const message = ref("");
const hasEventContext = computed(() => Boolean(String(props.eventId || "").trim()));

watch(() => props.projects, (projects) => {
  if (!projects.some((project) => project.id === form.projectId)) form.projectId = projects[0]?.id || "";
}, { immediate: true });

async function submit() {
  if (!hasEventContext.value || props.disabled || submitting.value) return;
  submitting.value = true;
  message.value = "";
  try {
    const payload = await api(`/api/organization/events/${encodeURIComponent(props.eventId)}/registrations`, {
      method: "POST",
      body: JSON.stringify({ athlete: form.athlete, projectId: form.projectId, instructor: form.instructor })
    });
    message.value = payload.merged ? "已与现有个人报名合并，未重复创建" : "组织报名已提交";
    Object.assign(form.athlete, { name: "", school: "", grade: "", phone: "" });
    form.instructor = "";
    emit("registered", payload);
  } catch (error) {
    emit("error", error.message || "组织报名提交失败");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form v-if="hasEventContext && !disabled" class="panel form-panel organization-athlete-registration-form" data-testid="organization-registration-form" @submit.prevent="submit">
    <div class="panel-title"><h3>组织报名</h3></div>
    <p class="hint">报名将自动归属当前组织；不支持切换个人身份或其他组织。</p>
    <div class="two"><label>姓名<input v-model="form.athlete.name" data-field="athlete-name" required /></label><label>学校<SchoolCombobox v-model="form.athlete.school" /></label></div>
    <div class="two"><label>年级<input v-model="form.athlete.grade" data-field="athlete-grade" required /></label><label>手机/监护人手机<input v-model="form.athlete.phone" data-field="athlete-phone" required /></label></div>
    <div class="two"><label>赛项<select v-model="form.projectId" required><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>指导老师<input v-model="form.instructor" /></label></div>
    <button class="primary" :disabled="submitting || !form.projectId">{{ submitting ? "正在提交…" : "提交组织报名" }}</button>
    <p v-if="message" class="message">{{ message }}</p>
  </form>
</template>
