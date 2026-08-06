<script setup>
import { onBeforeUnmount, ref, watch } from "vue";

import { api, apiBlob, apiUrl } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

const props = defineProps({
  eventId: { type: String, default: "" }
});

const emit = defineEmits(["committed"]);
const fileInput = ref(null);
const selectedFile = ref(null);
const preview = ref(null);
const recoverablePreviews = ref([]);
const loading = ref(false);
const action = ref("");
const error = ref("");
const success = ref("");
const downloads = createBlobDownloadManager();
const xlsxAccept = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let recoveryRequestGeneration = 0;

function clearSelectedFile() {
  selectedFile.value = null;
  if (fileInput.value) fileInput.value.value = "";
}

async function loadRecoverablePreviews(eventId = props.eventId) {
  const generation = ++recoveryRequestGeneration;
  if (!eventId) {
    recoverablePreviews.value = [];
    return;
  }
  try {
    const payload = await api(`/api/admin/events/${encodeURIComponent(eventId)}/certificate-imports`);
    if (generation !== recoveryRequestGeneration || eventId !== props.eventId) return;
    recoverablePreviews.value = Array.isArray(payload?.rows) ? payload.rows : [];
  } catch (cause) {
    if (generation !== recoveryRequestGeneration || eventId !== props.eventId) return;
    recoverablePreviews.value = [];
    error.value = cause.message || "未能加载可恢复的证书预检查，请稍后刷新页面。";
  }
}

function removeRecoverablePreview(batchId) {
  recoverablePreviews.value = recoverablePreviews.value.filter((row) => row.id !== batchId);
}

function resumeImport(batch) {
  if (!batch?.id || action.value) return;
  preview.value = batch;
  clearSelectedFile();
  error.value = "";
  success.value = "已恢复未完成的预检查批次。";
}

function chooseFile(event) {
  if (preview.value) return;
  error.value = "";
  success.value = "";
  const file = event.target.files?.[0] || null;
  if (file && !file.name.toLowerCase().endsWith(".xlsx")) {
    selectedFile.value = null;
    event.target.value = "";
    error.value = "请选择 .xlsx 格式的 Excel 工作簿。";
    return;
  }
  selectedFile.value = file;
}

async function downloadTemplate() {
  if (!props.eventId) {
    error.value = "请先选择赛事，再下载证书模板。";
    return;
  }
  action.value = "template";
  error.value = "";
  try {
    const blob = await apiBlob(`/api/admin/events/${props.eventId}/certificate-template.xlsx`);
    downloads.save(blob, "证书导入模板.xlsx");
  } catch (cause) {
    error.value = cause.message || "模板下载失败，请稍后重试。";
  } finally {
    action.value = "";
  }
}

async function previewImport() {
  if (!props.eventId) {
    error.value = "请先选择赛事，再导入证书。";
    return;
  }
  if (!selectedFile.value) {
    error.value = "请先选择 .xlsx 文件。";
    return;
  }
  loading.value = true;
  action.value = "preview";
  error.value = "";
  success.value = "";
  try {
    const body = new FormData();
    body.append("workbook", selectedFile.value);
    body.append("eventId", props.eventId);
    preview.value = await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/certificate-imports/preview`, { method: "POST", body });
    removeRecoverablePreview(preview.value?.id);
  } catch (cause) {
    error.value = cause.message || "预检查失败，请核对文件后重试。";
  } finally {
    loading.value = false;
    action.value = "";
  }
}

async function downloadErrors() {
  if (!preview.value?.id) return;
  action.value = "errors";
  error.value = "";
  try {
    const blob = await apiBlob(`/api/admin/events/${encodeURIComponent(props.eventId)}/certificate-imports/${preview.value.id}/errors.xlsx`);
    downloads.save(blob, "证书导入错误报告.xlsx");
  } catch (cause) {
    error.value = cause.message || "错误报告下载失败，请稍后重试。";
  } finally {
    action.value = "";
  }
}

async function commitImport() {
  if (!preview.value?.id || preview.value.validCount <= 0) return;
  action.value = "commit";
  error.value = "";
  try {
    const committed = await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/certificate-imports/${preview.value.id}/commit`, { method: "POST" });
    removeRecoverablePreview(preview.value.id);
    preview.value = null;
    clearSelectedFile();
    emit("committed", committed);
  } catch (cause) {
    error.value = cause.message || "确认导入失败，请稍后重试。";
  } finally {
    action.value = "";
  }
}

async function cancelImport() {
  if (!preview.value?.id) return;
  await cancelPreview(preview.value);
}

async function cancelPreview(batch) {
  if (!batch?.id) return;
  action.value = "cancel";
  error.value = "";
  try {
    await api(`/api/admin/events/${encodeURIComponent(props.eventId)}/certificate-imports/${batch.id}`, { method: "DELETE" });
    if (preview.value?.id === batch.id) preview.value = null;
    removeRecoverablePreview(batch.id);
    success.value = "已取消本次预检查，正式数据未发生变化。";
  } catch (cause) {
    error.value = cause.message || "取消预检查失败，请稍后重试。";
  } finally {
    action.value = "";
  }
}

watch(() => props.eventId, (eventId, previousEventId) => {
  if (eventId !== previousEventId) {
    preview.value = null;
    clearSelectedFile();
    error.value = "";
    success.value = "";
  }
  loadRecoverablePreviews(eventId);
}, { immediate: true });

onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="panel certificate-import-panel">
    <div class="page-title-row">
      <div><h3>Excel 导入证书</h3><p>先下载模板填写，再上传工作簿预检查；确认后统一保存为未发布证书。</p></div>
      <button type="button" class="mini" :disabled="!eventId || Boolean(action)" data-action="download-template" @click="downloadTemplate">
        {{ action === "template" ? "正在下载…" : "1. 下载模板" }}
      </button>
    </div>
    <div class="certificate-import-actions">
      <label class="file-picker">2. 选择 Excel 文件
        <input ref="fileInput" data-import-file type="file" :accept="xlsxAccept" :disabled="loading || Boolean(preview) || action === 'commit'" @change="chooseFile">
      </label>
      <span class="selected-file-name">{{ preview?.originalName || selectedFile?.name || "尚未选择文件" }}</span>
      <button type="button" class="dark" data-action="preview-import" :disabled="!selectedFile || loading || Boolean(preview)" @click="previewImport">
        {{ action === "preview" ? "正在预检查…" : "3. 开始预检查" }}
      </button>
    </div>
    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="success" class="success-message">{{ success }}</p>

    <section v-if="!preview && recoverablePreviews.length" class="import-recovery-list" aria-label="可恢复的证书预检查">
      <p class="hint">发现同一赛事尚未完成的预检查，可恢复查看或取消。</p>
      <article v-for="batch in recoverablePreviews" :key="batch.id" class="import-recovery-row">
        <strong>{{ batch.originalName }}</strong>
        <span>有效 {{ batch.validCount }} · 错误 {{ batch.errorCount }}</span>
        <div class="form-actions">
          <button type="button" class="mini" :data-action="`resume-import-${batch.id}`" :disabled="Boolean(action)" @click="resumeImport(batch)">恢复预检查</button>
          <button type="button" class="mini reject" :data-action="`cancel-recoverable-import-${batch.id}`" :disabled="Boolean(action)" @click="cancelPreview(batch)">取消批次</button>
        </div>
      </article>
    </section>

    <template v-if="preview">
      <div class="import-summary" aria-label="导入摘要">
        <strong>{{ preview.originalName }}</strong>
        <span class="success-chip">有效 {{ preview.validCount }}</span>
        <span class="error-chip">错误 {{ preview.errorCount }}</span>
        <span class="replace-chip">替换 {{ preview.replaceCount }}</span>
      </div>

      <div class="import-preview-list">
        <article v-for="candidate in preview.candidates" :key="candidate.rowNumber" class="import-preview-row valid">
          <header><strong>Excel 第 {{ candidate.rowNumber }} 行 · 有效</strong><span>{{ candidate.registrationId }} · {{ candidate.athleteName }}</span></header>
          <p>{{ candidate.projectName }} · 奖项/等级：{{ candidate.result.awardName || '-' }} · 名次：{{ candidate.result.rank || '-' }} · 成绩：{{ candidate.result.score || '-' }}</p>
          <div class="import-certificate-previews">
            <figure v-for="certificate in candidate.certificates" :key="certificate.slot">
              <img :src="apiUrl(certificate.previewUrl)" :alt="`${certificate.title}缩略图`">
              <figcaption>位置 {{ certificate.slot }} · {{ certificate.title }} <em v-if="certificate.replacing" class="replace-chip">将替换</em></figcaption>
            </figure>
          </div>
        </article>
        <article v-for="row in preview.errors" :key="`${row.rowNumber}-${row.registrationId}`" class="import-preview-row invalid">
          <header><strong>Excel 第 {{ row.rowNumber }} 行 · 错误</strong><span>{{ row.registrationId || "未识别报名编号" }}</span></header>
          <p>{{ row.message }}</p>
        </article>
      </div>

      <div class="form-actions import-confirm-actions">
        <button v-if="preview.errorCount > 0" type="button" class="mini" data-action="download-errors" :disabled="Boolean(action)" @click="downloadErrors">
          {{ action === "errors" ? "正在下载…" : "下载错误报告" }}
        </button>
        <button type="button" class="primary" data-action="commit-import" :disabled="preview.validCount <= 0 || Boolean(action)" @click="commitImport">
          {{ action === "commit" ? "正在保存…" : "4. 确认导入" }}
        </button>
        <button type="button" class="ghost" data-action="cancel-import" :disabled="Boolean(action)" @click="cancelImport">取消本批次</button>
      </div>
    </template>
  </section>
</template>
