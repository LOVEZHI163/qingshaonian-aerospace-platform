<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";

import { api } from "../lib/api.js";
import OrdinaryRegistrationForm from "../components/OrdinaryRegistrationForm.vue";
import OrganizationRegistrationForm from "../components/OrganizationRegistrationForm.vue";
import AliyunCaptchaGate from "../components/AliyunCaptchaGate.vue";

const props = defineProps({
  eventName: { type: String, default: "" },
  loginError: { type: String, default: "" }
});
const emit = defineEmits(["login", "sms-login", "clear-message", "account-email-action-complete"]);
const currentView = ref("login");
const registrationType = ref("ordinary");
const message = ref("");
const smsRegistrationEnabled = ref(false);
const smsPasswordResetEnabled = ref(false);
const smsLoginEnabled = ref(false);
const emailPasswordResetEnabled = ref(false);
const loginMethod = ref("password");
const resetMethod = ref("email");
const resetStep = ref("request");
const linkToken = ref("");
const linkChecking = ref(false);
const linkValid = ref(false);
const emailVerificationConfirmed = ref(false);
const loginForm = reactive({ phone: "13800000001", password: "123456" });
const smsLoginForm = reactive({ phone: "", code: "" });
const resetForm = reactive({ phone: "", code: "", password: "" });
const emailResetForm = reactive({ email: "", password: "", confirmation: "" });
const sendCountdown = reactive({ login: 0, reset: 0 });
const captcha = reactive({ enabled: false, region: "cn", prefix: "", scenes: {} });
const smsLoginCaptcha = ref(null);
const smsResetCaptcha = ref(null);
const emailResetCaptcha = ref(null);
let countdownTimer = null;

function startCountdown(kind) {
  sendCountdown[kind] = 60;
  if (countdownTimer) return;
  countdownTimer = window.setInterval(() => {
    for (const key of ["login", "reset"]) sendCountdown[key] = Math.max(0, sendCountdown[key] - 1);
    if (!sendCountdown.login && !sendCountdown.reset) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 1_000);
}

function showError(error) { message.value = error; }
function switchView(view) {
  currentView.value = view;
  message.value = "";
  emit("clear-message");
}
function clearLoginError() {
  if (props.loginError) emit("clear-message");
}
function registered(user) {
  loginForm.phone = user?.phone || loginForm.phone;
  loginForm.password = "";
  currentView.value = "login";
  message.value = "注册成功，请登录";
}

async function requestPasswordReset() {
  message.value = "";
  try {
    const captchaVerifyParam = await smsResetCaptcha.value?.execute?.() || "";
    const payload = await api("/api/auth/password-reset/sms/request", { method: "POST", body: JSON.stringify({ phone: resetForm.phone, captchaVerifyParam }) });
    resetStep.value = "confirm";
    startCountdown("reset");
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

async function requestSmsLoginCode() {
  if (sendCountdown.login) return;
  message.value = "";
  try {
    const captchaVerifyParam = await smsLoginCaptcha.value?.execute?.() || "";
    const payload = await api("/api/auth/sms-login/request", {
      method: "POST",
      body: JSON.stringify({ phone: smsLoginForm.phone, captchaVerifyParam })
    });
    startCountdown("login");
    message.value = payload.message || "如果该手机号已注册，验证码将发送到该号码";
  } catch (error) { showError(error.message); }
}

function submitSmsLogin() {
  message.value = "";
  if (!/^\d{6}$/.test(smsLoginForm.code)) {
    message.value = "请输入 6 位短信验证码";
    return;
  }
  emit("sms-login", { phone: smsLoginForm.phone, code: smsLoginForm.code });
}

async function requestEmailPasswordReset() {
  message.value = "";
  try {
    const captchaVerifyParam = await emailResetCaptcha.value?.execute?.() || "";
    const payload = await api("/api/auth/password-reset/email/request", {
      method: "POST",
      body: JSON.stringify({ email: emailResetForm.email, captchaVerifyParam })
    });
    message.value = payload.message || "如果该邮箱已绑定账号，重置邮件将很快发出，请检查收件箱和垃圾邮件。";
  } catch (error) { showError(error.message); }
}

async function confirmEmailPasswordReset() {
  message.value = "";
  if (emailResetForm.password !== emailResetForm.confirmation) {
    message.value = "两次输入的新密码不一致";
    return;
  }
  try {
    const payload = await api("/api/auth/password-reset/email/confirm", {
      method: "POST",
      body: JSON.stringify({ token: linkToken.value, password: emailResetForm.password })
    });
    Object.assign(emailResetForm, { email: "", password: "", confirmation: "" });
    window.history.replaceState({}, "", window.location.pathname);
    currentView.value = "login";
    emit("account-email-action-complete");
    message.value = payload.message || "密码已重置，请登录";
  } catch (error) { showError(error.message); }
}

async function inspectEmailLink(view, token) {
  linkToken.value = token;
  linkChecking.value = true;
  currentView.value = view;
  try {
    if (view === "resetPassword") {
      const payload = await api(`/api/auth/password-reset/email/verify?token=${encodeURIComponent(token)}`);
      linkValid.value = Boolean(payload.ok);
      if (!linkValid.value) message.value = "该重置链接无效或已经过期，请重新申请。";
    } else {
      const payload = await api(`/api/auth/email/verification/verify?token=${encodeURIComponent(token)}`);
      linkValid.value = Boolean(payload.ok);
    }
  } catch (error) {
    linkValid.value = false;
    message.value = error.message || "链接无效或已经过期";
  } finally { linkChecking.value = false; }
}

async function confirmEmailVerification() {
  message.value = "";
  try {
    const payload = await api("/api/auth/email/verification/confirm", {
      method: "POST",
      body: JSON.stringify({ token: linkToken.value })
    });
    emailVerificationConfirmed.value = true;
    linkValid.value = false;
    message.value = payload.message || "邮箱验证成功，现在可以用于找回密码。";
  } catch (error) { showError(error.message); }
}

function finishEmailAction() {
  emit("account-email-action-complete");
  switchView("login");
}

onMounted(async () => {
  const features = await api("/api/public/features").catch(() => ({ smsRegistrationEnabled: false, smsPasswordResetEnabled: false, emailPasswordResetEnabled: false }));
  smsRegistrationEnabled.value = Boolean(features.smsRegistrationEnabled);
  smsPasswordResetEnabled.value = Boolean(features.smsPasswordResetEnabled);
  smsLoginEnabled.value = Boolean(features.smsLoginEnabled);
  emailPasswordResetEnabled.value = Boolean(features.emailPasswordResetEnabled);
  Object.assign(captcha, {
    enabled: Boolean(features.captcha?.enabled),
    region: features.captcha?.region || "cn",
    prefix: features.captcha?.prefix || "",
    scenes: features.captcha?.scenes || {}
  });
  resetMethod.value = emailPasswordResetEnabled.value ? "email" : "sms";
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const token = params.get("token");
  if ((view === "resetPassword" || view === "verifyEmail") && token) {
    window.history.replaceState({}, "", window.location.pathname);
    await inspectEmailLink(view, token);
  }
});

onBeforeUnmount(() => {
  if (countdownTimer) window.clearInterval(countdownTimer);
});
</script>

<template>
  <div class="auth-shell">
    <header class="auth-header">
      <a class="auth-brand" href="/" aria-label="返回温州青少年航空官网">
        <span class="auth-brand-mark"><img :src="'/brand/mark.svg'" alt="" /></span>
        <span class="auth-brand-copy"><h1>赛事报名系统</h1></span>
      </a>
      <div class="auth-event-context"><span>当前赛事</span><p>{{ props.eventName || "2026年温州市青少年航空航天创新比赛" }}</p></div>
    </header>
    <nav class="auth-tabs"><button type="button" data-auth-tab="login" :class="{ active: currentView === 'login' }" @click="switchView('login')">登录</button><button type="button" data-auth-tab="register" :class="{ active: currentView === 'register' }" @click="switchView('register')">注册</button></nav>
    <p v-if="message" class="message">{{ message }}</p>
    <section v-if="currentView === 'login'" class="auth-grid single"><section class="panel auth-panel"><h3>账号登录</h3><p class="hint">普通用户、组织负责人和赛事管理员均从这里登录。</p><div v-if="smsLoginEnabled" class="auth-tabs auth-method-tabs" aria-label="登录方式"><button type="button" data-login-method="password" :class="{ active: loginMethod === 'password' }" @click="loginMethod = 'password'">密码登录</button><button type="button" data-login-method="sms" :class="{ active: loginMethod === 'sms' }" @click="loginMethod = 'sms'">短信验证码登录</button></div><form v-if="loginMethod === 'password'" data-auth-form="login" @submit.prevent="emit('login', { ...loginForm })"><label>手机号<input v-model="loginForm.phone" autocomplete="username" inputmode="tel" @input="clearLoginError" /></label><label>密码<input v-model="loginForm.password" type="password" autocomplete="current-password" :aria-invalid="Boolean(props.loginError)" :aria-describedby="props.loginError ? 'login-error' : undefined" @input="clearLoginError" /></label><button class="primary">登录</button></form><form v-else data-auth-form="sms-login" @submit.prevent="submitSmsLogin"><label>手机号<input v-model="smsLoginForm.phone" data-testid="sms-login-phone" autocomplete="username" inputmode="tel" required @input="clearLoginError" /></label><label>短信验证码<span class="auth-inline-input"><input v-model="smsLoginForm.code" data-testid="sms-login-code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" required :aria-invalid="Boolean(props.loginError)" :aria-describedby="props.loginError ? 'login-error' : undefined" @input="clearLoginError" /><button type="button" class="mini" data-testid="sms-login-send" :disabled="Boolean(sendCountdown.login)" @click="requestSmsLoginCode">{{ sendCountdown.login ? `重新发送（${sendCountdown.login}s）` : '获取验证码' }}</button></span></label><AliyunCaptchaGate ref="smsLoginCaptcha" :enabled="captcha.enabled" :region="captcha.region" :prefix="captcha.prefix" :scene-id="captcha.scenes.smsLogin || ''" /><button class="primary">登录</button></form><p v-if="props.loginError" id="login-error" class="auth-field-error" data-testid="login-error" role="alert">登录失败：{{ props.loginError }}</p><button type="button" class="link-button" data-auth-view="forgot" @click="switchView('forgot')">忘记密码？</button></section></section>
    <section v-else-if="currentView === 'register'" class="auth-grid register-flow">
      <section class="panel auth-registration-picker" aria-labelledby="registration-type-title">
        <div><p class="eyebrow">选择账号类型</p><h3 id="registration-type-title">你要注册哪种账号？</h3><p class="hint">账号类型关系到后续可以使用的功能，请按实际身份选择。</p></div>
        <div class="registration-type-options" role="group" aria-label="注册账号类型">
          <button type="button" data-register-type="ordinary" :class="{ active: registrationType === 'ordinary' }" :aria-pressed="registrationType === 'ordinary'" @click="registrationType = 'ordinary'"><strong>个人参赛账号</strong><span>适合学生、家长和个人参赛者</span></button>
          <button type="button" data-register-type="organization" :class="{ active: registrationType === 'organization' }" :aria-pressed="registrationType === 'organization'" @click="registrationType = 'organization'"><strong>组织负责人账号</strong><span>适合学校、青少年宫、科技馆和活动中心</span></button>
        </div>
      </section>
      <OrdinaryRegistrationForm
        v-if="registrationType === 'ordinary'"
        :sms-registration-enabled="smsRegistrationEnabled"
        :captcha="{ enabled: captcha.enabled, region: captcha.region, prefix: captcha.prefix, sceneId: captcha.scenes.smsRegistration || '' }"
        @registered="registered"
        @error="showError"
      />
      <OrganizationRegistrationForm
        v-else
        :sms-registration-enabled="smsRegistrationEnabled"
        :captcha="{ enabled: captcha.enabled, region: captcha.region, prefix: captcha.prefix, sceneId: captcha.scenes.smsRegistration || '' }"
        @registered="registered"
        @error="showError"
      />
    </section>
    <section v-else-if="currentView === 'forgot'" class="auth-grid single">
      <section class="panel auth-panel">
        <h3>找回密码</h3>
        <p class="hint">可通过已验证邮箱的安全链接找回；手机短信功能已启用时也可使用验证码。</p>
        <div v-if="emailPasswordResetEnabled || smsPasswordResetEnabled" class="auth-tabs" aria-label="找回方式">
          <button v-if="emailPasswordResetEnabled" type="button" data-reset-method="email" :class="{ active: resetMethod === 'email' }" @click="resetMethod = 'email'; resetStep = 'request'">邮箱链接</button>
          <button v-if="smsPasswordResetEnabled" type="button" data-reset-method="sms" :class="{ active: resetMethod === 'sms' }" @click="resetMethod = 'sms'; resetStep = 'request'">手机验证码</button>
        </div>
        <form v-if="emailPasswordResetEnabled && resetMethod === 'email'" data-testid="email-reset-request" @submit.prevent="requestEmailPasswordReset">
          <label>已验证邮箱<input v-model.trim="emailResetForm.email" data-testid="reset-email" type="email" autocomplete="email" placeholder="name@example.com" required /></label>
          <p class="hint">提交后请到邮箱点击重置链接。为保护账号安全，无论邮箱是否存在，页面提示都相同。</p>
          <AliyunCaptchaGate ref="emailResetCaptcha" :enabled="captcha.enabled" :region="captcha.region" :prefix="captcha.prefix" :scene-id="captcha.scenes.emailPasswordReset || ''" />
          <button class="primary">发送重置链接</button>
        </form>
        <form v-else-if="smsPasswordResetEnabled && resetMethod === 'sms' && resetStep === 'request'" @submit.prevent="requestPasswordReset"><p class="hint">验证码将发送到注册手机号，5 分钟内有效。</p><label>手机号<input v-model="resetForm.phone" placeholder="注册手机号" /></label><AliyunCaptchaGate ref="smsResetCaptcha" :enabled="captcha.enabled" :region="captcha.region" :prefix="captcha.prefix" :scene-id="captcha.scenes.smsPasswordReset || ''" /><button class="primary" :disabled="Boolean(sendCountdown.reset)">{{ sendCountdown.reset ? `重新发送（${sendCountdown.reset}s）` : '发送验证码' }}</button></form>
        <form v-else-if="smsPasswordResetEnabled && resetMethod === 'sms'" @submit.prevent="confirmPasswordReset"><h4>验证并重置密码</h4><label>手机号<input v-model="resetForm.phone" disabled /></label><label>短信验证码<input v-model="resetForm.code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" required /></label><label>新密码<input v-model="resetForm.password" type="password" autocomplete="new-password" required /></label><button class="primary">确认重置</button><button type="button" class="link-button" @click="resetStep = 'request'">重新获取验证码</button></form>
        <p v-else class="hint">自助找回暂未启用，请联系赛事管理员重置临时密码。</p>
        <button type="button" class="link-button" @click="switchView('login')">返回登录</button>
      </section>
    </section>
    <section v-else-if="currentView === 'resetPassword'" class="auth-grid single">
      <form class="panel auth-panel" data-auth-form="email-reset-confirm" @submit.prevent="confirmEmailPasswordReset">
        <h3>设置新密码</h3><p v-if="linkChecking" class="hint">正在验证重置链接……</p>
        <template v-else-if="linkValid"><p class="hint">链接验证通过，请设置新的登录密码。</p><label>新密码<input v-model="emailResetForm.password" data-testid="reset-new-password" type="password" autocomplete="new-password" required /></label><label>再次输入新密码<input v-model="emailResetForm.confirmation" data-testid="reset-confirm-password" type="password" autocomplete="new-password" required /></label><button class="primary">确认重置密码</button></template>
        <template v-else><p class="hint">该链接无效、已使用或已经过期，请重新申请。</p><button type="button" class="primary" @click="switchView('forgot')">重新找回密码</button></template>
      </form>
    </section>
    <section v-else-if="currentView === 'verifyEmail'" class="auth-grid single"><section class="panel auth-panel"><h3>验证邮箱</h3><p class="hint">{{ linkChecking ? '正在检查邮箱链接……' : (emailVerificationConfirmed ? '邮箱验证成功，现在可以用于找回密码。' : (linkValid ? '链接有效，请点击按钮确认绑定邮箱。' : '验证链接无效或已经过期。')) }}</p><button v-if="linkValid && !emailVerificationConfirmed" type="button" class="primary" data-testid="confirm-email-verification" @click="confirmEmailVerification">确认验证邮箱</button><button v-else type="button" class="primary" @click="finishEmailAction">返回登录</button></section></section>
    <section v-else class="auth-grid single">
      <section class="panel auth-panel"><h3>无法打开链接</h3><button type="button" class="primary" @click="switchView('login')">返回登录</button></section>
    </section>
  </div>
</template>
