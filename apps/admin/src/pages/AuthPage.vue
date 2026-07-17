<script setup>
import { onMounted, reactive, ref } from "vue";

import { api } from "../lib/api.js";
import OrdinaryRegistrationForm from "../components/OrdinaryRegistrationForm.vue";
import OrganizationRegistrationForm from "../components/OrganizationRegistrationForm.vue";

defineProps({ eventName: { type: String, default: "" } });
const emit = defineEmits(["login"]);
const currentView = ref("login");
const message = ref("");
const smsPasswordResetEnabled = ref(false);
const resetStep = ref("request");
const loginForm = reactive({ phone: "13800000001", password: "123456" });
const resetForm = reactive({ phone: "", code: "", password: "" });

function showError(error) { message.value = error; }
function registered(user) {
  loginForm.phone = user?.phone || loginForm.phone;
  loginForm.password = "";
  currentView.value = "login";
  message.value = "注册成功，请登录";
}

async function requestPasswordReset() {
  message.value = "";
  try {
    const payload = await api("/api/auth/password-reset/sms/request", { method: "POST", body: JSON.stringify({ phone: resetForm.phone }) });
    resetStep.value = "confirm";
    message.value = payload.message || "验证码已发送，请在 5 分钟内完成验证";
  } catch (error) { showError(error.message); }
}

async function confirmPasswordReset() {
  message.value = "";
  try {
    const payload = await api("/api/auth/password-reset/sms/confirm", { method: "POST", body: JSON.stringify({ ...resetForm }) });
    loginForm.phone = resetForm.phone;
    Object.assign(resetForm, { phone: "", code: "", password: "" });
    resetStep.value = "request";
    currentView.value = "login";
    message.value = payload.message || "密码已重置，请登录";
  } catch (error) { showError(error.message); }
}

onMounted(async () => {
  const features = await api("/api/public/features").catch(() => ({ smsPasswordResetEnabled: false }));
  smsPasswordResetEnabled.value = Boolean(features.smsPasswordResetEnabled);
});
</script>

<template>
  <div class="auth-shell">
    <header class="auth-header"><div class="logo">航</div><div><h1>赛事报名系统</h1><p>{{ eventName || "2026年温州市青少年航空航天创新比赛" }}</p></div></header>
    <nav class="auth-tabs"><button data-auth-tab="login" :class="{ active: currentView === 'login' }" @click="currentView = 'login'">登录</button><button data-auth-tab="register" :class="{ active: currentView === 'register' }" @click="currentView = 'register'">注册</button></nav>
    <p v-if="message" class="message">{{ message }}</p>
    <section v-if="currentView === 'login'" class="auth-grid single"><form class="panel auth-panel" data-auth-form="login" @submit.prevent="emit('login', { ...loginForm })"><h3>账号登录</h3><label>手机号<input v-model="loginForm.phone" /></label><label>密码<input v-model="loginForm.password" type="password" /></label><button class="primary">登录</button><button type="button" class="link-button" @click="currentView = 'forgot'">忘记密码？</button><p class="hint">测试账号：普通用户 13800000001 / 123456；组织用户 13800000011 / 123456；管理员 13900000000 / admin123。</p></form></section>
    <section v-else-if="currentView === 'register'" class="auth-grid register-choice"><OrdinaryRegistrationForm @registered="registered" @error="showError" /><OrganizationRegistrationForm @registered="registered" @error="showError" /></section>
    <section v-else class="auth-grid single">
      <form v-if="smsPasswordResetEnabled && resetStep === 'request'" class="panel auth-panel" @submit.prevent="requestPasswordReset"><h3>找回密码</h3><p class="hint">验证码将发送到注册手机号，5 分钟内有效。</p><label>手机号<input v-model="resetForm.phone" placeholder="注册手机号" /></label><button class="primary">发送验证码</button></form>
      <form v-else-if="smsPasswordResetEnabled" class="panel auth-panel" @submit.prevent="confirmPasswordReset"><h3>验证并重置密码</h3><label>手机号<input v-model="resetForm.phone" disabled /></label><label>短信验证码<input v-model="resetForm.code" inputmode="numeric" /></label><label>新密码<input v-model="resetForm.password" type="password" /></label><button class="primary">确认重置</button><button type="button" class="link-button" @click="resetStep = 'request'">重新获取验证码</button></form>
      <section v-else class="panel auth-panel"><h3>找回密码</h3><p class="hint">短信找回暂未启用，请联系赛事管理员重置临时密码。</p></section>
    </section>
  </div>
</template>
