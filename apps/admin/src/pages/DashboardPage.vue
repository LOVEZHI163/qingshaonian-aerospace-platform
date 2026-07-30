<script setup>
import { computed, ref, watch } from "vue";

import { api } from "../lib/api.js";

defineEmits(["navigate"]);
const props = defineProps({ eventId: { type: String, default: "" } });

const data = ref({
  event: {},
  events: [],
  registrationWindow: { open: false, reason: "正在读取" },
  counts: { registrations: 0, pendingRegistrations: 0, pendingOrganizations: 0, draftCertificates: 0 },
  recentImports: [],
  recentAuditLogs: []
});
const loading = ref(false);
const error = ref("");

const eventStatus = computed(() => ({
  draft: "草稿",
  published: "已发布",
  archived: "已归档"
}[data.value.event?.status] || "未配置"));

const actionText = {
  "organization.review": "组织审核",
  "organization.status": "组织状态",
  "registration.review": "报名审核",
  "event.registration-mode": "报名控制",
  "event.publish": "发布赛事",
  "event.archive": "归档赛事",
  "certificate-import.commit": "导入证书",
  "certificate.publish": "发布证书",
  "certificate.withdraw": "撤回证书",
  "certificate.delete": "删除证书"
};

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

async function load(eventId = props.eventId) {
  if (!eventId) return;
  loading.value = true;
  error.value = "";
  try {
    const suffix = eventId ? `?eventId=${encodeURIComponent(eventId)}` : "";
    const payload = await api(`/api/admin/dashboard${suffix}`);
    data.value = {
      ...data.value,
      ...payload,
      counts: { ...data.value.counts, ...(payload.counts || {}) },
      registrationWindow: { ...data.value.registrationWindow, ...(payload.registrationWindow || {}) },
      events: payload.events || [],
      recentImports: payload.recentImports || [],
      recentAuditLogs: payload.recentAuditLogs || []
    };
  } catch (loadError) {
    error.value = loadError.message || "概览加载失败";
  } finally {
    loading.value = false;
  }
}

watch(() => props.eventId, (eventId) => { void load(eventId); }, { immediate: true });
</script>

<template>
  <section class="panel admin-overview dashboard-page">
    <div class="dashboard-heading">
      <div>
        <span class="eyebrow">后台概览</span>
        <h3>管理概览</h3>
        <p>{{ data.event.name || "请选择赛事" }}</p>
      </div>
      <label v-if="data.events.length" class="event-selector">查看赛事
        <select v-model="selectedEventId" data-filter="dashboard-event" @change="load(selectedEventId)">
          <option v-for="event in data.events" :key="event.id" :value="event.id">
            {{ event.name }}{{ event.isCurrent ? "（当前）" : "" }}
          </option>
        </select>
      </label>
    </div>

    <p v-if="error" class="message danger">{{ error }}</p>
    <p v-else-if="loading" class="hint">正在更新概览…</p>

    <div class="status-strip">
      <span><strong>赛事状态</strong>{{ eventStatus }}</span>
      <span :class="data.registrationWindow.open ? 'open' : 'closed'">
        <strong>报名窗口</strong>{{ data.registrationWindow.reason }}
      </span>
    </div>

    <div class="dashboard-counts">
      <article data-count="registrations"><span>报名总数</span><strong>{{ data.counts.registrations }}</strong></article>
      <article data-count="pending-registrations"><span>待审核报名</span><strong>{{ data.counts.pendingRegistrations }}</strong><button type="button" data-dashboard-target="registrations" @click="$emit('navigate', 'registrations')">去审核</button></article>
      <article data-count="pending-organizations"><span>待审核组织</span><strong>{{ data.counts.pendingOrganizations }}</strong><button type="button" data-dashboard-target="organizations" @click="$emit('navigate', 'organizations')">去审核</button></article>
      <article data-count="draft-certificates"><span>未发布证书</span><strong>{{ data.counts.draftCertificates }}</strong><button type="button" data-dashboard-target="certificates" @click="$emit('navigate', 'certificates')">去检查</button></article>
    </div>

    <div class="dashboard-detail-grid">
      <section>
        <div class="section-title"><h4>最近证书导入</h4><span>最多 5 条</span></div>
        <div v-if="data.recentImports.length" class="compact-list">
          <article v-for="batch in data.recentImports" :key="batch.id">
            <div><strong>{{ batch.originalName }}</strong><span>{{ formatTime(batch.createdAt) }}</span></div>
            <p>{{ batch.status === 'committed' ? '已提交' : batch.status === 'preview' ? '待确认' : batch.status }} · 有效 {{ batch.validCount }} · 错误 {{ batch.errorCount }}</p>
          </article>
        </div>
        <p v-else class="hint">暂无证书导入记录。</p>
      </section>

      <section>
        <div class="section-title"><h4>最近操作</h4><span>最多 10 条</span></div>
        <div v-if="data.recentAuditLogs.length" class="compact-list audit-list">
          <article v-for="row in data.recentAuditLogs" :key="row.id">
            <div><strong>{{ actionText[row.action] || row.action }}</strong><span>{{ formatTime(row.createdAt) }}</span></div>
            <p>{{ row.actorName }} · {{ row.summary }}</p>
          </article>
        </div>
        <p v-else class="hint">暂无操作记录。</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.dashboard-page { display: grid; gap: 20px; }
.dashboard-heading, .section-title, .compact-list article > div { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dashboard-heading h3 { margin: 3px 0; font-size: 24px; }
.dashboard-heading p, .section-title h4 { margin: 0; }
.eyebrow { color: #1476d4; font-size: 12px; font-weight: 800; letter-spacing: .12em; }
.event-selector { min-width: 280px; }
.event-selector select { width: 100%; }
.status-strip { display: flex; flex-wrap: wrap; gap: 12px; }
.status-strip span { display: flex; gap: 9px; padding: 10px 14px; border-radius: 10px; background: #eef4fb; color: #38506c; }
.status-strip .open { background: #e6f7ef; color: #087552; }
.status-strip .closed { background: #fff1ed; color: #a43b25; }
.dashboard-counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.dashboard-counts article { display: grid; gap: 8px; min-height: 122px; padding: 18px; border: 1px solid #dbe4ef; border-radius: 14px; background: linear-gradient(145deg, #fff, #f6f9fc); }
.dashboard-counts strong { color: #10243e; font-size: 30px; }
.dashboard-counts button { justify-self: start; border: 0; padding: 0; background: transparent; color: #1476d4; font-weight: 700; cursor: pointer; }
.dashboard-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.dashboard-detail-grid > section { padding: 18px; border: 1px solid #dbe4ef; border-radius: 14px; }
.section-title span, .compact-list span { color: #718096; font-size: 12px; }
.compact-list { display: grid; margin-top: 10px; }
.compact-list article { padding: 12px 0; border-top: 1px solid #edf1f5; }
.compact-list p { margin: 6px 0 0; color: #536579; font-size: 13px; }
@media (max-width: 980px) {
  .dashboard-counts, .dashboard-detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .dashboard-heading { align-items: stretch; flex-direction: column; }
  .event-selector { min-width: 0; }
  .dashboard-counts, .dashboard-detail-grid { grid-template-columns: 1fr; }
}
</style>
