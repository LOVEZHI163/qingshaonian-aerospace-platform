<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import CertificateImportPanel from "../components/CertificateImportPanel.vue";
import CertificateSlotEditor from "../components/CertificateSlotEditor.vue";
import FilePreviewDialog from "../components/FilePreviewDialog.vue";
import { api, apiBlob } from "../lib/api.js";
import { loadAdminRegistrations } from "../lib/admin-registrations.js";
import { createBlobDownloadManager } from "../lib/download.js";

const props = defineProps({
  initialRegistrationId: { type: String, default: "" },
  initialEventId: { type: String, default: "" }
});

const events = ref([]);
const projects = ref([]);
const registrations = ref([]);
const certificates = ref([]);
const selectedRegistrationCertificates = ref([]);
const selectedIds = ref([]);
const selectionStatus = ref("");
const selectedRegistrationId = ref("");
const previewTarget = ref(null);
const loading = ref(false);
const registrationLoading = ref(false);
const bulkLoading = ref(false);
const resultLoading = ref(false);
const error = ref("");
const success = ref("");
const filters = reactive({ eventId: "", status: "", group: "", projectId: "", q: "" });
const certificatePage = reactive({ page: 1, pageSize: 20, total: 0 });
const result = reactive({ awardName: "", rank: "", score: "" });
const downloads = createBlobDownloadManager();
let pageGeneration = 0;
let selectedCertificateRequestGeneration = 0;
let suppressFilterReload = false;

const eventProjects = computed(() => projects.value.filter((project) => !filters.eventId || project.eventId === filters.eventId));
const groups = computed(() => [...new Set(eventProjects.value.flatMap((project) => project.allowedGroups || []))]);
const selectedRegistration = computed(() => registrations.value.find((row) => row.id === selectedRegistrationId.value) || null);
const selectedCertificates = computed(() => selectedRegistrationCertificates.value
  .filter((certificate) => certificate.registrationId === selectedRegistrationId.value));
const selectedCertificateRows = computed(() => {
  const byId = new Map(filteredCertificates.value.map((certificate) => [certificate.id, certificate]));
  return selectedIds.value.map((id) => byId.get(id)).filter(Boolean);
});
const selectedCertificateStatus = computed(() => selectionStatus.value || selectedCertificateRows.value[0]?.status || "");
const certificatePageCount = computed(() => Math.max(1, Math.ceil(certificatePage.total / certificatePage.pageSize)));

function registrationFor(certificate) {
  return certificate.registration || registrations.value.find((row) => row.id === certificate.registrationId) || {};
}

function matchesSharedFilters(registration) {
  if (filters.eventId && registration.eventId !== filters.eventId) return false;
  if (filters.group && registration.group !== filters.group) return false;
  if (filters.projectId && registration.projectId !== filters.projectId) return false;
  const keyword = filters.q.trim().toLowerCase();
  if (!keyword) return true;
  return [registration.id, registration.athlete?.name, registration.athlete?.school, registration.group, registration.projectName]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(keyword));
}

const filteredCertificates = computed(() => certificates.value.filter((certificate) => {
  if (filters.status && certificate.status !== filters.status) return false;
  return matchesSharedFilters(registrationFor(certificate));
}));

const filteredRegistrations = computed(() => registrations.value.filter(matchesSharedFilters));

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

watch(selectedRegistration, (registration) => {
  Object.assign(result, {
    awardName: registration?.awardName || "",
    rank: registration?.rank || "",
    score: registration?.score || ""
  });
}, { immediate: true });

watch(filteredRegistrations, (rows) => {
  if (!rows.length) {
    selectedRegistrationId.value = "";
    return;
  }
  if (!rows.some((row) => row.id === selectedRegistrationId.value)) selectedRegistrationId.value = rows[0].id;
}, { flush: "sync" });

function registrationFilters(eventId = filters.eventId) {
  return eventId ? { eventId } : {};
}

function isCurrentPageGeneration(generation) {
  return generation === pageGeneration;
}

function certificateListPath({ registrationId = "", page = certificatePage.page, pageSize = certificatePage.pageSize } = {}) {
  const params = new URLSearchParams();
  if (registrationId) {
    params.set("registrationId", registrationId);
  } else {
    const query = {
      eventId: filters.eventId,
      status: filters.status,
      group: filters.group,
      projectId: filters.projectId,
      name: filters.q.trim()
    };
    for (const [key, value] of Object.entries(query)) {
      if (value) params.set(key, value);
    }
  }
  params.set("sort", "uploadedAt");
  params.set("direction", "desc");
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  return `/api/admin/certificates?${params}`;
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

async function loadSelectedRegistrationCertificates(registrationId = selectedRegistrationId.value, generation = pageGeneration) {
  const requestGeneration = ++selectedCertificateRequestGeneration;
  if (!registrationId) {
    selectedRegistrationCertificates.value = [];
    return false;
  }
  try {
    const payload = await api(certificateListPath({ registrationId, page: 1, pageSize: 2 }));
    if (requestGeneration !== selectedCertificateRequestGeneration
      || !isCurrentPageGeneration(generation)
      || registrationId !== selectedRegistrationId.value) return false;
    selectedRegistrationCertificates.value = Array.isArray(payload?.rows) ? payload.rows : [];
    return true;
  } catch (cause) {
    if (requestGeneration !== selectedCertificateRequestGeneration
      || !isCurrentPageGeneration(generation)
      || registrationId !== selectedRegistrationId.value) return false;
    selectedRegistrationCertificates.value = [];
    error.value = cause.message || "所选报名的证书加载失败，请稍后重试。";
    return false;
  }
}

async function loadRegistrations(eventId = filters.eventId, generation = pageGeneration) {
  if (!isCurrentPageGeneration(generation)) return false;
  registrationLoading.value = true;
  try {
    const rows = await loadAdminRegistrations(registrationFilters(eventId));
    if (!isCurrentPageGeneration(generation)) return false;
    registrations.value = rows;
    return true;
  } catch (cause) {
    if (!isCurrentPageGeneration(generation)) return false;
    throw cause;
  } finally {
    if (isCurrentPageGeneration(generation)) registrationLoading.value = false;
  }
}

watch(selectedRegistrationId, (registrationId) => {
  void loadSelectedRegistrationCertificates(registrationId);
}, { flush: "sync" });

watch(() => filters.eventId, (eventId, previousEventId) => {
  if (eventId === previousEventId || suppressFilterReload) return;
  suppressFilterReload = true;
  filters.group = "";
  filters.projectId = "";
  selectedRegistrationId.value = "";
  selectedIds.value = [];
  certificatePage.page = 1;
  suppressFilterReload = false;
  error.value = "";
  success.value = "";
  void loadPage();
}, { flush: "sync" });

watch([
  () => filters.status,
  () => filters.group,
  () => filters.projectId,
  () => filters.q
], () => {
  if (suppressFilterReload) return;
  certificatePage.page = 1;
  selectedIds.value = [];
  error.value = "";
  success.value = "";
  void loadPage();
}, { flush: "sync" });

async function loadPage({ propagate = false } = {}) {
  const generation = ++pageGeneration;
  loading.value = true;
  error.value = "";
  try {
    const eventPayload = await api("/api/admin/events");
    if (!isCurrentPageGeneration(generation)) return false;
    events.value = eventPayload.rows || [];
    projects.value = eventPayload.projects || [];
    const requestedEventId = props.initialEventId && events.value.some((event) => event.id === props.initialEventId)
      ? props.initialEventId
      : "";
    if (!filters.eventId) {
      suppressFilterReload = true;
      filters.eventId = requestedEventId || events.value.find((event) => event.isCurrent)?.id || events.value[0]?.id || "";
      suppressFilterReload = false;
    }
    const eventId = filters.eventId;
    const [certificatePayload, registrationsApplied] = await Promise.all([
      api(certificateListPath()),
      loadRegistrations(eventId, generation)
    ]);
    if (!isCurrentPageGeneration(generation) || !registrationsApplied) return false;
    applyCertificatePage(certificatePayload);
    const requested = props.initialRegistrationId && registrations.value.some((row) => row.id === props.initialRegistrationId)
      ? props.initialRegistrationId
      : "";
    if (requested) selectedRegistrationId.value = requested;
    else if (!registrations.value.some((row) => row.id === selectedRegistrationId.value)) selectedRegistrationId.value = filteredRegistrations.value[0]?.id || "";
    await loadSelectedRegistrationCertificates(selectedRegistrationId.value, generation);
    if (!isCurrentPageGeneration(generation)) return false;
    reconcileSelectedCertificates();
    return true;
  } catch (cause) {
    if (!isCurrentPageGeneration(generation)) return false;
    error.value = cause.message || "证书管理页面加载失败，请稍后重试。";
    if (propagate) throw cause;
    return false;
  } finally {
    if (isCurrentPageGeneration(generation)) {
      loading.value = false;
      registrationLoading.value = false;
    }
  }
}

async function refreshCertificates() {
  return loadPage({ propagate: true });
}

async function afterImport() {
  success.value = "";
  error.value = "";
  try {
    if (!await refreshCertificates()) return;
    success.value = "已保存为未发布证书，证书与报名列表已刷新。";
  } catch (cause) {
    error.value = cause.message || "导入已完成，但列表刷新失败；请手动刷新。";
  }
}

async function afterCertificateChanged(change) {
  success.value = "";
  error.value = "";
  try {
    if (!await refreshCertificates()) return;
    success.value = change?.message || "证书操作完成，列表已刷新。";
  } catch (cause) {
    error.value = cause.message || "操作已提交，但列表刷新失败；请手动刷新。";
  }
}

async function bulkChangeStatus(status) {
  reconcileSelectedCertificates();
  const expectedCurrentStatus = status === "published" ? "draft" : "published";
  if (!selectedIds.value.length || selectedCertificateStatus.value !== expectedCurrentStatus) return;
  const ids = [...selectedIds.value];
  bulkLoading.value = true;
  error.value = "";
  success.value = "";
  try {
    await api("/api/admin/certificates/bulk-status", {
      method: "POST",
      body: JSON.stringify({ ids, status })
    });
    selectedIds.value = [];
    if (!await refreshCertificates()) return;
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

async function saveResult() {
  if (!selectedRegistration.value) return;
  resultLoading.value = true;
  error.value = "";
  success.value = "";
  try {
    await api(`/api/admin/registrations/${selectedRegistration.value.id}/result`, {
      method: "POST",
      body: JSON.stringify({ awardName: result.awardName, rank: result.rank, score: result.score })
    });
    if (!await refreshCertificates()) return;
    success.value = "成绩已保存，证书列表已刷新。";
  } catch (cause) {
    error.value = cause.message || "成绩保存失败，请稍后重试。";
  } finally {
    resultLoading.value = false;
  }
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
  filters.status = "";
  filters.group = "";
  filters.projectId = "";
  filters.q = "";
  suppressFilterReload = false;
  certificatePage.page = 1;
  selectedIds.value = [];
  error.value = "";
  success.value = "";
  void loadPage();
}

function goCertificatePage(page) {
  const nextPage = Math.min(Math.max(1, page), certificatePageCount.value);
  if (nextPage === certificatePage.page) return;
  certificatePage.page = nextPage;
  selectedIds.value = [];
  error.value = "";
  success.value = "";
  void loadPage();
}

onMounted(loadPage);
onBeforeUnmount(() => {
  pageGeneration += 1;
  selectedCertificateRequestGeneration += 1;
  downloads.dispose();
});
</script>

<template>
  <section class="certificate-management-page">
    <div class="page-title-row">
      <div><h2>证书管理</h2><p>导入前先预检查；导入和手工上传默认均为未发布，可确认后批量发布。</p></div>
      <button type="button" class="dark" data-action="refresh-certificates" :disabled="loading" @click="loadPage">{{ loading ? "正在刷新…" : "刷新" }}</button>
    </div>
    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="success" class="success-message">{{ success }}</p>
    <p v-if="loading" class="hint">正在加载证书…</p>
    <p v-else-if="registrationLoading" class="hint">正在加载所选赛事的全部报名…</p>

    <CertificateImportPanel :event-id="filters.eventId" @committed="afterImport" />

    <section class="panel certificate-list-panel">
      <div class="page-title-row">
        <div><h3>证书列表</h3><p>可按赛事、状态、组别、赛项和姓名筛选。</p></div>
        <div class="bulk-actions">
          <span>已选 {{ selectedIds.length }} 张</span>
          <button type="button" class="primary" data-action="bulk-publish" :disabled="selectedCertificateStatus !== 'draft' || bulkLoading" @click="bulkPublish">{{ bulkLoading && selectedCertificateStatus === "draft" ? "正在发布…" : "批量发布" }}</button>
          <button type="button" class="ghost" data-action="bulk-withdraw" :disabled="selectedCertificateStatus !== 'published' || bulkLoading" @click="bulkWithdraw">{{ bulkLoading && selectedCertificateStatus === "published" ? "正在撤回…" : "批量撤回" }}</button>
        </div>
      </div>
      <div class="certificate-filter-grid">
        <label>赛事<select v-model="filters.eventId"><option value="">全部赛事</option><option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option></select></label>
        <label>状态<select v-model="filters.status"><option value="">全部状态</option><option value="draft">未发布</option><option value="published">已发布</option></select></label>
        <label>组别<select v-model="filters.group"><option value="">全部组别</option><option v-for="group in groups" :key="group" :value="group">{{ group }}</option></select></label>
        <label>赛项<select v-model="filters.projectId"><option value="">全部赛项</option><option v-for="project in eventProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
        <label>姓名或报名信息<input v-model="filters.q" placeholder="输入姓名、报名编号、学校"></label>
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

    <section class="panel registration-certificate-panel">
      <div class="page-title-row"><div><h3>报名详情与双证书</h3><p>先选择报名，再分别维护两个证书位置；成绩三个字段互不合并。</p></div><span>{{ filteredRegistrations.length }} 条报名</span></div>
      <div class="registration-detail-layout">
        <aside class="registration-picker" aria-label="报名列表">
          <button v-for="row in filteredRegistrations" :key="row.id" type="button" :class="{ active: selectedRegistrationId === row.id }" @click="selectedRegistrationId = row.id">
            <strong>{{ row.athlete?.name || '-' }}</strong><span>{{ row.id }}</span><small>{{ row.group }} · {{ row.projectName }}</small>
          </button>
          <p v-if="filteredRegistrations.length === 0" class="hint empty-state">当前筛选条件下暂无报名。</p>
        </aside>
        <div v-if="selectedRegistration" class="registration-certificate-detail">
          <div class="registration-summary"><strong>{{ selectedRegistration.athlete?.name }}</strong><span>{{ selectedRegistration.id }} · {{ selectedRegistration.athlete?.school }} · {{ selectedRegistration.group }} · {{ selectedRegistration.projectName }}</span></div>
          <form class="result-editor" @submit.prevent="saveResult">
            <label>奖项 / 等级<input v-model="result.awardName" data-result="awardName"></label>
            <label>名次<input v-model="result.rank" data-result="rank"></label>
            <label>成绩 / 分数<input v-model="result.score" data-result="score"></label>
            <button type="button" class="dark" data-action="save-result" :disabled="resultLoading" @click="saveResult">{{ resultLoading ? "正在保存…" : "保存成绩" }}</button>
          </form>
          <CertificateSlotEditor :key="selectedRegistration.id" :registration="selectedRegistration" :certificates="selectedCertificates" @changed="afterCertificateChanged" />
        </div>
        <p v-else class="hint empty-state registration-certificate-detail">请选择一条报名记录。</p>
      </div>
    </section>

    <FilePreviewDialog :file="previewTarget" @close="previewTarget = null" />
  </section>
</template>
