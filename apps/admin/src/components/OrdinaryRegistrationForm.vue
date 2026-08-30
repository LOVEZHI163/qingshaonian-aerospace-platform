<script setup>
import { computed, reactive, ref } from "vue";

import { api } from "../lib/api.js";
import RegistrationPhoneVerification from "./RegistrationPhoneVerification.vue";

const emit = defineEmits(["registered", "error"]);
const props = defineProps({
  smsRegistrationEnabled: { type: Boolean, default: false },
  captcha: { type: Object, default: () => ({ enabled: false, region: "cn", prefix: "", sceneId: "" }) }
});
const form = reactive({ name: "", phone: "", password: "" });
const submitting = ref(false);
const phoneVerificationToken = ref("");
const phoneVerification = ref(null);
const canSubmit = computed(() => (
  props.smsRegistrationEnabled && Boolean(phoneVerificationToken.value) && !submitting.value
));

async function submit() {
  if (submitting.value) return;
  if (!props.smsRegistrationEnabled) return emit("error", "注册暂不可用");
  if (!phoneVerificationToken.value) return emit("error", "请先完成手机号验证");
  submitting.value = true;
  try {
    const payload = await api("/api/auth/register/ordinary", {
      method: "POST",
      body: JSON.stringify({ ...form, phoneVerificationToken: phoneVerificationToken.value })
    });
    emit("registered", payload.user);
  } catch (error) {
    const message = String(error?.message || "注册失败，请重试");
    if (message.includes("手机号验证已过期")) phoneVerification.value?.invalidate?.("credential-expired");
    emit("error", message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="panel auth-panel" data-register="ordinary" @submit.prevent="submit">
    <h3>个人账号注册</h3>
    <p class="hint">适合学生、家长、个人参赛者。注册后可以报名，也可以向组织发送加入申请。</p>
    <label>姓名<input data-testid="ordinary-name" v-model="form.name" placeholder="学生/家长/老师姓名" required /></label>
    <RegistrationPhoneVerification
      ref="phoneVerification"
      v-model:phone="form.phone"
      v-model:phone-verification-token="phoneVerificationToken"
      :enabled="smsRegistrationEnabled"
      :captcha="captcha"
      phone-input-test-id="ordinary-phone"
      @error="emit('error', $event)"
    />
    <label>密码<input data-testid="ordinary-password" v-model="form.password" type="password" required /></label>
    <button data-testid="ordinary-submit" class="primary" :disabled="!canSubmit" :aria-busy="submitting">{{ submitting ? "提交中…" : "创建个人账号" }}</button>
  </form>
</template>
