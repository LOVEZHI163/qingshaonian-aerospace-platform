<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { api } from "../lib/api.js";
import AliyunCaptchaGate from "./AliyunCaptchaGate.vue";

const props = defineProps({
  enabled: { type: Boolean, default: false },
  phone: { type: String, default: "" },
  phoneVerificationToken: { type: String, default: "" },
  phoneInputTestId: { type: String, default: "registration-phone" },
  captcha: {
    type: Object,
    default: () => ({ enabled: false, region: "cn", prefix: "", sceneId: "" })
  }
});
const emit = defineEmits([
  "update:phone",
  "update:phoneVerificationToken",
  "verified",
  "invalidated",
  "error"
]);

const code = ref("");
const secondsRemaining = ref(0);
const verifiedPhone = ref("");
const phoneVerificationToken = ref("");
const requesting = ref(false);
const confirming = ref(false);
const statusMessage = ref("");
const errorMessage = ref("");
const captchaGate = ref(null);
let countdownTimer = null;
let expirationTimer = null;

const normalizedPhone = computed(() => String(props.phone || "").replace(/\D/g, ""));
const validPhone = computed(() => /^1[3-9]\d{9}$/.test(normalizedPhone.value));
const isVerified = computed(() => Boolean(phoneVerificationToken.value && verifiedPhone.value));
const requestDisabled = computed(() => (
  !props.enabled || requesting.value || Boolean(secondsRemaining.value) || !validPhone.value || isVerified.value
));
const confirmDisabled = computed(() => (
  !props.enabled || confirming.value || isVerified.value || !/^\d{6}$/.test(code.value)
));

function clearExpirationTimer() {
  if (!expirationTimer) return;
  window.clearTimeout(expirationTimer);
  expirationTimer = null;
}

function clearCountdownTimer() {
  if (!countdownTimer) return;
  window.clearInterval(countdownTimer);
  countdownTimer = null;
}

function resetCredentialState() {
  clearExpirationTimer();
  code.value = "";
  verifiedPhone.value = "";
  phoneVerificationToken.value = "";
  statusMessage.value = "";
}

function invalidate(reason, { notify = true } = {}) {
  const hadCredential = Boolean(phoneVerificationToken.value || props.phoneVerificationToken);
  resetCredentialState();
  if (hadCredential) emit("update:phoneVerificationToken", "");
  if (notify && hadCredential) emit("invalidated", { reason });
}

function updatePhone(event) {
  const nextPhone = event.target.value;
  if (isVerified.value && nextPhone !== props.phone) invalidate("phone-changed");
  emit("update:phone", nextPhone);
  errorMessage.value = "";
  statusMessage.value = "";
}

function updateCode(event) {
  code.value = String(event.target.value || "").replace(/\D/g, "").slice(0, 6);
  errorMessage.value = "";
}

function startCountdown() {
  clearCountdownTimer();
  secondsRemaining.value = 60;
  countdownTimer = window.setInterval(() => {
    secondsRemaining.value = Math.max(0, secondsRemaining.value - 1);
    if (!secondsRemaining.value) clearCountdownTimer();
  }, 1_000);
}

function startExpiration(expiresAt) {
  clearExpirationTimer();
  const delay = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) {
    invalidate("expired");
    return;
  }
  expirationTimer = window.setTimeout(() => invalidate("expired"), delay);
}

function reportError(error, fallback) {
  const message = String(error?.message || fallback);
  errorMessage.value = message;
  emit("error", message);
}

async function requestCode() {
  if (requestDisabled.value) return;
  requesting.value = true;
  errorMessage.value = "";
  statusMessage.value = "";
  try {
    const captchaVerifyParam = await captchaGate.value?.execute?.() || "";
    const payload = await api("/api/auth/register/sms/request", {
      method: "POST",
      body: JSON.stringify({ phone: normalizedPhone.value, captchaVerifyParam })
    });
    startCountdown();
    statusMessage.value = String(payload?.message || "验证码请求已受理");
  } catch (error) {
    reportError(error, "验证码发送失败，请重试");
  } finally {
    requesting.value = false;
  }
}

async function confirmCode() {
  if (confirmDisabled.value) return;
  confirming.value = true;
  errorMessage.value = "";
  try {
    const payload = await api("/api/auth/register/sms/confirm", {
      method: "POST",
      body: JSON.stringify({ phone: normalizedPhone.value, code: code.value })
    });
    const token = String(payload?.phoneVerificationToken || "");
    const expiresAt = String(payload?.expiresAt || "");
    if (!token || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new Error("手机号验证已过期，请重新验证");
    }
    phoneVerificationToken.value = token;
    verifiedPhone.value = normalizedPhone.value;
    statusMessage.value = "手机号已验证";
    emit("update:phone", normalizedPhone.value);
    emit("update:phoneVerificationToken", token);
    emit("verified", { phone: normalizedPhone.value });
    startExpiration(expiresAt);
  } catch (error) {
    resetCredentialState();
    emit("update:phoneVerificationToken", "");
    reportError(error, "验证码无效或已过期");
  } finally {
    confirming.value = false;
  }
}

function editPhone() {
  invalidate("edit");
  statusMessage.value = "";
  errorMessage.value = "";
}

watch(() => props.phone, (phone, previousPhone) => {
  if (phone !== previousPhone && isVerified.value && String(phone || "") !== verifiedPhone.value) {
    invalidate("phone-changed");
  }
});

watch(() => props.phoneVerificationToken, (token) => {
  if (!token && phoneVerificationToken.value) resetCredentialState();
});

watch(() => props.enabled, (enabled) => {
  if (!enabled) invalidate("disabled");
});

onBeforeUnmount(() => {
  clearCountdownTimer();
  clearExpirationTimer();
  invalidate("unmounted");
});

defineExpose({ invalidate });
</script>

<template>
  <section class="registration-phone-verification" aria-labelledby="registration-phone-title">
    <template v-if="enabled">
      <h4 id="registration-phone-title">验证注册手机号</h4>
      <label>
        手机号
        <span class="auth-inline-input">
          <input
            :value="phone"
            :data-testid="phoneInputTestId"
            autocomplete="tel"
            inputmode="tel"
            placeholder="用于登录和查重"
            required
            :disabled="isVerified"
            :aria-describedby="errorMessage ? 'registration-phone-error' : 'registration-phone-status'"
            :aria-invalid="Boolean(errorMessage)"
            @input="updatePhone"
          />
          <button
            type="button"
            class="mini registration-sms-action"
            data-testid="registration-sms-request"
            :disabled="requestDisabled"
            :aria-busy="requesting"
            @click="requestCode"
          >{{ requesting ? "发送中…" : (secondsRemaining ? `重新发送（${secondsRemaining}s）` : "获取验证码") }}</button>
        </span>
      </label>
      <AliyunCaptchaGate
        v-if="enabled"
        ref="captchaGate"
        :enabled="Boolean(captcha.enabled)"
        :region="captcha.region || 'cn'"
        :prefix="captcha.prefix || ''"
        :scene-id="captcha.sceneId || ''"
      />
      <div v-if="isVerified" class="registration-phone-verified" role="status">
        <span>手机号已验证</span>
        <button type="button" class="link-button" data-testid="registration-change-phone" @click="editPhone">修改手机号</button>
      </div>
      <label v-else>
        短信验证码
        <span class="auth-inline-input">
          <input
            :value="code"
            data-testid="registration-sms-code"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            pattern="[0-9]{6}"
            placeholder="6 位验证码"
            required
            :aria-invalid="Boolean(errorMessage)"
            :aria-describedby="errorMessage ? 'registration-phone-error' : undefined"
            @input="updateCode"
          />
          <button
            type="button"
            class="mini registration-sms-action"
            data-testid="registration-sms-confirm"
            :disabled="confirmDisabled"
            :aria-busy="confirming"
            @click="confirmCode"
          >{{ confirming ? "验证中…" : "验证手机号" }}</button>
        </span>
      </label>
      <p v-if="errorMessage" id="registration-phone-error" class="auth-field-error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="statusMessage" id="registration-phone-status" class="hint registration-phone-status" aria-live="polite">{{ statusMessage }}</p>
    </template>
    <p v-else class="registration-unavailable" role="status">注册暂不可用，请稍后再试或联系赛事管理员。</p>
  </section>
</template>
