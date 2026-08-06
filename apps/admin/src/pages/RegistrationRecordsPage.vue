<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import SubmissionAssetUploader from "../components/SubmissionAssetUploader.vue";
import { api, apiBlob, apiUrl } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import { useSession } from "../state/session.js";

const props = defineProps({ eventId: { type: String, default: "" } });
const emit = defineEmits(["error"]);
const session = useSession();
const allRows = ref([]);
const eventFilter = ref(props.eventId || "all");
const eventOptions = computed(() => [...new Map(allRows.value.map((row) => [row.eventId, row.eventName || row.eventId])).entries()]
  .filter(([eventId]) => eventId)
  .map(([id, name]) => ({ id, name })));
const rows = computed(() => eventFilter.value === "all"
  ? allRows.value
  : allRows.value.filter((row) => row.eventId === eventFilter.value));
const loading = ref(true);
const replacingRegistration = ref(null);
const replacementSession = ref(null);
const replacementLoading = ref(false);
const replacementComplete = ref(false);
const replacementCompletedKinds = ref(new Set());
const replacementError = ref("");
const replacementResult = ref("");
const downloads = createBlobDownloadManager();
let replacementRequest = 0;
const statusText = { pending: "待审核", approved: "已通过", rejected: "已驳回", cancelled: "已取消" };
const replacementKinds = ["artwork_image", "creation_video"];
const replacementKindLabels = { artwork_image: "作品图片", creation_video: "作画视频" };
const remainingReplacementKinds = computed(() => replacementKinds.filter((kind) => !replacementCompletedKinds.value.has(kind)));
const partialReplacementMessage = computed(() => {
  const completed = replacementKinds.filter((kind) => replacementCompletedKinds.value.has(kind)).map((kind) => replacementKindLabels[kind]);
  const remaining = remainingReplacementKinds.value.map((kind) => replacementKindLabels[kind]);
  return completed.length && remaining.length ? `${completed.join("、")}已替换，${remaining.join("、")}仍待替换` : "";
});

function submissionAssetPath(row, kind) {
  return `/api/me/events/${encodeURIComponent(row.eventId || props.eventId)}/registrations/${encodeURIComponent(row.id)}/assets/${kind}`;
}

function assetAvailable(asset) {
  return Boolean(asset && !asset.cleanedAt);
}

function materialLabel(asset, label) {
  if (!asset) return `${label}未上传`;
  return asset.cleanedAt ? `${label}已清理` : `${label}可用`;
}

function canReplaceMaterials(row) {
  return row.submission?.required && ["pending", "rejected"].includes(row.status);
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

async function loadRegistrations({ isCurrent = () => true } = {}) {
  const path = props.eventId
    ? `/api/me/events/${encodeURIComponent(props.eventId)}/registrations`
    : "/api/me/registrations";
  const payload = await api(path);
  if (!isCurrent()) return false;
  allRows.value = (payload.rows || []).map((row) => ({
    ...row,
    eventId: row.eventId || props.eventId,
    eventName: row.eventName || row.event?.name || props.eventId
  }));
  return true;
}

async function createReplacementSession(row) {
  if (!canReplaceMaterials(row)) return;
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
    const payload = await api(`/api/me/events/${encodeURIComponent(row.eventId || props.eventId)}/projects/${encodeURIComponent(row.projectId)}/upload-sessions`, { method: "POST" });
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
  const registrationId = row?.id;
  const generation = replacementRequest;
  const currentReplacement = () => (
    replacementRequest === generation
    && replacementSession.value?.id === sessionId
    && replacingRegistration.value?.id === registrationId
  );
  if (!row || !sessionId || !registrationId || !replacementComplete.value || replacementLoading.value || !currentReplacement()) return;
  replacementLoading.value = true;
  replacementError.value = "";
  try {
    let updated = null;
    for (const kind of remainingReplacementKinds.value) {
      if (!currentReplacement()) return;
      const payload = await api(submissionAssetPath(row, kind), { method: "PUT", body: JSON.stringify({ uploadSessionId: sessionId }) });
      if (!currentReplacement()) return;
      updated = payload?.registration || updated;
      replacementCompletedKinds.value = new Set([...replacementCompletedKinds.value, kind]);
      if (updated?.id) allRows.value = allRows.value.map((item) => item.id === updated.id ? { ...updated, eventId: item.eventId, eventName: item.eventName } : item);
      await loadRegistrations({ isCurrent: currentReplacement });
      if (!currentReplacement()) return;
    }
    if (!currentReplacement()) return;
    replacementResult.value = "作品材料已替换";
    cancelReplacement({ keepResult: true });
  } catch {
    if (currentReplacement()) replacementError.value = "作品材料替换失败，请重试";
  } finally {
    if (currentReplacement()) replacementLoading.value = false;
  }
}

onMounted(async () => {
  try {
    if (session.user.value?.type === "organization") {
      emit("error", "请在赛事工作台中查看组织报名记录。");
    } else {
      await loadRegistrations();
    }
  } catch (error) {
    emit("error", error.message);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="panel registration-records-page" data-testid="registration-records-page">
    <div class="panel-title"><h3>报名记录</h3><span>{{ rows.length }} 条</span></div>
    <p class="hint">显示本人参加过的赛事报名记录，可按赛事筛选。</p>
    <div v-if="!props.eventId && eventOptions.length" class="certificate-event-query history-event-filter"><label>赛事筛选
      <select v-model="eventFilter" data-field="registration-history-event"><option value="all">全部赛事</option><option v-for="event in eventOptions" :key="event.id" :value="event.id">{{ event.name }}</option></select>
    </label></div>
    <p v-if="loading" class="hint">正在加载报名记录…</p>
    <section v-if="replacingRegistration" class="registration-submission personal-material-replacement" aria-label="替换作品材料">
      <h4>替换 {{ replacingRegistration.athlete?.name }} 的作品材料</h4>
      <p v-if="replacementLoading && !replacementSession" class="hint">正在创建作品上传会话…</p>
      <template v-else-if="replacementSession?.id">
        <SubmissionAssetUploader :key="replacementSession.id" :session-id="replacementSession.id" mode="image_video" :assets="replacementSession.assets || {}" @complete="replacementComplete = $event" @error="replacementError = '作品材料上传失败，请重试'" />
        <p v-if="partialReplacementMessage" class="message" role="status">{{ partialReplacementMessage }}</p>
        <p v-if="replacementError" class="message" role="alert">{{ replacementError }} <button type="button" class="mini" :data-action="`retry-personal-material-replacement-${replacingRegistration.id}`" :disabled="replacementLoading" @click="retryReplacementSession">重试</button></p>
        <button type="button" class="primary" :data-action="`confirm-personal-material-replacement-${replacingRegistration.id}`" :disabled="replacementLoading || !replacementComplete || !remainingReplacementKinds.length" @click="confirmReplacement">{{ replacementLoading ? "正在替换…" : partialReplacementMessage ? "继续替换剩余素材" : "确认替换作品材料" }}</button>
        <button type="button" class="mini" @click="cancelReplacement">取消替换</button>
      </template>
      <p v-else class="message" role="alert">{{ replacementError || "作品上传会话不可用" }} <button type="button" class="mini" @click="retryReplacementSession">重试</button></p>
    </section>
    <p v-if="replacementResult" class="message" role="status">{{ replacementResult }}</p>
    <div v-if="!loading" class="table-wrap"><table class="registration-record-table"><thead><tr><th>赛事</th><th>编号</th><th>姓名</th><th>学校/年级</th><th>组织</th><th>赛项</th><th>作品材料</th><th>指导老师</th><th>审核状态</th><th>成绩/奖项</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.id"><td>{{ row.eventName || row.eventId || "-" }}</td><td>{{ row.id }}</td><td>{{ row.athlete?.name }}</td><td>{{ row.athlete?.school }}<br /><span>{{ row.athlete?.grade }}</span></td><td>{{ row.organization || row.organizationName || "个人报名" }}</td><td>{{ row.projectName }}<br /><span>{{ row.projectType === "team" ? "团体赛" : "个人赛" }}</span></td><td><template v-if="row.submission?.required"><p v-for="kind in ['artwork_image', 'creation_video']" :key="kind"><span>{{ materialLabel(row.submission.assets?.[kind], kind === 'artwork_image' ? '作品图片' : '作画视频') }}</span><template v-if="assetAvailable(row.submission.assets?.[kind])"> <img v-if="kind === 'artwork_image'" class="submission-artwork-preview" :src="apiUrl(submissionAssetPath(row, kind))" :alt="`${row.submission.assets[kind].originalName} 预览`" /><video v-else class="submission-video-preview" :src="apiUrl(submissionAssetPath(row, kind))" controls preload="metadata"></video> <button type="button" class="mini" @click="downloadSubmissionAsset(row, kind, row.submission.assets[kind])">下载</button></template></p><p v-if="row.status === 'approved'" class="hint">已通过报名的作品材料仅可查看。</p><button v-if="canReplaceMaterials(row)" type="button" class="mini" :data-action="`replace-personal-materials-${row.id}`" @click="createReplacementSession(row)">替换作品材料</button></template><span v-else>无需作品材料</span></td><td>{{ row.instructor || "-" }}</td><td><em :class="row.status">{{ statusText[row.status] || row.status }}</em><p v-if="row.rejectReason" class="hint">驳回原因：{{ row.rejectReason }}</p></td><td>{{ row.awardName || "未录入" }}<br /><span>名次 {{ row.rank || "-" }} · 成绩 {{ row.score || "-" }}</span></td></tr>
    </tbody></table><p v-if="rows.length === 0" class="hint empty-state">暂无报名记录。</p></div>
  </section>
</template>
