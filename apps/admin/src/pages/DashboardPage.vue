<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

defineEmits(["navigate"]);
const props = defineProps({ eventId: { type: String, default: "" } });

const moduleOptions = [
  { id: "operations", label: "运营总览", description: "核心数据与常用操作" },
  { id: "registrations", label: "报名与组织", description: "报名和组织审核" },
  { id: "certificates", label: "证书", description: "导入、检查与发布" },
  { id: "storage", label: "作品与存储", description: "文件下载和空间管理" },
  { id: "activity", label: "操作记录", description: "近期后台变更" }
];
const validModules = new Set(moduleOptions.map((row) => row.id));
const requestedModule = new URLSearchParams(window.location.search).get("panel");
const activeModule = ref(validModules.has(requestedModule) ? requestedModule : "operations");

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
const pendingWork = computed(() => Number(data.value.counts.pendingRegistrations || 0)
  + Number(data.value.counts.pendingOrganizations || 0)
  + Number(data.value.counts.draftCertificates || 0));

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
    if (activeModule.value === "storage") await loadAssets(eventId);
  } catch (loadError) {
    error.value = loadError.message || "概览加载失败";
  } finally {
    loading.value = false;
  }
}

function moduleBadge(moduleId) {
  if (moduleId === "operations") return pendingWork.value;
  if (moduleId === "registrations") return Number(data.value.counts.pendingRegistrations || 0) + Number(data.value.counts.pendingOrganizations || 0);
  if (moduleId === "certificates") return Number(data.value.counts.draftCertificates || 0);
  if (moduleId === "storage") return Number(data.value.submissionStorage?.totalFiles || 0);
  return 0;
}

async function selectModule(moduleId) {
  if (!validModules.has(moduleId)) return;
  activeModule.value = moduleId;
  const url = new URL(window.location.href);
  if (moduleId === "operations") url.searchParams.delete("panel");
  else url.searchParams.set("panel", moduleId);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  if (moduleId === "storage" && props.eventId) {
    error.value = "";
    try { await loadAssets(props.eventId); }
    catch (cause) { error.value = cause.message || "作品文件加载失败"; }
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
        <h3>赛事运营工作台</h3>
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

    <nav v-if="eventId" class="dashboard-module-switcher" aria-label="概览模块快速切换">
      <button
        v-for="module in moduleOptions"
        :key="module.id"
        type="button"
        :class="{ active: activeModule === module.id }"
        :data-dashboard-module="module.id"
        @click="selectModule(module.id)"
      >
        <span>{{ module.label }}</span>
        <small>{{ module.description }}</small>
        <strong v-if="moduleBadge(module.id)" class="module-badge">{{ moduleBadge(module.id) }}</strong>
      </button>
    </nav>

    <div v-if="eventId && activeModule === 'operations'" class="module-heading" data-active-module="operations">
      <div><span>OPERATIONS</span><h4>运营总览</h4><p>先处理待办，再进入具体业务页面。</p></div>
    </div>

    <div v-if="eventId && activeModule === 'operations'" class="dashboard-counts">
      <article data-count="registrations"><span>报名总数</span><strong>{{ data.counts.registrations }}</strong></article>
      <article data-count="pending-registrations"><span>待审核报名</span><strong>{{ data.counts.pendingRegistrations }}</strong><button type="button" data-dashboard-target="registrations" @click="$emit('navigate', 'registrations')">去审核</button></article>
      <article data-count="pending-organizations"><span>待审核组织</span><strong>{{ data.counts.pendingOrganizations }}</strong><button type="button" data-dashboard-target="organizations" @click="$emit('navigate', 'organizations')">去审核</button></article>
      <article data-count="draft-certificates"><span>未发布证书</span><strong>{{ data.counts.draftCertificates }}</strong><button type="button" data-dashboard-target="certificates" @click="$emit('navigate', 'certificates')">去检查</button></article>
    </div>

    <section v-if="eventId && activeModule === 'operations'" class="dashboard-tools panel-inset">
      <div class="section-title">
        <div><h4>赛事快捷操作</h4><p>当前选择：{{ data.event.name }}</p></div>
      </div>
      <div class="dashboard-tool-actions">
        <button type="button" class="primary" :disabled="assetAction === 'export'" data-action="dashboard-export" @click="exportRegistrations">{{ assetAction === 'export' ? '正在导出…' : '导出报名名单' }}</button>
        <button type="button" data-action="dashboard-certificate-import" @click="$emit('navigate', 'certificates', 'import')">导入证书 Excel</button>
        <button type="button" @click="$emit('navigate', 'registrations')">进入报名管理</button>
      </div>
    </section>

    <div v-if="eventId && activeModule === 'storage'" class="module-heading" data-active-module="storage">
      <div><span>FILES & STORAGE</span><h4>作品与存储</h4><p>查看服务器空间，并管理作品图片和视频。</p></div>
    </div>

    <section v-if="eventId && activeModule === 'storage'" class="server-storage panel-inset">
      <div class="section-title"><div><h4>服务器存储概览</h4><p>磁盘达到 {{ data.serverStorage?.thresholds?.warningPercent ?? 80 }}% 时预警</p></div><strong v-if="data.serverStorage?.available" :class="`storage-${data.serverStorage.level}`">{{ Number(data.serverStorage.disk.usedPercent).toFixed(1) }}%</strong></div>
      <p v-if="!data.serverStorage?.available" class="message danger">{{ data.serverStorage?.error || '服务器磁盘状态暂不可用' }}</p>
      <template v-else>
        <div class="storage-progress"><span :style="{ width: `${Math.min(100, data.serverStorage.disk.usedPercent)}%` }"></span></div>
        <div class="storage-facts"><span>已使用 {{ formatBytes(data.serverStorage.disk.usedBytes) }}</span><span>可用 {{ formatBytes(data.serverStorage.disk.availableBytes) }}</span><span>总容量 {{ formatBytes(data.serverStorage.disk.totalBytes) }}</span></div>
      </template>
      <div class="resource-facts"><span>本赛事作品 {{ data.submissionStorage?.totalFiles || 0 }} 个 / {{ formatBytes(data.submissionStorage?.totalBytes) }}</span><span>图片 {{ data.submissionStorage?.artworkImages?.count || 0 }} 个</span><span>视频 {{ data.submissionStorage?.creationVideos?.count || 0 }} 个</span></div>
    </section>

    <section v-if="eventId && activeModule === 'registrations'" class="dashboard-module" data-active-module="registrations">
      <div class="module-heading"><div><span>REGISTRATION</span><h4>报名与组织</h4><p>集中查看报名规模和审核任务。</p></div><button type="button" class="primary" @click="$emit('navigate', 'registrations')">进入报名管理</button></div>
      <div class="module-summary-grid three-columns">
        <article><span>全部报名</span><strong>{{ data.counts.registrations }}</strong><small>当前赛事累计报名</small></article>
        <article><span>待审核报名</span><strong>{{ data.counts.pendingRegistrations }}</strong><button type="button" data-dashboard-target="registrations" @click="$emit('navigate', 'registrations')">去审核 →</button></article>
        <article><span>待审核组织</span><strong>{{ data.counts.pendingOrganizations }}</strong><button type="button" data-dashboard-target="organizations" @click="$emit('navigate', 'organizations')">去审核 →</button></article>
      </div>
      <section class="panel-inset module-action-row">
        <div><h4>名单和审核工具</h4><p>导出当前赛事完整名单，或继续处理报名与组织。</p></div>
        <div class="dashboard-tool-actions">
          <button type="button" :disabled="assetAction === 'export'" data-action="dashboard-export" @click="exportRegistrations">{{ assetAction === 'export' ? '正在导出…' : '导出报名名单' }}</button>
          <button type="button" @click="$emit('navigate', 'organizations')">管理组织用户</button>
        </div>
      </section>
    </section>

    <section v-if="eventId && activeModule === 'certificates'" class="dashboard-module certificate-module" data-active-module="certificates">
      <div class="module-heading"><div><span>CERTIFICATES</span><h4>证书</h4><p>查看未发布证书和最近导入记录。</p></div><button type="button" class="primary" data-action="dashboard-certificate-import" @click="$emit('navigate', 'certificates', 'import')">导入证书 Excel</button></div>
      <div class="module-summary-grid two-columns">
        <article><span>未发布证书</span><strong>{{ data.counts.draftCertificates }}</strong><button type="button" data-dashboard-target="certificates" @click="$emit('navigate', 'certificates')">进入证书列表 →</button></article>
        <article><span>最近导入批次</span><strong>{{ data.recentImports.length }}</strong><small>最多显示最近 5 条</small></article>
      </div>
    </section>

    <div v-if="eventId && activeModule === 'activity'" class="module-heading" data-active-module="activity">
      <div><span>ACTIVITY</span><h4>操作记录</h4><p>用于追踪近期后台重要变更。</p></div>
    </div>

    <div v-if="eventId && ['certificates', 'activity'].includes(activeModule)" class="dashboard-detail-grid single-module-detail">
      <section v-if="activeModule === 'certificates'">
        <div class="section-title"><h4>最近证书导入</h4><span>最多 5 条</span></div>
        <div v-if="data.recentImports.length" class="compact-list">
          <article v-for="batch in data.recentImports" :key="batch.id">
            <div><strong>{{ batch.originalName }}</strong><span>{{ formatTime(batch.createdAt) }}</span></div>
            <p>{{ batch.status === 'committed' ? '已提交' : batch.status === 'preview' ? '待确认' : batch.status }} · 有效 {{ batch.validCount }} · 错误 {{ batch.errorCount }}</p>
          </article>
        </div>
        <p v-else class="hint">暂无证书导入记录。</p>
      </section>

      <section v-if="activeModule === 'activity'">
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

    <section v-if="eventId && activeModule === 'storage'" class="asset-manager panel-inset">
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
.dashboard-page { display: grid; min-width: 0; gap: 20px; overflow: hidden; }
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
.dashboard-module-switcher { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; padding: 8px; border: 1px solid #dbe5f0; border-radius: 16px; background: #f3f7fb; }
.dashboard-module-switcher button { position: relative; display: grid; min-width: 0; gap: 4px; padding: 14px 15px; border: 1px solid transparent; border-radius: 12px; background: transparent; color: #50647b; text-align: left; cursor: pointer; transition: .18s ease; }
.dashboard-module-switcher button:hover { border-color: #c8daed; background: #fff; transform: translateY(-1px); }
.dashboard-module-switcher button.active { border-color: #8fc1ef; background: #fff; color: #0d67b8; box-shadow: 0 8px 22px rgba(27, 91, 151, .1); }
.dashboard-module-switcher button > span { overflow: hidden; color: #18314f; font-size: 14px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-module-switcher button.active > span { color: #0d67b8; }
.dashboard-module-switcher small { overflow: hidden; font-size: 11px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.module-badge { position: absolute; top: 8px; right: 8px; display: grid; min-width: 20px; height: 20px; padding: 0 5px; place-items: center; border-radius: 999px; background: #e6f2ff; color: #0d67b8; font-size: 11px; }
.dashboard-module { display: grid; min-width: 0; gap: 18px; }
.module-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; padding: 2px 2px 0; }
.module-heading > div > span { color: #2584d8; font-size: 11px; font-weight: 900; letter-spacing: .12em; }
.module-heading h4 { margin: 3px 0 2px; color: #10243e; font-size: 20px; }
.module-heading p, .module-action-row p { margin: 0; color: #6c7e92; font-size: 13px; }
.module-summary-grid { display: grid; gap: 14px; }
.module-summary-grid.three-columns { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.module-summary-grid.two-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.module-summary-grid article { display: grid; min-width: 0; min-height: 145px; gap: 9px; align-content: center; padding: 20px; border: 1px solid #dbe4ef; border-radius: 15px; background: linear-gradient(145deg, #fff, #f5f9fd); }
.module-summary-grid article > span { color: #51667e; font-size: 14px; font-weight: 700; }
.module-summary-grid article > strong { color: #10243e; font-size: 34px; }
.module-summary-grid article > small { color: #7a8a9d; }
.module-summary-grid article > button { justify-self: start; border: 0; padding: 0; background: transparent; color: #1476d4; font-weight: 800; cursor: pointer; }
.module-action-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.module-action-row h4 { margin: 0 0 5px; }
.dashboard-counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.dashboard-counts article { display: grid; gap: 8px; min-height: 122px; padding: 18px; border: 1px solid #dbe4ef; border-radius: 14px; background: linear-gradient(145deg, #fff, #f6f9fc); }
.dashboard-counts strong { color: #10243e; font-size: 30px; }
.dashboard-counts button { justify-self: start; border: 0; padding: 0; background: transparent; color: #1476d4; font-weight: 700; cursor: pointer; }
.dashboard-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.dashboard-detail-grid.single-module-detail { grid-template-columns: minmax(0, 1fr); }
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
  .dashboard-module-switcher { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .dashboard-counts, .dashboard-detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dashboard-detail-grid.single-module-detail { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .dashboard-heading { align-items: stretch; flex-direction: column; }
  .event-selector { min-width: 0; }
  .dashboard-module-switcher { display: flex; margin-inline: -4px; padding: 6px; overflow-x: auto; scroll-snap-type: x mandatory; }
  .dashboard-module-switcher button { min-width: 155px; scroll-snap-align: start; }
  .module-heading, .module-action-row { align-items: stretch; flex-direction: column; }
  .module-summary-grid.three-columns, .module-summary-grid.two-columns { grid-template-columns: 1fr; }
  .dashboard-counts, .dashboard-detail-grid { grid-template-columns: 1fr; }
}
</style>
