<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import OrganizationAthleteRegistrationForm from "../components/OrganizationAthleteRegistrationForm.vue";
import SubmissionAssetUploader from "../components/SubmissionAssetUploader.vue";
import { api, apiBlob, apiUrl } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

const props = defineProps({ eventId: { type: String, default: "" } });
const emit = defineEmits(["error", "context", "access-denied"]);
const workspace = ref(null);
const registrations = ref([]);
const certificates = ref([]);
const activeTab = ref("registration");
const loading = ref(true);
const loadingCertificates = ref(false);
const editingRegistration = ref(null);
const replacingRegistration = ref(null);
const replacementSession = ref(null);
const replacementLoading = ref(false);
const replacementComplete = ref(false);
const replacementCompletedKinds = ref(new Set());
const replacementError = ref("");
const replacementResult = ref("");
let replacementRequest = 0;
const downloads = createBlobDownloadManager();
const event = computed(() => workspace.value?.event || {});
const summary = computed(() => workspace.value?.summary || {});
const archived = computed(() => Boolean(event.value.archivedAt || event.value.archived_at || event.value.status === "archived"));
const replacementKinds = ["artwork_image", "creation_video"];
const replacementKindLabels = { artwork_image: "作品图片", creation_video: "作画视频" };
const remainingReplacementKinds = computed(() => replacementKinds.filter((kind) => !replacementCompletedKinds.value.has(kind)));
const partialReplacementMessage = computed(() => {
  const completed = replacementKinds.filter((kind) => replacementCompletedKinds.value.has(kind)).map((kind) => replacementKindLabels[kind]);
  const remaining = remainingReplacementKinds.value.map((kind) => replacementKindLabels[kind]);
  return completed.length && remaining.length ? `${completed.join("、")}已替换，${remaining.join("、")}仍待替换` : "";
});

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
    registrations.value = Array.isArray(payload?.registrations) ? payload.registrations : [];
    await loadRegistrations();
  } catch (error) {
    if ([403, 404].includes(error.status)) emit("access-denied", error);
    else emit("error", error.message || "赛事工作台加载失败");
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
  if (tab !== "records") cancelReplacement();
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

function savedRegistration(payload) {
  const row = payload?.row;
  if (row) registrations.value = registrations.value.map((item) => item.id === row.id ? row : item);
  editingRegistration.value = null;
}

function submissionAssetPath(row, kind) {
  return `/api/organization/events/${encodeURIComponent(props.eventId)}/registrations/${encodeURIComponent(row.id)}/assets/${kind}`;
}

function assetAvailable(asset) {
  return Boolean(asset && !asset.cleanedAt);
}

function materialLabel(asset, label) {
  if (!asset) return `${label}未上传`;
  return asset.cleanedAt ? `${label}已清理` : `${label}可用`;
}

function downloadSubmissionAsset(row, kind, asset) {
  apiBlob(submissionAssetPath(row, kind))
    .then((blob) => downloads.save(blob, blob.fileName || asset.originalName))
    .catch(() => emit("error", "作品材料下载失败，请重试"));
}

function cancelReplacement({ keepResult = false } = {}) {
  replacementRequest += 1;
  replacingRegistration.value = null;
  replacementSession.value = null;
  replacementLoading.value = false;
  replacementComplete.value = false;
  replacementCompletedKinds.value = new Set();
  replacementError.value = "";
  if (!keepResult) replacementResult.value = "";
}

async function createReplacementSession(row) {
  const request = replacementRequest + 1;
  replacementRequest = request;
  replacingRegistration.value = row;
  replacementSession.value = null;
  replacementComplete.value = false;
  replacementCompletedKinds.value = new Set();
  replacementError.value = "";
  replacementResult.value = "";
  replacementLoading.value = true;
  try {
    const payload = await api(`/api/organization/events/${encodeURIComponent(props.eventId)}/projects/${encodeURIComponent(row.projectId)}/upload-sessions`, { method: "POST" });
    if (request !== replacementRequest || replacingRegistration.value?.id !== row.id) return;
    const session = payload?.row || payload;
    if (!session?.id) throw new Error("invalid upload session");
    replacementSession.value = session;
  } catch {
    if (request !== replacementRequest || replacingRegistration.value?.id !== row.id) return;
    replacementError.value = "无法创建作品上传会话，请重试";
  } finally {
    if (request === replacementRequest) replacementLoading.value = false;
  }
}

function retryReplacementSession() {
  if (replacementSession.value?.id) void confirmReplacement();
  else if (replacingRegistration.value) void createReplacementSession(replacingRegistration.value);
}

async function confirmReplacement() {
  const row = replacingRegistration.value;
  const sessionId = replacementSession.value?.id;
  if (!row || !sessionId || !replacementComplete.value || replacementLoading.value) return;
  replacementLoading.value = true;
  replacementError.value = "";
  try {
    let updated = null;
    for (const kind of remainingReplacementKinds.value) {
      const payload = await api(`${submissionAssetPath(row, kind)}`, { method: "PUT", body: JSON.stringify({ uploadSessionId: sessionId }) });
      updated = payload?.registration || updated;
      replacementCompletedKinds.value = new Set([...replacementCompletedKinds.value, kind]);
      if (updated?.id) registrations.value = registrations.value.map((item) => item.id === updated.id ? updated : item);
      await loadRegistrations();
    }
    replacementResult.value = "作品材料已替换，已恢复待审核";
    cancelReplacement({ keepResult: true });
  } catch {
    replacementError.value = "作品材料替换失败，请重试";
  } finally {
    replacementLoading.value = false;
  }
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
      <section v-else-if="activeTab === 'records'" class="panel workspace-table"><div class="panel-title"><h3>报名记录</h3><button type="button" class="mini" data-action="export-organization-registrations" @click="exportRegistrations">导出名单</button></div><OrganizationAthleteRegistrationForm v-if="editingRegistration && !archived" :event-id="props.eventId" :projects="workspace.projects || []" :registration="editingRegistration" @registered="savedRegistration" @error="emit('error', $event)" />
        <section v-if="replacingRegistration" class="registration-submission organization-material-replacement" aria-label="替换作品材料">
          <h4>替换 {{ replacingRegistration.athlete?.name }} 的作品材料</h4>
          <p v-if="replacementLoading && !replacementSession" class="hint">正在创建作品上传会话…</p>
          <template v-else-if="replacementSession?.id">
            <SubmissionAssetUploader :key="replacementSession.id" :session-id="replacementSession.id" mode="image_video" :assets="replacementSession.assets || {}" @complete="replacementComplete = $event" @error="replacementError = '作品材料上传失败，请重试'" />
            <p v-if="partialReplacementMessage" class="message" role="status">{{ partialReplacementMessage }}</p>
            <p v-if="replacementError" class="message" role="alert">{{ replacementError }} <button type="button" class="mini" :data-action="`retry-organization-material-replacement-${replacingRegistration.id}`" :disabled="replacementLoading" @click="retryReplacementSession">重试</button></p>
            <button type="button" class="primary" :data-action="`confirm-organization-material-replacement-${replacingRegistration.id}`" :disabled="replacementLoading || !replacementComplete || !remainingReplacementKinds.length" @click="confirmReplacement">{{ replacementLoading ? "正在替换…" : partialReplacementMessage ? "继续替换剩余素材" : "确认替换作品材料" }}</button>
            <button type="button" class="mini" @click="cancelReplacement">取消替换</button>
          </template>
          <p v-else class="message" role="alert">{{ replacementError || "作品上传会话不可用" }} <button type="button" class="mini" @click="retryReplacementSession">重试</button></p>
        </section>
        <p v-if="replacementResult" class="message" role="status">{{ replacementResult }}</p>
        <div class="table-wrap"><table><thead><tr><th>姓名</th><th>学校/年级</th><th>赛项</th><th>作品材料</th><th>审核状态</th><th v-if="!archived">操作</th></tr></thead><tbody><tr v-for="row in registrations" :key="row.id"><td>{{ row.athlete?.name }}</td><td>{{ row.athlete?.school }}<br /><span>{{ row.athlete?.grade }}</span></td><td>{{ row.projectName }}</td><td><template v-if="row.submission?.required"><p v-for="kind in ['artwork_image', 'creation_video']" :key="kind"><span>{{ materialLabel(row.submission.assets?.[kind], kind === 'artwork_image' ? '作品图片' : '作画视频') }}</span><template v-if="assetAvailable(row.submission.assets?.[kind])"> <img v-if="kind === 'artwork_image'" class="submission-artwork-preview" :src="apiUrl(submissionAssetPath(row, kind))" :alt="`${row.submission.assets[kind].originalName} 预览`" /><video v-else class="submission-video-preview" :src="apiUrl(submissionAssetPath(row, kind))" controls preload="metadata"></video> <button type="button" class="mini" @click="downloadSubmissionAsset(row, kind, row.submission.assets[kind])">下载</button></template></p></template><span v-else>无需作品材料</span></td><td>{{ row.status }}</td><td v-if="!archived"><button type="button" class="mini" :data-action="`edit-organization-registration-${row.id}`" @click="editingRegistration = row">编辑</button><button v-if="row.submission?.required" type="button" class="mini" :data-action="`replace-organization-materials-${row.id}`" @click="createReplacementSession(row)">替换作品材料</button></td></tr></tbody></table><p v-if="!registrations.length" class="hint empty-state">暂无报名记录。</p></div></section>
      <section v-else-if="activeTab === 'results'" class="panel workspace-table"><div class="panel-title"><h3>成绩与奖项</h3></div><div class="table-wrap"><table><thead><tr><th>姓名</th><th>赛项</th><th>奖项</th><th>名次</th><th>成绩</th></tr></thead><tbody><tr v-for="row in registrations" :key="row.id"><td>{{ row.athlete?.name }}</td><td>{{ row.projectName }}</td><td>{{ row.awardName || "-" }}</td><td>{{ row.rank || "-" }}</td><td>{{ row.score || "-" }}</td></tr></tbody></table><p v-if="!registrations.length" class="hint empty-state">暂无成绩记录。</p></div></section>
      <section v-else class="panel workspace-table"><div class="panel-title"><h3>组织证书</h3><span>{{ certificates.length }} 张</span></div><p v-if="loadingCertificates" class="hint">正在加载证书…</p><div v-else class="table-wrap"><table><thead><tr><th>姓名</th><th>赛项</th><th>证书名称</th><th>操作</th></tr></thead><tbody><tr v-for="certificate in certificates" :key="certificate.id"><td>{{ certificate.athlete?.name || certificate.registration?.athlete?.name }}</td><td>{{ certificate.projectName }}</td><td>{{ certificate.title || certificate.awardName }}</td><td><button v-if="certificate.downloadUrl" type="button" class="mini" @click="apiBlob(certificate.downloadUrl).then((blob) => downloads.save(blob, certificate.fileName || certificate.title)).catch((error) => emit('error', error.message))">下载</button><span v-else>-</span></td></tr></tbody></table><p v-if="!certificates.length" class="hint empty-state">暂无可下载证书。</p></div></section>
    </template>
  </section>
</template>
