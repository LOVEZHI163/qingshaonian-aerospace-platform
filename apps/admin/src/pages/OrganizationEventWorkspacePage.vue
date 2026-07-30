<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import OrganizationAthleteRegistrationForm from "../components/OrganizationAthleteRegistrationForm.vue";
import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

const props = defineProps({ eventId: { type: String, default: "" } });
const emit = defineEmits(["error"]);
const workspace = ref(null);
const registrations = ref([]);
const certificates = ref([]);
const activeTab = ref("registration");
const loading = ref(true);
const loadingCertificates = ref(false);
const downloads = createBlobDownloadManager();
const event = computed(() => workspace.value?.event || {});
const summary = computed(() => workspace.value?.summary || {});
const archived = computed(() => Boolean(event.value.archivedAt || event.value.archived_at || event.value.status === "archived"));

async function loadWorkspace() {
  if (!props.eventId) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const payload = await api(`/api/organization/events/${encodeURIComponent(props.eventId)}/workspace`);
    workspace.value = payload || {};
    registrations.value = Array.isArray(payload?.registrations) ? payload.registrations : [];
    await loadRegistrations();
  } catch (error) {
    emit("error", error.message || "赛事工作台加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadRegistrations() {
  if (!props.eventId) return;
  try {
    const payload = await api(`/api/organization/events/${encodeURIComponent(props.eventId)}/registrations`);
    registrations.value = Array.isArray(payload?.rows) ? payload.rows : [];
  } catch (error) {
    emit("error", error.message || "组织报名记录加载失败");
  }
}

async function loadCertificates() {
  if (!props.eventId || loadingCertificates.value) return;
  loadingCertificates.value = true;
  try {
    const payload = await api(`/api/organization/events/${encodeURIComponent(props.eventId)}/certificates`);
    certificates.value = Array.isArray(payload?.rows) ? payload.rows : [];
  } catch (error) {
    emit("error", error.message || "组织证书加载失败");
  } finally {
    loadingCertificates.value = false;
  }
}

async function selectTab(tab) {
  activeTab.value = tab;
  if (tab === "certificates" && certificates.value.length === 0) await loadCertificates();
}

async function exportRegistrations() {
  try {
    const blob = await apiBlob(`/api/organization/events/${encodeURIComponent(props.eventId)}/export`);
    downloads.save(blob, `${event.value.name || "组织"}_报名名单.xlsx`);
  } catch (error) {
    emit("error", error.message || "导出组织报名名单失败");
  }
}

function registered() {
  void loadRegistrations();
}

onMounted(loadWorkspace);
onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="organization-event-workspace" data-testid="organization-event-workspace">
    <p v-if="loading" class="hint">正在加载赛事工作台…</p>
    <div v-else-if="!workspace" class="panel event-context-empty"><h3>未找到赛事工作台</h3><p class="hint">请从赛事中心选择已加入的赛事。</p></div>
    <template v-else>
      <header class="panel organization-workspace-header"><div><h2>{{ event.name || "组织赛事工作台" }}</h2><p class="hint">{{ archived ? "该赛事已归档，报名记录仅可查看，证书仍可下载。" : "当前组织仅管理本赛事内的报名、成绩和证书。" }}</p></div><div class="workspace-summary"><span>报名 {{ summary.registrationCount || registrations.length }}</span><span>待审核 {{ summary.pendingRegistrationCount || 0 }}</span><span>证书 {{ summary.certificateCount || 0 }}</span></div></header>
      <nav class="workspace-tabs" aria-label="赛事工作台">
        <button v-for="tab in [['registration', '组织报名'], ['records', '报名记录'], ['results', '成绩'], ['certificates', '证书']]" :key="tab[0]" type="button" :class="{ active: activeTab === tab[0] }" :data-workspace-tab="tab[0]" @click="selectTab(tab[0])">{{ tab[1] }}</button>
      </nav>
      <OrganizationAthleteRegistrationForm v-if="activeTab === 'registration' && !archived" :event-id="props.eventId" :projects="workspace.projects || []" @registered="registered" @error="emit('error', $event)" />
      <div v-else-if="activeTab === 'registration'" class="panel event-context-empty"><h3>归档赛事不可新增报名</h3><p class="hint">仍可在报名记录、成绩和证书页签查看历史数据。</p></div>
      <section v-else-if="activeTab === 'records'" class="panel workspace-table"><div class="panel-title"><h3>报名记录</h3><button type="button" class="mini" data-action="export-organization-registrations" @click="exportRegistrations">导出名单</button></div><div class="table-wrap"><table><thead><tr><th>姓名</th><th>学校/年级</th><th>赛项</th><th>审核状态</th></tr></thead><tbody><tr v-for="row in registrations" :key="row.id"><td>{{ row.athlete?.name }}</td><td>{{ row.athlete?.school }}<br /><span>{{ row.athlete?.grade }}</span></td><td>{{ row.projectName }}</td><td>{{ row.status }}</td></tr></tbody></table><p v-if="!registrations.length" class="hint empty-state">暂无报名记录。</p></div></section>
      <section v-else-if="activeTab === 'results'" class="panel workspace-table"><div class="panel-title"><h3>成绩与奖项</h3></div><div class="table-wrap"><table><thead><tr><th>姓名</th><th>赛项</th><th>奖项</th><th>名次</th><th>成绩</th></tr></thead><tbody><tr v-for="row in registrations" :key="row.id"><td>{{ row.athlete?.name }}</td><td>{{ row.projectName }}</td><td>{{ row.awardName || "-" }}</td><td>{{ row.rank || "-" }}</td><td>{{ row.score || "-" }}</td></tr></tbody></table><p v-if="!registrations.length" class="hint empty-state">暂无成绩记录。</p></div></section>
      <section v-else class="panel workspace-table"><div class="panel-title"><h3>组织证书</h3><span>{{ certificates.length }} 张</span></div><p v-if="loadingCertificates" class="hint">正在加载证书…</p><div v-else class="table-wrap"><table><thead><tr><th>姓名</th><th>赛项</th><th>证书名称</th><th>操作</th></tr></thead><tbody><tr v-for="certificate in certificates" :key="certificate.id"><td>{{ certificate.athlete?.name || certificate.registration?.athlete?.name }}</td><td>{{ certificate.projectName }}</td><td>{{ certificate.title || certificate.awardName }}</td><td><button v-if="certificate.downloadUrl" type="button" class="mini" @click="apiBlob(certificate.downloadUrl).then((blob) => downloads.save(blob, certificate.fileName || certificate.title)).catch((error) => emit('error', error.message))">下载</button><span v-else>-</span></td></tr></tbody></table><p v-if="!certificates.length" class="hint empty-state">暂无可下载证书。</p></div></section>
    </template>
  </section>
</template>
