<script setup>
import { onMounted, ref } from "vue";

import { api } from "../lib/api.js";

const props = defineProps({ accountType: { type: String, default: "ordinary" } });
const emit = defineEmits(["open-event"]);
const rows = ref([]);
const loading = ref(true);
const error = ref("");
const joiningEventId = ref("");

const registrationStateText = { not_started: "未开始", open: "报名中", closed: "已截止" };
const participationStateText = { available: "可加入", joined: "已加入", blocked: "资质不可用" };

function openRegistration(eventId) {
  emit("open-event", { eventId, mode: "registration" });
}

function openOrganizationWorkspace(eventId) {
  emit("open-event", { eventId, mode: "organizationWorkspace" });
}

async function joinEvent(row) {
  if (joiningEventId.value) return;
  joiningEventId.value = row.event.id;
  error.value = "";
  try {
    await api(`/api/organization/events/${encodeURIComponent(row.event.id)}/join`, { method: "POST" });
    row.participationState = "joined";
    openOrganizationWorkspace(row.event.id);
  } catch (requestError) {
    error.value = requestError.message || "加入赛事失败，请稍后重试";
  } finally {
    joiningEventId.value = "";
  }
}

function canActivate(row) {
  return props.accountType === "ordinary" || ["available", "joined"].includes(row.participationState);
}

function activateEvent(row) {
  if (!canActivate(row) || joiningEventId.value) return;
  if (props.accountType === "ordinary") openRegistration(row.event.id);
  else if (row.participationState === "available") void joinEvent(row);
  else openOrganizationWorkspace(row.event.id);
}

async function loadEvents() {
  loading.value = true;
  error.value = "";
  try {
    const payload = await api("/api/me/events");
    rows.value = Array.isArray(payload?.rows) ? payload.rows.filter((row) => row?.event?.id) : [];
  } catch (requestError) {
    error.value = requestError.message || "赛事中心加载失败，请稍后重试";
  } finally {
    loading.value = false;
  }
}

onMounted(loadEvents);
</script>

<template>
  <section class="event-center-page" data-testid="event-center-page">
    <div class="event-center-heading">
      <div><h2>{{ accountType === 'organization' ? '赛事工作台' : '赛事中心' }}</h2><p>{{ accountType === 'organization' ? '选择赛事；尚未加入时，点击即可加入并开始组织报名。' : '请选择要查看和操作的赛事。' }}</p></div>
    </div>
    <p v-if="loading" class="hint">正在加载可访问赛事…</p>
    <div v-else-if="error" class="event-center-error"><p class="message">{{ error }}</p><button type="button" class="ghost" data-action="retry-event-center" @click="loadEvents">重新加载</button></div>
    <p v-else-if="rows.length === 0" class="hint empty-state">暂无可访问赛事</p>
    <div v-else class="event-center-grid">
      <article v-for="row in rows" :key="row.event.id" class="panel event-center-card" :class="{ 'event-center-card-actionable': canActivate(row), 'event-center-card-busy': joiningEventId === row.event.id }" :data-event-card="row.event.id" :role="canActivate(row) ? 'button' : undefined" :tabindex="canActivate(row) ? 0 : undefined" :aria-disabled="joiningEventId === row.event.id || !canActivate(row)" @click="activateEvent(row)" @keydown.enter.prevent="activateEvent(row)" @keydown.space.prevent="activateEvent(row)">
        <div class="panel-title"><h3>{{ row.event.name }}</h3><em :class="`event-state-${row.registrationState}`">{{ registrationStateText[row.registrationState] || "报名状态待定" }}</em></div>
        <p class="hint" v-if="row.event.date || row.event.dateLabel">{{ row.event.date || row.event.dateLabel }}<span v-if="row.event.venue"> · {{ row.event.venue }}</span></p>
        <template v-if="accountType === 'organization'">
          <p class="hint">{{ participationStateText[row.participationState] || "资质不可用" }}</p>
          <p v-if="row.summary" class="hint">报名 {{ row.summary.registrationCount || 0 }} 人 · 待审核 {{ row.summary.pendingRegistrationCount || 0 }} 人 · 证书 {{ row.summary.certificateCount || 0 }} 份</p>
          <span v-if="row.participationState === 'available'" class="primary event-center-card-cta" data-action="join-event">{{ joiningEventId === row.event.id ? "正在加入…" : "加入赛事并开始报名" }}</span>
          <span v-else-if="row.participationState === 'joined'" class="primary event-center-card-cta" data-action="open-workspace">进入赛事工作台</span>
        </template>
        <span v-if="accountType === 'ordinary'" class="primary event-center-card-cta" data-action="open">进入报名</span>
      </article>
    </div>
  </section>
</template>
