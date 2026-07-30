<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import { useSession } from "../state/session.js";

const props = defineProps({ eventId: { type: String, default: "" } });
const emit = defineEmits(["error", "event-id"]);
const session = useSession();
const certificates = ref([]);
const loading = ref(true);
const queryEventId = ref(props.eventId);
const queryMessage = ref("");
const downloads = createBlobDownloadManager();
const managedOrganizations = computed(() => (session.organizations.value || []).filter((item) => item.status === "active" && item.reviewStatus === "approved" && ["owner", "manager"].includes(item.membershipRole)));
const ordinaryUser = computed(() => session.user.value?.type === "ordinary");
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

async function loadCertificates(eventId = props.eventId) {
  loading.value = true;
  certificates.value = [];
  try {
    if (session.user.value?.type === "organization") {
      const query = props.eventId ? `?eventId=${encodeURIComponent(props.eventId)}` : "";
      const payloads = await Promise.all(managedOrganizations.value.map((organization) => api(`/api/organizations/${organization.id}/certificates${query}`)));
      certificates.value = payloads.flatMap((payload) => payload.rows || []);
    } else if (!eventId) {
      queryMessage.value = "请输入赛事 ID 查询已发布证书；历史归档赛事也可查询。";
    } else {
      queryMessage.value = "";
      certificates.value = (await api(`/api/me/events/${encodeURIComponent(eventId)}/certificates`)).rows || [];
    }
  } catch (error) {
    emit("error", error.message);
  } finally {
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
  emit("event-id", eventId);
  await loadCertificates(eventId);
}

onMounted(async () => {
  await loadCertificates(props.eventId);
});
onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="panel my-certificates-page" data-testid="my-certificates-page">
    <div class="panel-title"><h3>我的证书</h3><span>{{ certificates.length }} 张</span></div>
    <p class="hint">{{ session.user.value?.type === "organization" ? "显示当前组织 active 成员的已发布证书。" : "显示当前赛事中本人已发布的证书。" }}</p>
    <form v-if="ordinaryUser" class="certificate-event-query" data-action="query-certificates" @submit.prevent="queryCertificates">
      <label>赛事 ID<input v-model="queryEventId" data-field="certificate-event-id" autocomplete="off" placeholder="例如 E-ARCHIVED" /></label>
      <button type="submit" class="mini">查询证书</button>
    </form>
    <p v-if="queryMessage" class="hint certificate-query-message">{{ queryMessage }}</p>
    <p v-if="loading" class="hint">正在加载证书…</p>
    <div v-else class="table-wrap"><table class="certificate-table"><thead><tr><th>姓名</th><th>学校/年级</th><th>赛项</th><th>证书名称</th><th>发布状态</th><th>操作</th></tr></thead><tbody>
      <tr v-for="certificate in certificates" :key="certificate.id"><td>{{ certificate.athlete?.name || "-" }}</td><td>{{ certificate.athlete?.school || "-" }}<br /><span>{{ certificate.athlete?.grade || "-" }}</span></td><td>{{ certificate.projectName || "-" }}</td><td>{{ certificate.title || certificate.awardName || "证书" }}</td><td><em class="published">已发布</em><br /><span>{{ certificate.publishedAt?.slice(0, 10) || "-" }}</span></td><td><span v-if="certificate.cleanedAt" class="unavailable-file">原文件已清理</span><button v-else-if="certificate.downloadUrl" class="mini" data-action="download-user-certificate" @click="download(certificate)">下载</button><span v-else class="unavailable-file">文件暂不可下载</span></td></tr>
    </tbody></table><p v-if="certificates.length === 0" class="hint empty-state">暂无可查询证书。</p></div>
  </section>
</template>
