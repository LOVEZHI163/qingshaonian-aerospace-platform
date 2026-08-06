<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { api, apiBlob, apiUrl } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";

const rows = ref([]);
const loading = ref(true);
const error = ref("");
const eventFilter = ref("all");
const downloads = createBlobDownloadManager();

const eventOptions = computed(() => [...new Map(rows.value
  .filter((row) => row.eventId)
  .map((row) => [row.eventId, row.eventName || row.eventId])).entries()]
  .map(([id, name]) => ({ id, name })));
const certificates = computed(() => eventFilter.value === "all"
  ? rows.value
  : rows.value.filter((row) => row.eventId === eventFilter.value));

function safeError(value, fallback) {
  const message = String(value?.message || value || "").trim();
  return !message || /<!doctype|<html|cannot\s+(?:get|post|put|patch|delete)/i.test(message) ? fallback : message;
}

async function loadCertificates() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = (await api("/api/organization/certificates")).rows || [];
  } catch (requestError) {
    rows.value = [];
    error.value = safeError(requestError, "证书加载失败，请重试");
  } finally {
    loading.value = false;
  }
}

function preview(certificate) {
  if (certificate.cleanedAt || !certificate.previewUrl) return;
  window.open(apiUrl(certificate.previewUrl), "_blank", "noopener,noreferrer");
}

async function download(certificate) {
  if (certificate.cleanedAt || !certificate.downloadUrl) return;
  try {
    const blob = await apiBlob(certificate.downloadUrl);
    downloads.save(blob, certificate.fileName || certificate.title || "证书");
  } catch (requestError) {
    error.value = safeError(requestError, "证书下载失败，请重试");
  }
}

onMounted(loadCertificates);
onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="panel organization-certificates-page" data-testid="organization-certificates-page">
    <div class="panel-title"><div><h3>组织证书</h3><p class="hint">显示本组织全部赛事中已发布的证书，包含往届和归档赛事。</p></div><span>{{ certificates.length }} 张</span></div>
    <label v-if="eventOptions.length" class="certificate-event-query history-event-filter">赛事筛选
      <select v-model="eventFilter" data-field="organization-certificate-event"><option value="all">全部赛事</option><option v-for="event in eventOptions" :key="event.id" :value="event.id">{{ event.name }}</option></select>
    </label>
    <p v-if="error" class="message" role="alert">{{ error }} <button type="button" class="mini" data-action="retry-organization-certificates" @click="loadCertificates">重试</button></p>
    <p v-if="loading" class="hint">正在加载证书…</p>
    <div v-else-if="!error" class="table-wrap"><table class="certificate-table"><thead><tr><th>赛事</th><th>姓名</th><th>学校/年级</th><th>赛项</th><th>证书名称</th><th>发布时间</th><th>操作</th></tr></thead><tbody>
      <tr v-for="certificate in certificates" :key="certificate.id"><td>{{ certificate.eventName || certificate.eventId || "-" }}</td><td>{{ certificate.athlete?.name || "-" }}</td><td>{{ certificate.athlete?.school || "-" }}<br /><span>{{ certificate.athlete?.grade || "-" }}</span></td><td>{{ certificate.projectName || "-" }}</td><td>{{ certificate.title || certificate.awardName || "证书" }}</td><td>{{ certificate.publishedAt?.slice(0, 10) || "-" }}</td><td><span v-if="certificate.cleanedAt" class="unavailable-file">原文件已清理</span><template v-else><button v-if="certificate.previewUrl" type="button" class="mini" :data-action="`preview-organization-certificate-${certificate.id}`" @click="preview(certificate)">预览</button><button v-if="certificate.downloadUrl" type="button" class="mini" :data-action="`download-organization-certificate-${certificate.id}`" @click="download(certificate)">下载</button></template></td></tr>
    </tbody></table><p v-if="certificates.length === 0" class="hint empty-state">暂无可查询证书。</p></div>
  </section>
</template>
