<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import { useSession } from "../state/session.js";

const props = defineProps({ eventId: { type: String, default: "" } });
const emit = defineEmits(["error", "event-id"]);
const session = useSession();
const allCertificates = ref([]);
const loading = ref(true);
const queryEventId = ref(props.eventId);
const eventFilter = ref(props.eventId || "all");
const queryMessage = ref("");
const lastLoadedEventId = ref(null);
const downloads = createBlobDownloadManager();
const ordinaryUser = computed(() => session.user.value?.type === "ordinary");
const organizationUser = computed(() => session.user.value?.type === "organization");
const eventOptions = computed(() => [...new Map(allCertificates.value.map((row) => [row.eventId, row.eventName || row.eventId])).entries()]
  .filter(([eventId]) => eventId)
  .map(([id, name]) => ({ id, name })));
const certificates = computed(() => eventFilter.value === "all"
  ? allCertificates.value
  : allCertificates.value.filter((row) => row.eventId === eventFilter.value));
const validEventId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

async function download(certificate) {
  if (certificate.cleanedAt || !certificate.downloadUrl) return;
  try {
    const blob = await apiBlob(certificate.downloadUrl);
    downloads.save(blob, certificate.fileName || certificate.title || "证书");
  } catch (error) {
    emit("error", error.message || "证书下载失败，请稍后重试");
  }
}

async function loadCertificates(eventId = props.eventId, { reload = false } = {}) {
  if (ordinaryUser.value && eventId && !reload && lastLoadedEventId.value === eventId) return;
  loading.value = true;
  allCertificates.value = [];
  try {
    if (organizationUser.value && !eventId) {
      queryMessage.value = "请输入赛事 ID 查询本组织已发布的证书；已归档赛事仍可查询。";
    } else if (organizationUser.value) {
      queryMessage.value = "";
      allCertificates.value = (await api(`/api/organization/events/${encodeURIComponent(eventId)}/certificates`)).rows || [];
    } else if (!eventId) {
      queryMessage.value = "";
      allCertificates.value = (await api("/api/me/certificates")).rows || [];
    } else {
      queryMessage.value = "";
      lastLoadedEventId.value = eventId;
      allCertificates.value = (await api(`/api/me/events/${encodeURIComponent(eventId)}/certificates`)).rows || [];
    }
  } catch (error) {
    if ([403, 404].includes(error.status)) {
      lastLoadedEventId.value = null;
      queryMessage.value = error.status === 404
        ? "未找到该赛事，已清除失效的赛事链接。请检查赛事 ID 后重试。"
        : "当前账号无权查询该赛事证书，请更换赛事 ID。";
      if (error.status === 404) emit("error", "未找到该赛事，已清除失效的赛事链接。");
      emit("event-id", "");
    } else {
      emit("error", error.message || "证书加载失败，请稍后重试");
    }
  } finally {
    allCertificates.value = allCertificates.value.map((certificate) => ({
      ...certificate,
      eventId: certificate.eventId || certificate.registration?.eventId || eventId,
      eventName: certificate.eventName || certificate.registration?.eventName || eventId
    }));
    loading.value = false;
  }
}

async function queryCertificates() {
  const eventId = String(queryEventId.value || "").trim();
  if (!validEventId.test(eventId)) {
    queryMessage.value = "请输入有效的赛事 ID。";
    return;
  }
  queryEventId.value = eventId;
  if (eventId === props.eventId) {
    await loadCertificates(eventId, { reload: true });
    return;
  }
  emit("event-id", eventId);
  await loadCertificates(eventId, { reload: true });
}

onMounted(async () => {
  await loadCertificates(props.eventId, { reload: true });
});
onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="panel my-certificates-page" data-testid="my-certificates-page">
    <div class="panel-title"><h3>我的证书</h3><span>{{ certificates.length }} 张</span></div>
    <p class="hint">{{ organizationUser ? "显示当前组织在所选赛事中的已发布证书。" : "显示本人全部赛事中已发布的证书，包含历史赛事。" }}</p>
    <div v-if="ordinaryUser && !props.eventId && eventOptions.length" class="certificate-event-query history-event-filter"><label>赛事筛选
      <select v-model="eventFilter" data-field="certificate-history-event"><option value="all">全部赛事</option><option v-for="event in eventOptions" :key="event.id" :value="event.id">{{ event.name }}</option></select>
    </label></div>
    <form v-if="organizationUser" class="certificate-event-query" data-action="query-certificates" @submit.prevent="queryCertificates">
      <label>赛事 ID<input v-model="queryEventId" data-field="certificate-event-id" autocomplete="off" placeholder="例如 E-ARCHIVED" /></label>
      <button type="submit" class="mini">查询证书</button>
    </form>
    <p v-if="queryMessage" class="hint certificate-query-message">{{ queryMessage }}</p>
    <p v-if="loading" class="hint">正在加载证书…</p>
    <div v-else class="table-wrap"><table class="certificate-table"><thead><tr><th>赛事</th><th>姓名</th><th>学校/年级</th><th>赛项</th><th>证书名称</th><th>发布状态</th><th>操作</th></tr></thead><tbody>
      <tr v-for="certificate in certificates" :key="certificate.id"><td>{{ certificate.eventName || certificate.eventId || "-" }}</td><td>{{ certificate.athlete?.name || "-" }}</td><td>{{ certificate.athlete?.school || "-" }}<br /><span>{{ certificate.athlete?.grade || "-" }}</span></td><td>{{ certificate.projectName || "-" }}</td><td>{{ certificate.title || certificate.awardName || "证书" }}</td><td><em class="published">已发布</em><br /><span>{{ certificate.publishedAt?.slice(0, 10) || "-" }}</span></td><td><span v-if="certificate.cleanedAt" class="unavailable-file">原文件已清理</span><button v-else-if="certificate.downloadUrl" class="mini" data-action="download-user-certificate" @click="download(certificate)">下载</button><span v-else class="unavailable-file">文件暂不可下载</span></td></tr>
    </tbody></table><p v-if="certificates.length === 0" class="hint empty-state">暂无可查询证书。</p></div>
  </section>
</template>
