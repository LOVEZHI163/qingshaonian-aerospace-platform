<script setup>
import { computed, onMounted, ref } from "vue";

import OrganizationAthleteRegistrationForm from "../components/OrganizationAthleteRegistrationForm.vue";
import { api } from "../lib/api.js";

const props = defineProps({ eventId: { type: String, default: "" } });
const emit = defineEmits(["error", "context", "access-denied", "back-to-events"]);
const workspace = ref(null);
const loading = ref(true);
const event = computed(() => workspace.value?.event || {});
const summary = computed(() => workspace.value?.summary || {});
const archived = computed(() => Boolean(event.value.archivedAt || event.value.archived_at || event.value.status === "archived"));
const eventDate = computed(() => event.value.dateLabel || event.value.date || "未设置");
const registrationDeadline = computed(() => event.value.registrationDeadline || event.value.registrationEndAt || "未设置");
const eventState = computed(() => archived.value ? "已归档" : event.value.status || "未设置");

async function loadWorkspace() {
  if (!props.eventId) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const payload = await api(`/api/organization/events/${encodeURIComponent(props.eventId)}/workspace`);
    workspace.value = payload || {};
    emit("context", payload?.event || null);
  } catch (error) {
    if ([403, 404].includes(error.status)) emit("access-denied", error);
    else emit("error", error.message || "赛事工作台加载失败");
  } finally {
    loading.value = false;
  }
}

function registered() {
  void loadWorkspace();
}

onMounted(loadWorkspace);
</script>

<template>
  <section class="organization-event-workspace" data-testid="organization-event-workspace">
    <p v-if="loading" class="hint">正在加载赛事工作台…</p>
    <div v-else-if="!workspace" class="panel event-context-empty"><h3>未找到赛事工作台</h3><p class="hint">请从赛事工作台选择已加入的赛事。</p></div>
    <div v-else class="organization-event-workspace-layout">
      <section class="panel organization-event-summary-card">
        <div class="panel-title organization-event-summary-title">
          <div><h2>{{ event.name || "组织赛事工作台" }}</h2><p class="hint">本页用于查看赛事信息并提交组织报名。</p></div>
          <button type="button" class="mini" data-action="back-to-events" @click="emit('back-to-events')">返回赛事工作台</button>
        </div>
        <dl class="organization-event-summary-facts">
          <div><dt>比赛日期</dt><dd>{{ eventDate }}</dd></div>
          <div><dt>比赛地点</dt><dd>{{ event.venue || "未设置" }}</dd></div>
          <div><dt>报名截止</dt><dd>{{ registrationDeadline }}</dd></div>
          <div><dt>赛事状态</dt><dd>{{ eventState }}</dd></div>
        </dl>
        <div class="organization-event-summary-counts"><span>报名 {{ summary.registrationCount || 0 }}</span><span>待审核 {{ summary.pendingRegistrationCount || 0 }}</span><span>证书 {{ summary.certificateCount || 0 }}</span></div>
      </section>

      <section class="panel organization-registration-guide">
        <h3>报名说明</h3>
        <p>报名将固定归属当前组织，不能切换为个人或其他组织。</p>
        <p>学校信息可按参赛学生实际学校填写或修改。</p>
        <p class="hint">报名记录、成绩、证书及作品材料请在相应的跨赛事页面管理。</p>
      </section>

      <section class="organization-registration-card">
        <OrganizationAthleteRegistrationForm v-if="!archived" :event-id="props.eventId" :projects="workspace.projects || []" :grades="workspace.grades || []" :members="workspace.members || []" :default-school="workspace.organization?.name || ''" @registered="registered" @error="emit('error', $event)" />
        <div v-else class="panel event-context-empty"><h3>归档赛事不可新增报名</h3><p class="hint">请在报名记录、成绩和证书页面查看历史信息。</p></div>
      </section>
    </div>
  </section>
</template>
