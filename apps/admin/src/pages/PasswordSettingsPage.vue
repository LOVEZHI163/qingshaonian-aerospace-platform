<script setup>
import { reactive, ref } from "vue";

import { api } from "../lib/api.js";

defineProps({ forced: { type: Boolean, default: false } });
const emit = defineEmits(["changed", "logout"]);
const form = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
const busy = ref(false);
const error = ref("");
const success = ref("");

function validateNewPassword(value) {
  if (value.length < 8) return "密码至少 8 位";
  if (value.length > 64) return "密码最多 64 位";
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return "密码必须同时包含字母和数字";
  return "";
}

async function submit() {
  error.value = "";
  success.value = "";
  const passwordError = validateNewPassword(form.newPassword);
  if (passwordError) {
    error.value = passwordError;
    return;
  }
  if (form.newPassword !== form.confirmPassword) {
    error.value = "两次输入的新密码不一致";
    return;
  }
  busy.value = true;
  try {
    const payload = await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword })
    });
    Object.assign(form, { currentPassword: "", newPassword: "", confirmPassword: "" });
    success.value = "密码修改成功";
    emit("changed", payload.user);
  } catch (cause) {
    error.value = cause.message || "密码修改失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="password-settings-page" :class="{ 'forced-password-settings': forced }" data-testid="password-settings-page">
    <form class="panel password-settings-form" @submit.prevent="submit">
      <h3>{{ forced ? "首次登录请修改密码" : "修改密码" }}</h3>
      <p class="hint">{{ forced ? "管理员为你设置的是临时密码。修改完成后才能进入系统，不能跳过此步骤。" : "修改成功后，其他设备上的登录会话将失效。" }}</p>
      <label>当前{{ forced ? "临时" : "" }}密码<input v-model="form.currentPassword" name="currentPassword" type="password" autocomplete="current-password" required /></label>
      <label>新密码<input v-model="form.newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="64" placeholder="8–64 位，必须同时包含字母和数字" required /></label>
      <label>确认新密码<input v-model="form.confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="64" required /></label>
      <div class="form-actions">
        <button class="primary" :disabled="busy">{{ busy ? "正在修改…" : forced ? "修改密码并进入系统" : "保存新密码" }}</button>
        <button v-if="forced" type="button" class="ghost" data-action="password-logout" :disabled="busy" @click="emit('logout')">退出登录</button>
      </div>
      <p v-if="error" class="message" role="alert">{{ error }}</p>
      <p v-if="success" class="success-message" role="status">{{ success }}</p>
    </form>
  </section>
</template>
