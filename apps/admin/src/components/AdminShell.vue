<script setup>
import EventContextSwitcher from "./EventContextSwitcher.vue";

defineProps({
  active: { type: String, default: "overview" },
  events: { type: Array, default: () => [] },
  eventId: { type: String, default: "" }
});

defineEmits(["navigate", "update:eventId"]);

const items = [
  ["overview", "概览"],
  ["events", "赛事设置"],
  ["siteContent", "官网内容"],
  ["organizations", "组织用户"],
  ["registrations", "报名管理"],
  ["certificates", "证书管理"],
  ["users", "普通用户管理"]
];
</script>

<template>
  <div class="admin-shell" data-testid="admin-shell">
    <aside class="admin-sidebar">
      <div class="admin-brand"><span>航</span><strong>赛事管理平台</strong></div>
      <nav aria-label="管理员导航">
        <button
          v-for="item in items"
          :key="item[0]"
          type="button"
          :class="{ active: active === item[0] }"
          :data-nav="item[0]"
          @click="$emit('navigate', item[0])"
        >{{ item[1] }}</button>
      </nav>
    </aside>
    <div class="admin-workspace">
      <header class="admin-header"><slot name="header" /><EventContextSwitcher :events="events" :model-value="eventId" include-archived @update:model-value="$emit('update:eventId', $event)" /></header>
      <main class="admin-main"><slot /></main>
    </div>
  </div>
</template>
