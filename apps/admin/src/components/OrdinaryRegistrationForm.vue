<script setup>
import { reactive, ref } from "vue";

import { api } from "../lib/api.js";

const emit = defineEmits(["registered", "error"]);
const form = reactive({ name: "", phone: "", password: "" });
const submitting = ref(false);

async function submit() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const payload = await api("/api/auth/register/ordinary", { method: "POST", body: JSON.stringify({ ...form }) });
    emit("registered", payload.user);
  } catch (error) {
    emit("error", error.message);
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
    <label>手机号<input data-testid="ordinary-phone" v-model="form.phone" placeholder="用于登录和查重" required /></label>
    <label>密码<input data-testid="ordinary-password" v-model="form.password" type="password" required /></label>
    <button class="primary" :disabled="submitting">创建个人账号</button>
  </form>
</template>
