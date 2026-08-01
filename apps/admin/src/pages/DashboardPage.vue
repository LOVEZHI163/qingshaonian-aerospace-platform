<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

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
const assets = ref([]);
const assetKind = ref("");
const selectedAssetIds = ref([]);
const assetAction = ref("");
const downloads = createBlobDownloadManager();
const loading = ref(false);
const error = ref("");
const visibleAssets = computed(() => assets.value.filter((row) => !assetKind.value || row.kind === assetKind.value));
const allVisibleSelected = computed(() => visibleAssets.value.length > 0 && visibleAssets.value.every((row) => selectedAssetIds.value.includes(row.id)));

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
  "event.feature": "首页置顶",
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

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function loadAssets(eventId = props.eventId) {
  if (!eventId) { assets.value = []; return; }
  const payload = await api(`/api/admin/events/${encodeURIComponent(eventId)}/submission-assets`);
  assets.value = payload.rows || [];
  selectedAssetIds.value = [];
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
      recentImports: payload.recentImports || [],
      recentAuditLogs: payload.recentAuditLogs || []
    };
    await loadAssets(eventId);
  } catch (loadError) {
    error.value = loadError.message || "概览加载失败";
  } finally {
    loading.value = false;
  }
}

async function exportRegistrations() {
  assetAction.value = "export"; error.value = "";
  try {
    const blob = await apiBlob(`/api/admin/events/${encodeURIComponent(props.eventId)}/registrations/export.xlsx?scope=all`);
    downloads.save(blob, `${data.value.event.name || "赛事"}_报名名单.xlsx`);
  } catch (cause) { error.value = cause.message || "报名名单导出失败"; }
  finally { assetAction.value = ""; }
}

async function downloadOne(row) {
  assetAction.value = row.id; error.value = "";
  try { downloads.save(await apiBlob(row.downloadUrl), row.downloadName); }
  catch (cause) { error.value = cause.message || "作品文件下载失败"; }
  finally { assetAction.value = ""; }
}

async function downloadSelected() {
  if (!selectedAssetIds.value.length) return;
  assetAction.value = "bulk-download"; error.value = "";
  try {
    const blob = await apiBlob(`/api/admin/events/${encodeURIComponent(props.eventId)}/submission-assets/download`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selectedAssetIds.value })
    });
    downloads.save(blob, `${data.value.event.name || "赛事"}_作品材料.zip`);
  } catch (cause) { error.value = cause.message || "批量下载失败"; }
  finally { assetAction.value = ""; }
}

async function deleteSelected() {
  if (!selectedAssetIds.value.length || !window.confirm(`确认删除选中的 ${selectedAssetIds.value.length} 个作品文件？此操作会释放服务器空间，且无法恢复。`)) return;
  assetAction.value = "bulk-delete"; error.value = "";
  try {
    await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/submission-assets/bulk-delete`, {
      method: "POST", body: JSON.stringify({ ids: selectedAssetIds.value })
    });
    await load(props.eventId);
  } catch (cause) { error.value = cause.message || "批量删除失败"; }
  finally { assetAction.value = ""; }
}

function toggleVisibleAssets() {
  const visibleIds = visibleAssets.value.map((row) => row.id);
  if (allVisibleSelected.value) selectedAssetIds.value = selectedAssetIds.value.filter((id) => !visibleIds.includes(id));
  else selectedAssetIds.value = [...new Set([...selectedAssetIds.value, ...visibleIds])];
}

watch(() => props.eventId, (eventId) => { void load(eventId); }, { immediate: true });
onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="panel admin-overview dashboard-page">
    <div class="dashboard-heading">
      <div>
        <span class="eyebrow">后台概览</span>
        <h3>管理概览</h3>
        <p>{{ data.event.name || "请选择赛事" }}</p>
      </div>
    </div>

    <p v-if="!eventId" class="hint">请先从顶部选择赛事。</p>
    <p v-else-if="error" class="message danger">{{ error }}</p>
    <p v-else-if="loading" class="hint">正在更新概览…</p>

    <div v-if="eventId" class="status-strip">
      <span><strong>赛事状态</strong>{{ eventStatus }}</span>
      <span :class="data.registrationWindow.open ? 'open' : 'closed'">
        <strong>报名窗口</strong>{{ data.registrationWindow.reason }}
      </span>
    </div>

    <section v-if="eventId" class="dashboard-tools panel-inset">
      <div class="section-title">
        <div><h4>赛事快捷操作</h4><p>当前选择：{{ data.event.name }}</p></div>
      </div>
      <div class="dashboard-tool-actions">
        <button type="button" class="primary" :disabled="assetAction === 'export'" data-action="dashboard-export" @click="exportRegistrations">{{ assetAction === 'export' ? '正在导出…' : '导出报名名单' }}</button>
        <button type="button" data-action="dashboard-certificate-import" @click="$emit('navigate', 'certificates', 'import')">导入证书 Excel</button>
        <button type="button" @click="$emit('navigate', 'registrations')">进入报名管理</button>
      </div>
    </section>

    <section v-if="eventId" class="server-storage panel-inset">
      <div class="section-title"><div><h4>服务器存储概览</h4><p>磁盘达到 {{ data.serverStorage?.thresholds?.warningPercent ?? 80 }}% 时预警</p></div><strong v-if="data.serverStorage?.available" :class="`storage-${data.serverStorage.level}`">{{ Number(data.serverStorage.disk.usedPercent).toFixed(1) }}%</strong></div>
      <p v-if="!data.serverStorage?.available" class="message danger">{{ data.serverStorage?.error || '服务器磁盘状态暂不可用' }}</p>
      <template v-else>
        <div class="storage-progress"><span :style="{ width: `${Math.min(100, data.serverStorage.disk.usedPercent)}%` }"></span></div>
        <div class="storage-facts"><span>已使用 {{ formatBytes(data.serverStorage.disk.usedBytes) }}</span><span>可用 {{ formatBytes(data.serverStorage.disk.availableBytes) }}</span><span>总容量 {{ formatBytes(data.serverStorage.disk.totalBytes) }}</span></div>
      </template>
      <div class="resource-facts"><span>本赛事作品 {{ data.submissionStorage?.totalFiles || 0 }} 个 / {{ formatBytes(data.submissionStorage?.totalBytes) }}</span><span>图片 {{ data.submissionStorage?.artworkImages?.count || 0 }} 个</span><span>视频 {{ data.submissionStorage?.creationVideos?.count || 0 }} 个</span></div>
    </section>

    <div v-if="eventId" class="dashboard-counts">
      <article data-count="registrations"><span>报名总数</span><strong>{{ data.counts.registrations }}</strong></article>
      <article data-count="pending-registrations"><span>待审核报名</span><strong>{{ data.counts.pendingRegistrations }}</strong><button type="button" data-dashboard-target="registrations" @click="$emit('navigate', 'registrations')">去审核</button></article>
      <article data-count="pending-organizations"><span>待审核组织</span><strong>{{ data.counts.pendingOrganizations }}</strong><button type="button" data-dashboard-target="organizations" @click="$emit('navigate', 'organizations')">去审核</button></article>
      <article data-count="draft-certificates"><span>未发布证书</span><strong>{{ data.counts.draftCertificates }}</strong><button type="button" data-dashboard-target="certificates" @click="$emit('navigate', 'certificates')">去检查</button></article>
    </div>

    <div v-if="eventId" class="dashboard-detail-grid">
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

    <section v-if="eventId" class="asset-manager panel-inset">
      <div class="section-title"><div><h4>赛事作品文件</h4><p>可分类选择、批量下载或清理；下载后文件名已包含报名编号、姓名、学校、赛项和组别。</p></div><span>共 {{ assets.length }} 个</span></div>
      <div class="asset-toolbar">
        <select v-model="assetKind"><option value="">全部文件</option><option value="artwork_image">作品图片</option><option value="creation_video">作画视频</option></select>
        <button type="button" :disabled="!visibleAssets.length" @click="toggleVisibleAssets">{{ allVisibleSelected ? '取消本类全选' : '全选当前分类' }}</button>
        <span>已选 {{ selectedAssetIds.length }} 个</span>
        <button type="button" class="primary" :disabled="!selectedAssetIds.length || !!assetAction" data-action="bulk-download-assets" @click="downloadSelected">批量下载 ZIP</button>
        <button type="button" class="danger" :disabled="!selectedAssetIds.length || !!assetAction" data-action="bulk-delete-assets" @click="deleteSelected">批量删除</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>选择</th><th>选手 / 报名编号</th><th>赛项 / 组别</th><th>类型</th><th>大小</th><th>操作</th></tr></thead><tbody>
        <tr v-for="row in visibleAssets" :key="row.id"><td><input v-model="selectedAssetIds" type="checkbox" :value="row.id" :aria-label="`选择${row.downloadName}`"></td><td><strong>{{ row.athleteName }}</strong><br><span>{{ row.registrationId }} · {{ row.school }}</span></td><td>{{ row.projectName }}<br><span>{{ row.group }}</span></td><td>{{ row.kind === 'creation_video' ? '作画视频' : '作品图片' }}</td><td>{{ formatBytes(row.sizeBytes) }}</td><td><button type="button" class="mini" :disabled="assetAction === row.id" @click="downloadOne(row)">下载</button></td></tr>
      </tbody></table><p v-if="!visibleAssets.length" class="hint">当前赛事暂无此类作品文件。</p></div>
    </section>
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
.panel-inset { padding: 18px; border: 1px solid #dbe4ef; border-radius: 14px; background: #fff; }
.section-title p { margin: 4px 0 0; color: #718096; font-size: 13px; }
.dashboard-tool-actions, .asset-toolbar, .storage-facts, .resource-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.storage-progress { height: 12px; margin: 14px 0 10px; overflow: hidden; border-radius: 99px; background: #e8eef5; }
.storage-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #1688e7, #17b89c); }
.storage-facts, .resource-facts { justify-content: space-between; color: #536579; font-size: 13px; }
.resource-facts { margin-top: 14px; padding-top: 14px; border-top: 1px solid #edf1f5; }
.storage-normal { color: #087552; }.storage-warning { color: #ad6400; }.storage-critical { color: #c52e2e; }
.asset-toolbar { margin: 14px 0; }.asset-toolbar select { min-width: 160px; }.asset-toolbar .danger { background: #c9342f; color: #fff; }
.asset-manager table span { color: #718096; font-size: 12px; }
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
