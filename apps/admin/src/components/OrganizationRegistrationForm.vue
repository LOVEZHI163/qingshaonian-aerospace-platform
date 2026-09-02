<script setup>
import { computed, reactive, ref } from "vue";

import { api } from "../lib/api.js";
import RegistrationPhoneVerification from "./RegistrationPhoneVerification.vue";

const emit = defineEmits(["registered", "error"]);
const props = defineProps({
  endpoint: { type: String, default: "/api/auth/register/organization" },
  method: { type: String, default: "POST" },
  submitLabel: { type: String, default: "提交组织审核" },
  initialForm: { type: Object, default: () => ({}) },
  resubmission: { type: Boolean, default: false },
  smsRegistrationEnabled: { type: Boolean, default: false },
  captcha: { type: Object, default: () => ({ enabled: false, region: "cn", prefix: "", sceneId: "" }) }
});
const form = reactive({
  name: props.initialForm.name || "", phone: props.initialForm.phone || "", password: "", organizationName: props.initialForm.organizationName || "", creditCode: props.initialForm.creditCode || "",
  documentType: "business_license", credential: null
});
const submitting = ref(false);
const phoneVerificationToken = ref("");
const phoneVerification = ref(null);
const fileHint = "支持 PNG、JPEG、PDF，最大 10MB";
const canSubmit = computed(() => (
  !submitting.value && (props.resubmission || (props.smsRegistrationEnabled && Boolean(phoneVerificationToken.value)))
));

function selectFile(event) {
  form.credential = event.target.files?.[0] || null;
}

function normalizeCreditCode() {
  form.creditCode = String(form.creditCode || "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 18);
}

function validateFile() {
  if (!form.credential) return "请上传组织资质文件";
  if (form.credential.size > 10 * 1024 * 1024) return "资质文件不能超过 10MB";
  if (!["image/png", "image/jpeg", "application/pdf"].includes(form.credential.type)) return "仅支持 PNG、JPEG、PDF 格式";
  return "";
}

async function submit() {
  if (submitting.value) return;
  if (!props.resubmission && !props.smsRegistrationEnabled) return emit("error", "注册暂不可用");
  if (!props.resubmission && !phoneVerificationToken.value) return emit("error", "请先完成手机号验证");
  const fileError = validateFile();
  if (fileError) return emit("error", fileError);
  submitting.value = true;
  try {
    const data = new FormData();
    for (const field of (props.resubmission ? ["organizationName", "creditCode", "documentType"] : ["name", "phone", "password", "organizationName", "creditCode", "documentType"])) data.append(field, form[field]);
    if (!props.resubmission) data.append("phoneVerificationToken", phoneVerificationToken.value);
    data.append("credential", form.credential);
    const payload = await api(props.endpoint, { method: props.method, body: data });
    emit("registered", payload.user);
  } catch (error) {
    const message = String(error?.message || "注册失败，请重试");
    if (!props.resubmission && message.includes("手机号验证已过期")) phoneVerification.value?.invalidate?.("credential-expired");
    emit("error", props.resubmission ? error : message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="panel auth-panel org-register" data-register="organization" @submit.prevent="submit">
    <h3>组织负责人注册</h3>
    <p class="hint">一个账号负责一个组织。提交资质后需等待平台审核，通过后即可管理本组织赛事事务。</p>
    <template v-if="!resubmission">
      <label>负责人姓名<input data-testid="organization-owner-name" v-model="form.name" placeholder="负责人/领队老师姓名" required /></label>
      <RegistrationPhoneVerification
        ref="phoneVerification"
        v-model:phone="form.phone"
        v-model:phone-verification-token="phoneVerificationToken"
        :enabled="smsRegistrationEnabled"
        :captcha="captcha"
        phone-input-test-id="organization-phone"
        @error="emit('error', $event)"
      />
      <label>密码<input data-testid="organization-password" v-model="form.password" type="password" required /></label>
    </template>
    <label>组织名称<input data-testid="organization-name" v-model="form.organizationName" placeholder="学校、青少年宫或活动中心" required /></label>
    <label>统一社会信用代码<input data-testid="organization-credit-code" v-model="form.creditCode" pattern="[0-9A-Z]{18}" maxlength="18" placeholder="18 位统一社会信用代码" required @input="normalizeCreditCode" /></label>
    <label>证件类型
      <select v-model="form.documentType"><option value="business_license">营业执照</option><option value="public_institution_certificate">事业单位法人证书</option><option value="school_license">办学许可证</option></select>
    </label>
    <label>资质文件<input data-testid="organization-credential" type="file" accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf" required @change="selectFile" /><small>{{ fileHint }}</small></label>
    <button data-testid="organization-submit" class="primary" :disabled="!canSubmit" :aria-busy="submitting">{{ submitting ? "提交中…" : submitLabel }}</button>
  </form>
</template>
