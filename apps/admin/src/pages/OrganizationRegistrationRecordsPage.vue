<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import OrganizationAthleteRegistrationForm from "../components/OrganizationAthleteRegistrationForm.vue";
import SubmissionAssetUploader from "../components/SubmissionAssetUploader.vue";
import { api, apiBlob, apiUrl } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import { isOrganizationRestrictionError } from "../state/access.js";

const emit = defineEmits(["back-to-events", "access-denied"]);

const filters = reactive({ q: "", eventId: "", projectId: "", status: "", page: 1, pageSize: 25 });
const rows = ref([]);
const total = ref(0);
const filterOptions = reactive({ events: [], projects: [] });
const loading = ref(false);
const error = ref("");
const editingRegistration = ref(null);
const editingWorkspace = ref(null);
const editingLoading = ref(false);
const editingError = ref("");
const expandedId = ref("");
const replacingRegistration = ref(null);
const replacementSession = ref(null);
const replacementLoading = ref(false);
const replacementComplete = ref(false);
const replacementCompletedKinds = ref(new Set());
const replacementError = ref("");
const replacementResult = ref("");
const cancellationTarget = ref(null);
const cancellationLoading = ref(false);
const cancellationError = ref("");
const materialError = ref("");
const lastDownload = ref(null);
const downloads = createBlobDownloadManager();
const statusText = { pending: "待审核", approved: "已通过", rejected: "已驳回", cancelled: "已取消" };
const sourceText = {
  member_registration: "成员报名",
  organization_proxy: "组织代报名",
  personal: "成员本人报名",
  organization: "历史组织报名"
};
const materialKinds = ["artwork_image", "creation_video"];
const materialLabels = { artwork_image: "作品图片", creation_video: "作画视频" };
const remainingReplacementKinds = computed(() => materialKinds.filter((kind) => !replacementCompletedKinds.value.has(kind)));
let requestId = 0;
let editRequestId = 0;
let replacementRequestId = 0;

function requestPath() {
  const params = new URLSearchParams();
  ["q", "eventId", "projectId", "status"].forEach((key) => {
    if (filters[key]) params.set(key, filters[key]);
  });
  params.set("page", String(filters.page));
  params.set("pageSize", String(filters.pageSize));
  return `/api/organization/registrations?${params.toString()}`;
}

function safeMessage(error, fallback) {
  const message = String(typeof error === "string" ? error : error?.message || "").trim();
  if (!message || /<html|<!doctype|cannot\s+(?:get|post|put|patch|delete)/i.test(message)) return fallback;
  return message;
}

function reportAccessDenied(error) {
  if (!isOrganizationRestrictionError(error)) return false;
  emit("access-denied", error);
  return true;
}

function handleEditingError(error) {
  reportAccessDenied(error);
  editingError.value = safeMessage(error, "报名记录保存失败，请重试");
}

function handleReplacementUploadError(error) {
  reportAccessDenied(error);
  replacementError.value = safeMessage(error, "作品材料上传失败，请重试");
}

function recordsErrorMessage(error) {
  if ([403, 404].includes(error?.status)) return "无法访问报名记录，请返回赛事工作台后重试";
  return safeMessage(error, "报名记录加载失败，请重试");
}

function workspaceErrorMessage(error) {
  if ([403, 404].includes(error?.status)) return "无法访问该赛事工作台，请返回报名记录后重试";
  return safeMessage(error, "赛事工作台加载失败，请重试");
}

function materialErrorMessage(error) {
  if ([403, 404].includes(error?.status)) return "无法下载作品材料，请返回报名记录后重试";
  return safeMessage(error, "作品材料下载失败，请重试");
}

function replacementSessionErrorMessage(error) {
  if ([403, 404].includes(error?.status)) return "无法创建作品上传会话，请返回报名记录后重试";
  return safeMessage(error, "无法创建作品上传会话，请重试");
}

function replacementAssetErrorMessage(error) {
  if ([403, 404].includes(error?.status)) return "无法替换作品材料，请返回报名记录后重试";
  return safeMessage(error, "作品材料替换失败，请重试");
}

function organizationAssetPath(row, kind) {
  return `/api/organization/events/${encodeURIComponent(row.eventId)}/registrations/${encodeURIComponent(row.id)}/assets/${kind}`;
}

function isArchived(row) {
  return Boolean(row?.archivedAt || row?.eventStatus === "archived" || row?.event?.archivedAt || row?.event?.status === "archived");
}

function assetAvailable(asset) {
  return Boolean(asset && !asset.cleanedAt);
}

function canReplaceMaterials(row) {
  return !isArchived(row) && row.submission?.required && ["pending", "approved", "rejected"].includes(row.status);
}

function canEditRegistration(row) {
  return !isArchived(row) && row.status !== "cancelled";
}

function canCancelTeam(row) {
  return !isArchived(row) && row.projectType === "team" && ["pending", "approved"].includes(row.status);
}

async function loadRecords() {
  const currentRequest = ++requestId;
  loading.value = true;
  error.value = "";
  try {
    const payload = await api(requestPath());
    if (currentRequest !== requestId) return;
    rows.value = payload.rows || [];
    total.value = Number(payload.total) || 0;
    filters.page = Number(payload.page) || filters.page;
    filters.pageSize = Number(payload.pageSize) || filters.pageSize;
    filterOptions.events = payload.filterOptions?.events || [];
    filterOptions.projects = payload.filterOptions?.projects || [];
  } catch (requestError) {
    if (currentRequest !== requestId) return;
    reportAccessDenied(requestError);
    rows.value = [];
    total.value = 0;
    error.value = recordsErrorMessage(requestError);
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

function resetAndLoad() {
  filters.page = 1;
  void loadRecords();
}

function previousPage() {
  if (filters.page <= 1) return;
  filters.page -= 1;
  void loadRecords();
}

function nextPage() {
  if (filters.page * filters.pageSize >= total.value) return;
  filters.page += 1;
  void loadRecords();
}

function toggleRoster(registrationId) {
  expandedId.value = expandedId.value === registrationId ? "" : registrationId;
}

async function downloadSubmissionAsset(row, kind, asset) {
  if (!assetAvailable(asset)) return;
  materialError.value = "";
  try {
    const blob = await apiBlob(organizationAssetPath(row, kind));
    downloads.save(blob, blob.fileName || asset.originalName);
  } catch (downloadError) {
    reportAccessDenied(downloadError);
    lastDownload.value = { row, kind, asset };
    materialError.value = materialErrorMessage(downloadError);
  }
}

function retryDownload() {
  const failed = lastDownload.value;
  if (failed) void downloadSubmissionAsset(failed.row, failed.kind, failed.asset);
}

function dismissMaterialError() {
  materialError.value = "";
  lastDownload.value = null;
}

function cancelEditing() {
  editRequestId += 1;
  editingRegistration.value = null;
  editingWorkspace.value = null;
  editingLoading.value = false;
  editingError.value = "";
}

async function editRegistration(row) {
  if (isArchived(row)) return;
  const currentRequest = ++editRequestId;
  editingRegistration.value = row;
  editingWorkspace.value = null;
  editingError.value = "";
  editingLoading.value = true;
  try {
    const workspace = await api(`/api/organization/events/${encodeURIComponent(row.eventId)}/workspace`);
    if (currentRequest !== editRequestId || editingRegistration.value?.id !== row.id) return;
    if (workspace?.event?.status === "archived" || workspace?.event?.archivedAt) {
      editingError.value = "该赛事已归档，不能编辑报名记录";
      return;
    }
    editingWorkspace.value = workspace || {};
  } catch (workspaceError) {
    if (currentRequest !== editRequestId || editingRegistration.value?.id !== row.id) return;
    reportAccessDenied(workspaceError);
    editingError.value = workspaceErrorMessage(workspaceError);
  } finally {
    if (currentRequest === editRequestId) editingLoading.value = false;
  }
}

async function savedRegistration() {
  const registrationId = editingRegistration.value?.id;
  const currentRequest = editRequestId;
  await loadRecords();
  if (currentRequest === editRequestId && editingRegistration.value?.id === registrationId) cancelEditing();
}

function openTeamCancellation(row) {
  if (!canCancelTeam(row)) return;
  cancellationTarget.value = row;
  cancellationError.value = "";
}

function dismissTeamCancellation() {
  if (cancellationLoading.value) return;
  cancellationTarget.value = null;
  cancellationError.value = "";
}

async function confirmTeamCancellation() {
  const row = cancellationTarget.value;
  if (!row || !canCancelTeam(row) || cancellationLoading.value) return;
  cancellationLoading.value = true;
  cancellationError.value = "";
  try {
    await api(`/api/organization/events/${encodeURIComponent(row.eventId)}/registrations/${encodeURIComponent(row.id)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" })
    });
    await loadRecords();
    if (cancellationTarget.value?.id === row.id) cancellationTarget.value = null;
  } catch (cancelError) {
    reportAccessDenied(cancelError);
    cancellationError.value = safeMessage(cancelError, "团队报名取消失败，请重试");
  } finally {
    cancellationLoading.value = false;
  }
}

function cancelReplacement({ keepResult = false } = {}) {
  replacementRequestId += 1;
  replacingRegistration.value = null;
  replacementSession.value = null;
  replacementLoading.value = false;
  replacementComplete.value = false;
  replacementCompletedKinds.value = new Set();
  replacementError.value = "";
  if (!keepResult) replacementResult.value = "";
}

async function createReplacementSession(row) {
  if (!canReplaceMaterials(row)) return;
  const currentRequest = ++replacementRequestId;
  replacingRegistration.value = row;
  replacementSession.value = null;
  replacementComplete.value = false;
  replacementCompletedKinds.value = new Set();
  replacementError.value = "";
  replacementResult.value = "";
  replacementLoading.value = true;
  try {
    const payload = await api(`/api/organization/events/${encodeURIComponent(row.eventId)}/projects/${encodeURIComponent(row.projectId)}/upload-sessions`, { method: "POST" });
    if (currentRequest !== replacementRequestId || replacingRegistration.value?.id !== row.id) return;
    const session = payload?.row || payload;
    if (!session?.id) throw new Error("invalid upload session");
    replacementSession.value = session;
  } catch (sessionError) {
    if (currentRequest !== replacementRequestId || replacingRegistration.value?.id !== row.id) return;
    reportAccessDenied(sessionError);
    replacementError.value = replacementSessionErrorMessage(sessionError);
  } finally {
    if (currentRequest === replacementRequestId) replacementLoading.value = false;
  }
}

function retryReplacement() {
  if (replacementSession.value?.id) void confirmReplacement();
  else if (replacingRegistration.value) void createReplacementSession(replacingRegistration.value);
}

async function confirmReplacement() {
  const row = replacingRegistration.value;
  const sessionId = replacementSession.value?.id;
  const registrationId = row?.id;
  const generation = replacementRequestId;
  const currentReplacement = () => (
    generation === replacementRequestId
    && replacingRegistration.value?.id === registrationId
    && replacementSession.value?.id === sessionId
  );
  if (!row || !sessionId || !replacementComplete.value || replacementLoading.value || !currentReplacement()) return;
  replacementLoading.value = true;
  replacementError.value = "";
  try {
    for (const kind of remainingReplacementKinds.value) {
      if (!currentReplacement()) return;
      await api(organizationAssetPath(row, kind), { method: "PUT", body: JSON.stringify({ uploadSessionId: sessionId }) });
      if (!currentReplacement()) return;
      replacementCompletedKinds.value = new Set([...replacementCompletedKinds.value, kind]);
    }
    if (!currentReplacement()) return;
    await loadRecords();
    if (!currentReplacement()) return;
    replacementResult.value = "作品材料已替换，报名已恢复待审核";
    cancelReplacement({ keepResult: true });
  } catch (replaceError) {
    reportAccessDenied(replaceError);
    if (currentReplacement()) replacementError.value = replacementAssetErrorMessage(replaceError);
  } finally {
    if (currentReplacement()) replacementLoading.value = false;
  }
}

onMounted(() => void loadRecords());
onBeforeUnmount(() => {
  editRequestId += 1;
  replacementRequestId += 1;
  downloads.dispose();
});
</script>

<template>
  <section class="panel organization-registration-records-page" data-testid="organization-registration-records-page">
    <div class="panel-title"><h3>报名记录</h3><span>{{ total }} 条</span></div>
    <p class="hint">查看本组织在全部赛事中的报名、审核和成绩记录。</p>

    <div class="record-filters" aria-label="报名记录筛选">
      <label>搜索<input v-model="filters.q" data-filter="organization-records-q" placeholder="姓名、编号或赛项" @input="resetAndLoad" /></label>
      <label>赛事<select v-model="filters.eventId" data-filter="organization-records-event" @change="resetAndLoad"><option value="">全部赛事</option><option v-for="event in filterOptions.events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label>
      <label>赛项<select v-model="filters.projectId" data-filter="organization-records-project" @change="resetAndLoad"><option value="">全部赛项</option><option v-for="project in filterOptions.projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
      <label>状态<select v-model="filters.status" data-filter="organization-records-status" @change="resetAndLoad"><option value="">全部状态</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="cancelled">已取消</option></select></label>
    </div>

    <p v-if="loading" class="hint">正在加载报名记录…</p>
    <p v-else-if="error" class="message" role="alert">{{ error }} <button type="button" class="mini" data-action="retry-organization-records" @click="loadRecords">重试</button> <button type="button" class="mini" data-action="return-organization-workspace" @click="emit('back-to-events')">返回赛事工作台</button></p>
    <p v-if="materialError" class="message" role="alert">{{ materialError }} <button type="button" class="mini" data-action="retry-organization-material-download" @click="retryDownload">重试</button> <button type="button" class="mini" data-action="dismiss-organization-material-error" @click="dismissMaterialError">关闭</button></p>

    <section v-if="editingRegistration" class="organization-registration-record-editor" aria-label="编辑组织报名">
      <div class="panel-title"><h4>编辑 {{ editingRegistration.projectType === "team" ? editingRegistration.teamCode : editingRegistration.athlete?.name || "报名记录" }}</h4><button type="button" class="mini" data-action="return-organization-records" @click="cancelEditing">返回报名记录</button></div>
      <p v-if="editingLoading" class="hint">正在加载赛事工作台…</p>
      <p v-else-if="editingError" class="message" role="alert">{{ editingError }} <button type="button" class="mini" :data-action="`retry-organization-edit-${editingRegistration.id}`" @click="editRegistration(editingRegistration)">重试</button> <button type="button" class="mini" data-action="return-organization-records" @click="cancelEditing">返回报名记录</button></p>
      <OrganizationAthleteRegistrationForm v-else-if="editingWorkspace" :event-id="editingRegistration.eventId" :projects="editingWorkspace.projects || []" :grades="editingWorkspace.grades || []" :members="editingWorkspace.members || []" :default-school="editingWorkspace.organization?.name || ''" :registration="editingRegistration" @registered="savedRegistration" @error="handleEditingError" />
    </section>

    <section v-if="replacingRegistration" class="organization-registration-material-replacement" aria-label="替换作品材料">
      <div class="panel-title"><h4>替换 {{ replacingRegistration.athlete?.name || "报名记录" }} 的作品材料</h4><button type="button" class="mini" data-action="return-organization-records" @click="cancelReplacement">返回报名记录</button></div>
      <p v-if="replacementLoading && !replacementSession" class="hint">正在创建作品上传会话…</p>
      <template v-else-if="replacementSession?.id">
        <SubmissionAssetUploader :key="replacementSession.id" :session-id="replacementSession.id" mode="image_video" :assets="replacementSession.assets || {}" @complete="replacementComplete = $event" @error="handleReplacementUploadError" />
        <p v-if="replacementError" class="message" role="alert">{{ replacementError }} <button type="button" class="mini" :data-action="`retry-organization-material-replacement-${replacingRegistration.id}`" :disabled="replacementLoading" @click="retryReplacement">重试</button></p>
        <button type="button" class="primary" :data-action="`confirm-organization-material-replacement-${replacingRegistration.id}`" :disabled="replacementLoading || !replacementComplete || !remainingReplacementKinds.length" @click="confirmReplacement">{{ replacementLoading ? "正在替换…" : "确认替换作品材料" }}</button>
      </template>
      <p v-else class="message" role="alert">{{ replacementError || "作品上传会话不可用" }} <button type="button" class="mini" :data-action="`retry-organization-material-replacement-${replacingRegistration.id}`" @click="retryReplacement">重试</button></p>
    </section>
    <p v-if="replacementResult" class="message" role="status">{{ replacementResult }}</p>

    <div v-if="!loading && !error" class="table-wrap"><table class="registration-record-table"><thead><tr><th>赛事</th><th>编号</th><th>报名来源</th><th>姓名</th><th>学生身份证号</th><th>学校/年级</th><th>赛项</th><th>指导老师</th><th>作品材料</th><th>审核状态</th><th>成绩/奖项</th><th>操作</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.id"><td>{{ row.eventName || row.eventId || "-" }}</td><td>{{ row.id }}</td><td>{{ sourceText[row.source] || row.source || "-" }}</td><td class="team-roster-cell"><template v-if="row.projectType === 'team'"><strong data-team-code>{{ row.teamCode }}</strong><button type="button" class="link-button" :data-action="`toggle-roster-${row.id}`" @click="toggleRoster(row.id)">{{ row.participantCount }} 名队员</button><ul v-if="expandedId === row.id" class="team-roster-list" :data-roster="row.id"><li v-for="person in row.participants" :key="person.id"><strong>{{ person.name }}</strong><span>{{ person.school }} · {{ person.grade }}</span><span>{{ person.phone }} · {{ person.studentIdNumber || "—（历史报名）" }}</span></li></ul></template><template v-else>{{ row.athlete?.name || "-" }}</template></td><td class="registration-identity-value">{{ row.projectType === "team" ? "见队员名单" : row.studentIdNumber || "—（历史报名）" }}</td><td><template v-if="row.projectType === 'team'">见队员名单</template><template v-else>{{ row.athlete?.school || "-" }}<br /><span>{{ row.athlete?.grade || "-" }}</span></template></td><td>{{ row.projectName || "-" }}</td><td>{{ row.instructor || "-" }}</td><td class="organization-record-materials"><template v-if="row.submission?.required"><div v-for="kind in materialKinds" :key="kind" :data-asset-kind="kind"><span>{{ materialLabels[kind] }}</span><template v-if="assetAvailable(row.submission.assets?.[kind])"><img v-if="kind === 'artwork_image'" class="submission-artwork-preview" :src="apiUrl(organizationAssetPath(row, kind))" :alt="`${row.submission.assets[kind].originalName} 预览`" /><video v-else class="submission-video-preview" :src="apiUrl(organizationAssetPath(row, kind))" controls preload="metadata"></video><button type="button" class="mini" :data-action="`download-organization-${kind}-${row.id}`" @click="downloadSubmissionAsset(row, kind, row.submission.assets[kind])">下载</button></template><span v-else class="hint">不可用</span></div><button v-if="canReplaceMaterials(row)" type="button" class="mini" :data-action="`replace-organization-materials-${row.id}`" @click="createReplacementSession(row)">替换材料</button></template><span v-else>无需作品材料</span></td><td><em :class="row.status">{{ statusText[row.status] || row.status || "-" }}</em></td><td>{{ row.awardName || "未录入" }}<br /><span>名次 {{ row.rank || "-" }} · 成绩 {{ row.score || "-" }}</span></td><td><button v-if="canEditRegistration(row)" type="button" class="mini" :data-action="`edit-organization-registration-${row.id}`" @click="editRegistration(row)">编辑</button><button v-if="canCancelTeam(row)" type="button" class="mini reject" :data-action="`cancel-organization-team-${row.id}`" @click="openTeamCancellation(row)">取消团队报名</button></td></tr>
    </tbody></table><p v-if="rows.length === 0" class="hint empty-state">暂无报名记录。</p></div>

    <div v-if="cancellationTarget" class="dialog-backdrop" @click.self="dismissTeamCancellation">
      <section class="panel organization-dialog" data-testid="organization-team-cancellation-dialog" role="dialog" aria-modal="true" aria-labelledby="organization-team-cancellation-title">
        <h3 id="organization-team-cancellation-title">确认取消团队报名</h3>
        <p>将取消队伍 <strong>{{ cancellationTarget.teamCode || cancellationTarget.id }}</strong> 的本次报名，并释放队员在本届赛事的团队赛名额。此操作不批量影响其他队伍。</p>
        <p v-if="cancellationError" class="message" role="alert">{{ cancellationError }}</p>
        <div class="form-actions"><button type="button" class="reject" data-action="confirm-organization-team-cancellation" :disabled="cancellationLoading" @click="confirmTeamCancellation">{{ cancellationLoading ? "正在取消…" : "确认取消" }}</button><button type="button" data-action="dismiss-organization-team-cancellation" :disabled="cancellationLoading" @click="dismissTeamCancellation">返回</button></div>
      </section>
    </div>

    <div class="pagination"><button type="button" class="mini" data-action="organization-records-previous" :disabled="loading || filters.page <= 1" @click="previousPage">上一页</button><span>第 {{ filters.page }} 页</span><button type="button" class="mini" data-action="organization-records-next" :disabled="loading || filters.page * filters.pageSize >= total" @click="nextPage">下一页</button></div>
  </section>
</template>
