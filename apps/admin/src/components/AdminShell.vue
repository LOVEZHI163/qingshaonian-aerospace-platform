<script setup>
import { ref } from "vue";

import EventContextSwitcher from "./EventContextSwitcher.vue";

defineProps({
  active: { type: String, default: "overview" },
  events: { type: Array, default: () => [] },
  eventId: { type: String, default: "" }
});

const emit = defineEmits(["navigate", "update:eventId"]);

const groups = [
  { label: "工作台", items: [["overview", "概览"]] },
  { label: "赛事运营", items: [["events", "赛事设置"], ["registrations", "报名管理"], ["certificates", "证书管理"]] },
  { label: "内容与用户", items: [["siteContent", "官网内容"], ["organizations", "组织用户"], ["users", "普通用户管理"]] }
];

const mobileSidebarOpen = ref(false);

function navigate(view) {
  mobileSidebarOpen.value = false;
  emit("navigate", view);
}
</script>

<template>
  <div
    class="admin-shell"
    :class="{ 'sidebar-mobile-open': mobileSidebarOpen }"
    data-testid="admin-shell"
  >
    <button v-if="mobileSidebarOpen" type="button" class="sidebar-backdrop" aria-label="关闭导航" @click="mobileSidebarOpen = false" />
    <aside id="admin-sidebar" class="admin-sidebar">
      <div class="admin-brand-row">
        <div class="admin-brand">
          <span class="admin-brand-mark"><img :src="'/brand/mark.svg'" alt="温州市青少年航空航天创新比赛 Logo" /></span>
          <strong>赛事管理平台</strong>
        </div>
      </div>
      <nav aria-label="管理员导航">
        <section v-for="group in groups" :key="group.label" class="admin-nav-group">
          <p class="admin-nav-group-label">{{ group.label }}</p>
          <button
            v-for="item in group.items"
            :key="item[0]"
            type="button"
            :class="{ active: active === item[0] }"
            :data-nav="item[0]"
            :aria-label="item[1]"
            :title="item[1]"
            @click="navigate(item[0])"
          ><span class="admin-nav-label">{{ item[1] }}</span></button>
        </section>
      </nav>
      <div class="admin-sidebar-footer">
        <slot name="sidebar-footer" />
      </div>
    </aside>
    <div class="admin-workspace">
      <header class="admin-header">
        <button
          type="button"
          class="sidebar-mobile-trigger"
          aria-controls="admin-sidebar"
          :aria-expanded="mobileSidebarOpen"
          aria-label="打开管理导航"
          @click="mobileSidebarOpen = true"
        >☰</button>
        <slot name="header" />
        <EventContextSwitcher :events="events" :model-value="eventId" include-archived @update:model-value="$emit('update:eventId', $event)" />
      </header>
      <main class="admin-main"><slot /></main>
    </div>
  </div>
</template>
