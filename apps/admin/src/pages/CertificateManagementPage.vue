<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import CertificateImportPanel from "../components/CertificateImportPanel.vue";
import FilePreviewDialog from "../components/FilePreviewDialog.vue";
import ManualCertificateEntryPanel from "../components/ManualCertificateEntryPanel.vue";
import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

const props = defineProps({
  initialRegistrationId: { type: String, default: "" },
  initialSection: { type: String, default: "" },
  eventId: { type: String, default: "" }
});

const activeSection = ref(["list", "manual", "import"].includes(props.initialSection)
  ? props.initialSection
  : (props.initialRegistrationId ? "manual" : "list"));
const events = ref([]);
const projects = ref([]);
const metadataLoaded = ref(false);
const certificates = ref([]);
const selectedIds = ref([]);
const selectionStatus = ref("");
const previewTarget = ref(null);
const loading = ref(false);
const bulkLoading = ref(false);
const error = ref("");
const success = ref("");
const listFilters = reactive({ status: "", group: "", projectId: "", q: "" });
const certificatePage = reactive({ page: 1, pageSize: 20, total: 0 });
const downloads = createBlobDownloadManager();
let pageGeneration = 0;
let metadataGeneration = 0;
let suppressFilterReload = false;

const eventProjects = computed(() => projects.value
  .filter((project) => project.eventId === props.eventId));
const archived = computed(() => events.value.find((event) => event.id === props.eventId)?.status === "archived");
const groups = computed(() => [...new Set(eventProjects.value.flatMap((project) => project.allowedGroups || []))]);
const certificatePageCount = computed(() => Math.max(1, Math.ceil(certificatePage.total / certificatePage.pageSize)));

function registrationFor(certificate) {
  return certificate.registration || {};
}

function matchesListFilters(certificate) {
  const registration = registrationFor(certificate);
  if (listFilters.status && certificate.status !== listFilters.status) return false;
  if (listFilters.group && registration.group !== listFilters.group) return false;
  if (listFilters.projectId && registration.projectId !== listFilters.projectId) return false;
  const keyword = listFilters.q.trim().toLowerCase();
  if (!keyword) return true;
  return [certificate.registrationId, registration.athlete?.name, certificate.athlete?.name,
    registration.athlete?.school, registration.group, certificate.projectName, registration.projectName]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(keyword));
}

const filteredCertificates = computed(() => certificates.value.filter(matchesListFilters));
const selectedCertificateRows = computed(() => {
  const byId = new Map(filteredCertificates.value.map((certificate) => [certificate.id, certificate]));
  return selectedIds.value.map((id) => byId.get(id)).filter(Boolean);
});
const selectedCertificateStatus = computed(() => selectionStatus.value || selectedCertificateRows.value[0]?.status || "");

function reconcileSelectedCertificates() {
  const selectableById = new Map(filteredCertificates.value
    .filter((certificate) => !certificate.cleanedAt)
    .map((certificate) => [certificate.id, certificate]));
  const seen = new Set();
  let status = selectionStatus.value;
  const nextIds = selectedIds.value.filter((id) => {
    const certificate = selectableById.get(id);
    if (!certificate || seen.has(id)) return false;
    if (!status) status = certificate.status;
    if (certificate.status !== status) return false;
    seen.add(id);
    return true;
  });
  if (nextIds.length !== selectedIds.value.length) selectedIds.value = nextIds;
  if (!nextIds.length) selectionStatus.value = "";
}

function canSelectCertificate(certificate) {
  return !certificate.cleanedAt
    && (!selectedCertificateStatus.value || selectedCertificateStatus.value === certificate.status);
}

watch(filteredCertificates, reconcileSelectedCertificates);

watch(selectedIds, (ids) => {
  if (!ids.length) {
    selectionStatus.value = "";
    return;
  }
  if (!selectionStatus.value) {
    const selected = filteredCertificates.value.find((certificate) => certificate.id === ids[0]);
    selectionStatus.value = selected?.status || "";
  }
}, { flush: "sync" });

function certificateListPath() {
  const params = new URLSearchParams();
  const query = {
    eventId: props.eventId,
    status: listFilters.status,
    group: listFilters.group,
    projectId: listFilters.projectId,
    name: listFilters.q.trim()
  };
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  params.set("sort", "uploadedAt");
  params.set("direction", "desc");
  params.set("page", String(certificatePage.page));
  params.set("pageSize", String(certificatePage.pageSize));
  return `/api/admin/events/${encodeURIComponent(props.eventId)}/certificates?${params}`;
}

function applyCertificatePage(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const total = Number(payload?.total);
  const page = Number(payload?.page);
  const pageSize = Number(payload?.pageSize);
  certificates.value = rows;
  certificatePage.total = Number.isSafeInteger(total) && total >= 0 ? total : rows.length;
  certificatePage.page = Number.isSafeInteger(page) && page >= 1 ? page : certificatePage.page;
  certificatePage.pageSize = Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 100
    ? pageSize
    : certificatePage.pageSize;
}

async function loadCertificateList({ propagate = false } = {}) {
  if (!props.eventId) return false;
  const generation = ++pageGeneration;
  loading.value = true;
  error.value = "";
  try {
    const payload = await api(certificateListPath());
    if (generation !== pageGeneration) return false;
    applyCertificatePage(payload);
    reconcileSelectedCertificates();
    return true;
  } catch (cause) {
    if (generation !== pageGeneration) return false;
    error.value = cause.message || "证书列表加载失败，请稍后重试。";
    if (propagate) throw cause;
    return false;
  } finally {
    if (generation === pageGeneration) loading.value = false;
  }
}

async function loadEventMetadata() {
  const generation = ++metadataGeneration;
  try {
    const payload = await api("/api/admin/events");
    if (generation !== metadataGeneration) return false;
    events.value = payload.rows || [];
    projects.value = payload.projects || [];
    if (archived.value) activeSection.value = "list";
    suppressFilterReload = true;
    suppressFilterReload = false;
    metadataLoaded.value = true;
    return true;
  } catch (cause) {
    if (generation === metadataGeneration) {
      metadataLoaded.value = true;
      error.value = cause.message || "赛事信息加载失败，请稍后重试。";
    }
    return false;
  }
}

watch([
  () => listFilters.status,
  () => listFilters.group,
  () => listFilters.projectId,
  () => listFilters.q
], () => {
  if (suppressFilterReload) return;
  certificatePage.page = 1;
  selectedIds.value = [];
  success.value = "";
  void loadCertificateList();
}, { flush: "sync" });

async function afterImport() {
  success.value = "";
  error.value = "";
  try {
    if (!await loadCertificateList({ propagate: true })) return;
    success.value = "已保存为未发布证书，证书列表已刷新。";
  } catch (cause) {
    error.value = cause.message || "导入已完成，但列表刷新失败；请手动刷新。";
  }
}

async function afterManualChange(change) {
  success.value = "";
  error.value = "";
  try {
    if (!await loadCertificateList({ propagate: true })) return;
    success.value = change?.message || "证书操作完成，列表已刷新。";
  } catch (cause) {
    error.value = cause.message || "操作已提交，但列表刷新失败；请手动刷新。";
  }
}

async function bulkChangeStatus(status) {
  if (archived.value) return;
  reconcileSelectedCertificates();
  const expectedCurrentStatus = status === "published" ? "draft" : "published";
  if (!selectedIds.value.length || selectedCertificateStatus.value !== expectedCurrentStatus) return;
  const ids = [...selectedIds.value];
  bulkLoading.value = true;
  error.value = "";
  success.value = "";
  try {
    await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/certificates/bulk-status`, {
      method: "POST",
      body: JSON.stringify({ ids, status })
    });
    selectedIds.value = [];
    if (!await loadCertificateList({ propagate: true })) return;
    success.value = status === "published"
      ? `已批量发布 ${ids.length} 张证书。`
      : `已批量撤回 ${ids.length} 张证书。`;
  } catch (cause) {
    error.value = cause.message || (status === "published" ? "批量发布失败，请稍后重试。" : "批量撤回失败，请稍后重试。");
  } finally {
    bulkLoading.value = false;
  }
}

function bulkPublish() {
  return bulkChangeStatus("published");
}

function bulkWithdraw() {
  return bulkChangeStatus("draft");
}

async function downloadCertificate(certificate) {
  if (!certificate.downloadUrl || certificate.cleanedAt) return;
  error.value = "";
  try {
    const blob = await apiBlob(certificate.downloadUrl);
    downloads.save(blob, certificate.fileName || certificate.title || "证书");
  } catch (cause) {
    error.value = cause.message || "证书下载失败，请稍后重试。";
  }
}

function resetFilters() {
  suppressFilterReload = true;
  listFilters.status = "";
  listFilters.group = "";
  listFilters.projectId = "";
  listFilters.q = "";
  suppressFilterReload = false;
  certificatePage.page = 1;
  selectedIds.value = [];
  success.value = "";
  void loadCertificateList();
}

function goCertificatePage(page) {
  const nextPage = Math.min(Math.max(1, page), certificatePageCount.value);
  if (nextPage === certificatePage.page) return;
  certificatePage.page = nextPage;
  selectedIds.value = [];
  success.value = "";
  void loadCertificateList();
}

onMounted(async () => {
  if (props.eventId && await loadEventMetadata()) await loadCertificateList();
});
onBeforeUnmount(() => {
  pageGeneration += 1;
  metadataGeneration += 1;
  downloads.dispose();
});
</script>

<template>
  <section class="certificate-management-page">
    <div class="page-title-row">
      <div><h2>证书管理</h2><p>导入前先预检查；导入和手工上传默认均为未发布，可确认后批量发布。</p></div>
      <button type="button" class="dark" data-action="refresh-certificates" :disabled="loading" @click="loadCertificateList">{{ loading ? "正在刷新…" : "刷新" }}</button>
    </div>

    <p v-if="!eventId" class="hint empty-state">请先从顶部选择赛事。</p>
    <template v-else>
    <nav class="certificate-section-tabs" role="tablist" aria-label="证书管理分类">
      <button type="button" role="tab" data-certificate-section="list" :class="{ active: activeSection === 'list' }" :aria-selected="activeSection === 'list'" @click="activeSection = 'list'">证书列表</button>
      <button v-if="!archived" type="button" role="tab" data-certificate-section="manual" :class="{ active: activeSection === 'manual' }" :aria-selected="activeSection === 'manual'" @click="activeSection = 'manual'">手动录入</button>
      <button v-if="!archived" type="button" role="tab" data-certificate-section="import" :class="{ active: activeSection === 'import' }" :aria-selected="activeSection === 'import'" @click="activeSection = 'import'">批量导入</button>
    </nav>

    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="success" class="success-message">{{ success }}</p>
    <p v-if="loading" class="hint">正在加载证书…</p>

    <section v-show="activeSection === 'list'" class="panel certificate-list-panel" data-section-panel="list">
      <div class="page-title-row">
        <div><h3>证书列表</h3><p>可按赛事、状态、组别、赛项和姓名筛选。</p></div>
        <div v-if="!archived" class="bulk-actions">
          <span>已选 {{ selectedIds.length }} 张</span>
          <button type="button" class="primary" data-action="bulk-publish" :disabled="selectedCertificateStatus !== 'draft' || bulkLoading" @click="bulkPublish">{{ bulkLoading && selectedCertificateStatus === "draft" ? "正在发布…" : "批量发布" }}</button>
          <button type="button" class="ghost" data-action="bulk-withdraw" :disabled="selectedCertificateStatus !== 'published' || bulkLoading" @click="bulkWithdraw">{{ bulkLoading && selectedCertificateStatus === "published" ? "正在撤回…" : "批量撤回" }}</button>
        </div>
      </div>
      <div class="certificate-filter-grid">
        <label>状态<select v-model="listFilters.status"><option value="">全部状态</option><option value="draft">未发布</option><option value="published">已发布</option></select></label>
        <label>组别<select v-model="listFilters.group"><option value="">全部组别</option><option v-for="group in groups" :key="group" :value="group">{{ group }}</option></select></label>
        <label>赛项<select v-model="listFilters.projectId"><option value="">全部赛项</option><option v-for="project in eventProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
        <label>姓名或报名信息<input v-model="listFilters.q" data-list-query placeholder="输入姓名、报名编号、学校"></label>
        <button type="button" class="ghost" @click="resetFilters">清空筛选</button>
      </div>

      <div class="table-wrap">
        <table class="certificate-management-table">
          <thead><tr><th>选择</th><th>姓名</th><th>组别 / 赛项</th><th>位置 / 标题</th><th>成绩</th><th>状态</th><th>文件</th></tr></thead>
          <tbody>
            <tr v-for="certificate in filteredCertificates" :key="certificate.id">
              <td><input v-model="selectedIds" data-certificate-select type="checkbox" :value="certificate.id" :disabled="!canSelectCertificate(certificate) || bulkLoading" :aria-label="`选择${certificate.title}`"></td>
              <td><strong>{{ registrationFor(certificate).athlete?.name || certificate.athlete?.name || '-' }}</strong><br><span>{{ certificate.registrationId }}</span></td>
              <td>{{ registrationFor(certificate).group || '-' }}<br><span>{{ certificate.projectName || registrationFor(certificate).projectName || '-' }}</span></td>
              <td>位置 {{ certificate.slot }}<br><span>{{ certificate.title }}</span></td>
              <td>{{ certificate.awardName || registrationFor(certificate).awardName || '-' }}<br><span>名次 {{ certificate.rank || registrationFor(certificate).rank || '-' }} · 成绩 {{ certificate.score || registrationFor(certificate).score || '-' }}</span></td>
              <td><em :class="certificate.status">{{ certificate.status === 'published' ? '已发布' : '未发布' }}</em></td>
              <td>
                <span v-if="certificate.cleanedAt" class="unavailable-file">原文件已清理，可替换</span>
                <template v-else>
                  <button v-if="certificate.previewUrl" type="button" class="mini" :data-action="`preview-${certificate.id}`" @click="previewTarget = certificate">预览</button>
                  <button v-if="certificate.downloadUrl" type="button" class="mini" :data-action="`download-${certificate.id}`" @click="downloadCertificate(certificate)">下载</button>
                  <span v-if="!certificate.previewUrl && !certificate.downloadUrl" class="unavailable-file">暂无可用文件</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loading && filteredCertificates.length === 0" class="hint empty-state">当前筛选条件下暂无证书。</p>
        <div class="table-pagination" aria-label="证书分页">
          <button type="button" class="mini" data-action="certificate-prev-page" :disabled="loading || certificatePage.page <= 1" @click="goCertificatePage(certificatePage.page - 1)">上一页</button>
          <span data-certificate-page>第 {{ certificatePage.page }} / {{ certificatePageCount }} 页，共 {{ certificatePage.total }} 张</span>
          <button type="button" class="mini" data-action="certificate-next-page" :disabled="loading || certificatePage.page >= certificatePageCount" @click="goCertificatePage(certificatePage.page + 1)">下一页</button>
        </div>
      </div>
    </section>

    <ManualCertificateEntryPanel
      v-if="metadataLoaded && !archived"
      v-show="activeSection === 'manual'"
      data-section-panel="manual"
      :events="events"
      :event-id="eventId"
      :initial-registration-id="initialRegistrationId"
      @changed="afterManualChange"
    />

    <section v-if="!archived" v-show="activeSection === 'import'" class="certificate-import-section" data-section-panel="import">
      <CertificateImportPanel :event-id="eventId" @committed="afterImport" />
    </section>

    <FilePreviewDialog :file="previewTarget" @close="previewTarget = null" />
    </template>
  </section>
</template>
