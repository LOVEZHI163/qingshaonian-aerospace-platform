<script setup>
import { computed, onMounted, reactive, ref } from "vue";

import { api } from "../lib/api.js";

const emit = defineEmits(["error"]);
const users = ref([]);
const organizations = ref([]);
const selectedDetails = ref(null);
const search = ref("");
const typeFilter = ref("all");
const statusFilter = ref("all");
const message = ref("");
const temporaryPasswordDialog = ref(null);
const form = reactive({ id: "", name: "", phone: "", type: "ordinary", status: "active", organizationName: "", organizationCode: "" });

const roleText = { ordinary: "普通用户", organization: "组织用户", admin: "超级管理员" };
const filteredUsers = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return users.value.filter((user) => {
    if (typeFilter.value !== "all" && user.type !== typeFilter.value) return false;
    if (statusFilter.value !== "all" && (user.status || "active") !== statusFilter.value) return false;
    const organization = organizations.value.find((item) => item.ownerUserId === user.id);
    return !keyword || [user.name, user.phone, roleText[user.type], organization?.name, organization?.code]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(keyword));
  });
});

function ownerOrganization(userId) {
  return organizations.value.find((item) => item.ownerUserId === userId);
}

function resetForm() {
  Object.assign(form, { id: "", name: "", phone: "", type: "ordinary", status: "active", organizationName: "", organizationCode: "" });
}

function editUser(user) {
  const organization = ownerOrganization(user.id);
  Object.assign(form, {
    id: user.id, name: user.name, phone: user.phone, type: user.type, status: user.status || "active",
    organizationName: organization?.name || "", organizationCode: organization?.code || ""
  });
}

async function load() {
  try {
    const [userPayload, organizationPayload] = await Promise.all([
      api("/api/users"),
      api("/api/admin/organizations")
    ]);
    users.value = userPayload.rows || [];
    organizations.value = organizationPayload.rows || [];
  } catch (error) {
    emit("error", error.message);
  }
}

async function save() {
  message.value = "";
  try {
    const body = {
      name: form.name, phone: form.phone, type: form.type, status: form.status,
      organizationName: form.organizationName, organizationCode: form.organizationCode
    };
    const result = await api(form.id ? `/api/admin/users/${form.id}` : "/api/admin/users", {
      method: form.id ? "PATCH" : "POST",
      ...(!form.id ? { cache: "no-store" } : {}),
      body: JSON.stringify(body)
    });
    if (!form.id) {
      temporaryPasswordDialog.value = { userName: result.row.name, password: result.temporaryPassword };
    }
    message.value = form.id ? "用户已更新" : "用户已创建，请将系统生成的临时密码交给用户";
    resetForm();
    await load();
  } catch (error) {
    message.value = error.message;
  }
}

async function resetTemporaryPassword(user) {
  try {
    const result = await api(`/api/admin/users/${user.id}/reset-password`, { method: "POST", body: "{}", cache: "no-store" });
    user.mustChangePassword = true;
    temporaryPasswordDialog.value = { userName: user.name, password: result.temporaryPassword };
    message.value = "临时密码已生成；用户下次登录必须修改。";
  } catch (error) {
    message.value = error.message;
  }
}

async function viewTemporaryPassword(user) {
  try {
    const result = await api(`/api/admin/users/${user.id}/temporary-password`, { cache: "no-store" });
    temporaryPasswordDialog.value = { userName: user.name, password: result.temporaryPassword };
  } catch (error) { message.value = error.message; }
}

async function copyTemporaryPassword() {
  try {
    await navigator.clipboard?.writeText(temporaryPasswordDialog.value?.password || "");
    message.value = "临时密码已复制";
  } catch { message.value = "复制失败，请手动选择临时密码"; }
}

async function removeUser(user) {
  if (!window.confirm(`确认删除用户 ${user.name}？关联的组织关系会同步清理。`)) return;
  try {
    await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
    if (selectedDetails.value?.user?.id === user.id) selectedDetails.value = null;
    message.value = "用户已删除";
    await load();
  } catch (error) {
    message.value = error.message;
  }
}

async function showDetails(user) {
  try {
    const payload = await api(`/api/me/${user.id}`);
    selectedDetails.value = { ...payload, user };
  } catch (error) {
    message.value = error.message;
  }
}

onMounted(load);
</script>

<template>
  <section class="content-grid user-management-page" data-testid="user-management-page">
    <form class="panel form-panel" @submit.prevent="save">
      <div class="panel-title"><h3>{{ form.id ? "编辑用户" : "新增普通用户" }}</h3><button v-if="form.id" type="button" class="mini reject" @click="resetForm">取消编辑</button></div>
      <div class="two"><label>姓名<input v-model="form.name" required /></label><label>手机号<input v-model="form.phone" required /></label></div>
      <div class="two"><label>账号类型<select v-model="form.type" :disabled="Boolean(form.id)"><option value="ordinary">普通用户</option><option v-if="form.type === 'organization'" value="organization">组织用户</option></select></label><label>状态<select v-model="form.status"><option value="active">启用</option><option value="disabled">停用</option></select></label></div>
      <template v-if="form.type === 'organization'"><label>组织名称<input v-model="form.organizationName" /></label><label>组织代码<input v-model="form.organizationCode" /></label></template>
      <button class="primary">{{ form.id ? "保存修改" : "创建用户" }}</button>
      <p v-if="message" class="message">{{ message }}</p>
    </form>

    <section class="panel">
      <div class="panel-title"><h3>用户列表</h3><span>{{ filteredUsers.length }} 个</span></div>
      <div class="user-filter-grid">
        <input v-model="search" placeholder="搜索姓名/手机号/组织" />
        <select v-model="typeFilter" data-filter="user-type"><option value="all">全部类型</option><option value="ordinary">普通用户</option><option value="organization">组织用户</option><option value="admin">超级管理员</option></select>
        <select v-model="statusFilter" data-filter="user-status"><option value="all">全部状态</option><option value="active">启用</option><option value="disabled">停用</option></select>
      </div>
      <div class="table-wrap"><table class="user-table"><thead><tr><th>姓名</th><th>手机号</th><th>类型</th><th>组织关系</th><th>状态</th><th>操作</th></tr></thead><tbody>
        <tr v-for="user in filteredUsers" :key="user.id">
          <td>{{ user.name }}</td><td>{{ user.phone }}</td><td>{{ roleText[user.type] }}</td>
          <td>{{ ownerOrganization(user.id)?.name || "查看详情" }}</td><td><em :class="user.status">{{ user.status === "disabled" ? "停用" : "启用" }}</em></td>
          <td><button class="mini" data-action="user-details" @click="showDetails(user)">组织关系与报名历史</button><button v-if="user.type !== 'admin'" class="mini" @click="editUser(user)">编辑</button><button v-if="user.type !== 'admin'" class="mini" :data-action="`reset-user-password-${user.id}`" @click="resetTemporaryPassword(user)">重置密码</button><button v-if="user.type !== 'admin' && user.mustChangePassword" class="mini" :data-action="`view-user-password-${user.id}`" @click="viewTemporaryPassword(user)">查看临时密码</button><button v-if="user.type !== 'admin'" class="mini reject" @click="removeUser(user)">删除</button></td>
        </tr>
      </tbody></table></div>
    </section>
  </section>

  <div v-if="temporaryPasswordDialog" class="dialog-backdrop" @click.self="temporaryPasswordDialog = null">
    <section class="panel organization-dialog" data-testid="temporary-password-dialog">
      <h3>{{ temporaryPasswordDialog.userName }} 的临时密码</h3>
      <p class="hint">该密码可在用户修改前重复查看；用户下次登录必须先修改密码。</p>
      <output class="temporary-password-value">{{ temporaryPasswordDialog.password }}</output>
      <div class="form-actions"><button type="button" class="primary" data-action="copy-temporary-password" @click="copyTemporaryPassword">复制临时密码</button><button type="button" data-action="close-temporary-password" @click="temporaryPasswordDialog = null">关闭</button></div>
    </section>
  </div>

  <section v-if="selectedDetails" class="panel user-detail-panel" data-testid="user-details">
    <div class="panel-title"><h3>{{ selectedDetails.user.name }} 的组织关系与跨赛事报名历史</h3><button class="mini reject" @click="selectedDetails = null">关闭</button></div>
    <h4>组织关系</h4>
    <ul><li v-for="membership in selectedDetails.memberships || []" :key="membership.id">{{ organizations.find((item) => item.id === membership.organizationId)?.name || membership.organizationId }} · {{ membership.role }} · {{ membership.status }}</li></ul>
    <p v-if="!selectedDetails.memberships?.length" class="hint">暂无组织关系。</p>
    <h4>报名历史</h4>
    <div class="table-wrap"><table><thead><tr><th>报名编号</th><th>选手</th><th>赛事/赛项</th><th>状态</th></tr></thead><tbody><tr v-for="row in selectedDetails.registrations || []" :key="row.id"><td>{{ row.id }}</td><td>{{ row.athlete?.name }}</td><td>{{ row.eventName || row.eventId }} / {{ row.projectName }}</td><td>{{ row.status }}</td></tr></tbody></table></div>
    <p v-if="!selectedDetails.registrations?.length" class="hint">暂无报名历史。</p>
  </section>
</template>
