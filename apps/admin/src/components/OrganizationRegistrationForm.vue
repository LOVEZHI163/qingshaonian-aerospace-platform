<script setup>
import { reactive, ref } from "vue";

import { api } from "../lib/api.js";

const emit = defineEmits(["registered", "error"]);
const props = defineProps({
  endpoint: { type: String, default: "/api/auth/register/organization" },
  submitLabel: { type: String, default: "提交组织审核" },
  initialForm: { type: Object, default: () => ({}) },
  resubmission: { type: Boolean, default: false }
});
const form = reactive({
  name: props.initialForm.name || "", phone: props.initialForm.phone || "", password: "", organizationName: props.initialForm.organizationName || "", creditCode: props.initialForm.creditCode || "",
  documentType: "business_license", credential: null
});
const submitting = ref(false);
const fileHint = "支持 PNG、JPEG、PDF，最大 10MB";

function selectFile(event) {
  form.credential = event.target.files?.[0] || null;
}

function validateFile() {
  if (!form.credential) return "请上传组织资质文件";
  if (form.credential.size > 10 * 1024 * 1024) return "资质文件不能超过 10MB";
  if (!["image/png", "image/jpeg", "application/pdf"].includes(form.credential.type)) return "仅支持 PNG、JPEG、PDF 格式";
  return "";
}

async function submit() {
  const fileError = validateFile();
  if (fileError) return emit("error", fileError);
  if (submitting.value) return;
  submitting.value = true;
  try {
    const data = new FormData();
    for (const field of (props.resubmission ? ["organizationName", "creditCode", "documentType"] : ["name", "phone", "password", "organizationName", "creditCode", "documentType"])) data.append(field, form[field]);
    data.append("credential", form.credential);
    const payload = await api(props.endpoint, { method: "POST", body: data });
    emit("registered", payload.user);
  } catch (error) {
    emit("error", error.message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="panel auth-panel org-register" data-register="organization" @submit.prevent="submit">
    <h3>组织用户注册</h3>
    <p class="hint">适合学校、青少年宫、科技馆、活动中心。注册后需等待资质审核。</p>
    <template v-if="!resubmission"><label>负责人姓名<input data-testid="organization-owner-name" v-model="form.name" placeholder="负责人/领队老师姓名" required /></label><label>手机号<input v-model="form.phone" placeholder="用于登录和组织联系" required /></label><label>密码<input v-model="form.password" type="password" required /></label></template>
    <label>组织名称<input v-model="form.organizationName" placeholder="学校、青少年宫或活动中心" required /></label>
    <label>统一社会信用代码<input v-model="form.creditCode" pattern="[0-9A-Za-z]{18}" maxlength="18" placeholder="18 位统一社会信用代码" required /></label>
    <label>证件类型
      <select v-model="form.documentType"><option value="business_license">营业执照</option><option value="public_institution_certificate">事业单位法人证书</option><option value="school_license">办学许可证</option></select>
    </label>
    <label>资质文件<input type="file" accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf" required @change="selectFile" /><small>{{ fileHint }}</small></label>
    <button class="primary" :disabled="submitting">{{ submitLabel }}</button>
  </form>
</template>
