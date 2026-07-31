<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import SubmissionAssetUploader from "../components/SubmissionAssetUploader.vue";
import { api, apiBlob, apiUrl } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import { useSession } from "../state/session.js";

const props = defineProps({ eventId: { type: String, default: "" } });
const emit = defineEmits(["error"]);
const session = useSession();
const rows = ref([]);
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
  return `/api/me/events/${encodeURIComponent(props.eventId)}/registrations/${encodeURIComponent(row.id)}/assets/${kind}`;
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

async function loadRegistrations() {
  if (!props.eventId) return;
  rows.value = (await api(`/api/me/events/${encodeURIComponent(props.eventId)}/registrations`)).rows || [];
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
    const payload = await api(`/api/me/events/${encodeURIComponent(props.eventId)}/projects/${encodeURIComponent(row.projectId)}/upload-sessions`, { method: "POST" });
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
      const payload = await api(submissionAssetPath(row, kind), { method: "PUT", body: JSON.stringify({ uploadSessionId: sessionId }) });
      updated = payload?.registration || updated;
      replacementCompletedKinds.value = new Set([...replacementCompletedKinds.value, kind]);
      if (updated?.id) rows.value = rows.value.map((item) => item.id === updated.id ? updated : item);
      await loadRegistrations();
    }
    replacementResult.value = "作品材料已替换";
    cancelReplacement({ keepResult: true });
  } catch {
    replacementError.value = "作品材料替换失败，请重试";
  } finally {
    replacementLoading.value = false;
  }
}

onMounted(async () => {
  try {
    if (session.user.value?.type === "organization") {
      emit("error", "请在赛事工作台中查看组织报名记录。");
    } else if (!props.eventId) {
      emit("error", "请先从赛事中心选择赛事后查看当前报名");
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
    <p class="hint">仅显示当前赛事中本人的报名记录。</p>
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
    <div v-if="!loading" class="table-wrap"><table class="registration-record-table"><thead><tr><th>编号</th><th>姓名</th><th>学校/年级</th><th>组织</th><th>赛项</th><th>作品材料</th><th>指导老师</th><th>审核状态</th><th>成绩/奖项</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.id"><td>{{ row.id }}</td><td>{{ row.athlete?.name }}</td><td>{{ row.athlete?.school }}<br /><span>{{ row.athlete?.grade }}</span></td><td>{{ row.organization || row.organizationName || "个人报名" }}</td><td>{{ row.projectName }}<br /><span>{{ row.projectType === "team" ? "团体赛" : "个人赛" }}</span></td><td><template v-if="row.submission?.required"><p v-for="kind in ['artwork_image', 'creation_video']" :key="kind"><span>{{ materialLabel(row.submission.assets?.[kind], kind === 'artwork_image' ? '作品图片' : '作画视频') }}</span><template v-if="assetAvailable(row.submission.assets?.[kind])"> <img v-if="kind === 'artwork_image'" class="submission-artwork-preview" :src="apiUrl(submissionAssetPath(row, kind))" :alt="`${row.submission.assets[kind].originalName} 预览`" /><video v-else class="submission-video-preview" :src="apiUrl(submissionAssetPath(row, kind))" controls preload="metadata"></video> <button type="button" class="mini" @click="downloadSubmissionAsset(row, kind, row.submission.assets[kind])">下载</button></template></p><p v-if="row.status === 'approved'" class="hint">已通过报名的作品材料仅可查看。</p><button v-if="canReplaceMaterials(row)" type="button" class="mini" :data-action="`replace-personal-materials-${row.id}`" @click="createReplacementSession(row)">替换作品材料</button></template><span v-else>无需作品材料</span></td><td>{{ row.instructor || "-" }}</td><td><em :class="row.status">{{ statusText[row.status] || row.status }}</em><p v-if="row.rejectReason" class="hint">驳回原因：{{ row.rejectReason }}</p></td><td>{{ row.awardName || "未录入" }}<br /><span>名次 {{ row.rank || "-" }} · 成绩 {{ row.score || "-" }}</span></td></tr>
    </tbody></table><p v-if="rows.length === 0" class="hint empty-state">暂无报名记录。</p></div>
  </section>
</template>
