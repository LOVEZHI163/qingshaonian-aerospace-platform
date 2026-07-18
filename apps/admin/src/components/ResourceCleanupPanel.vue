<script setup>
import { computed, onMounted, ref, watch } from "vue";

import { api } from "../lib/api.js";
import DangerConfirmationDialog from "./DangerConfirmationDialog.vue";

const props = defineProps({ event: { type: Object, required: true } });
const emit = defineEmits(["cleaned", "deleted"]);
const storage = ref({ certificateFiles: 0, importFiles: 0, totalBytes: 0 });
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const success = ref("");
const cleanupOpen = ref(false);
const deleteOpen = ref(false);
const categories = ref(["certificates", "imports"]);
const available = computed(() => props.event?.status === "archived" && !props.event?.isCurrent);

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;
}

async function loadStorage() {
  if (!available.value) return;
  loading.value = true;
  error.value = "";
  try {
    storage.value = await api(`/api/admin/events/${props.event.id}/storage`);
  } catch (cause) {
    error.value = cause.message || "附件统计加载失败";
  } finally {
    loading.value = false;
  }
}

async function cleanup() {
  if (busy.value || categories.value.length === 0) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api(`/api/admin/events/${props.event.id}/cleanup`, {
      method: "POST",
      body: JSON.stringify({ categories: [...categories.value] })
    });
    cleanupOpen.value = false;
    success.value = result.failedFiles?.length
      ? `数据库清理完成，${result.failedFiles.length} 个文件已加入后台重试队列`
      : `已清理 ${result.deletedFiles} 个附件`;
    await loadStorage();
    emit("cleaned", result);
  } catch (cause) {
    error.value = cause.message || "附件清理失败";
  } finally {
    busy.value = false;
  }
}

async function deleteEvent(confirmName) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api(`/api/admin/events/${props.event.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmName })
    });
    deleteOpen.value = false;
    emit("deleted", result.deletedEventId);
  } catch (cause) {
    error.value = cause.message || "赛事彻底删除失败";
  } finally {
    busy.value = false;
  }
}

watch(() => props.event?.id, () => {
  cleanupOpen.value = false;
  deleteOpen.value = false;
  success.value = "";
  loadStorage();
});
onMounted(loadStorage);
</script>

<template>
  <section v-if="available" class="panel resource-cleanup-panel">
    <div class="panel-title"><h3>历史赛事资源</h3><span v-if="loading">统计中…</span></div>
    <p v-if="error" class="message danger-message">{{ error }}</p>
    <p v-if="success" class="message success-message">{{ success }}</p>
    <div class="resource-summary">
      <span><strong>{{ storage.certificateFiles }}</strong> 个证书附件</span>
      <span><strong>{{ storage.importFiles }}</strong> 个导入暂存附件</span>
      <span><strong>{{ formatBytes(storage.totalBytes) }}</strong> 磁盘占用</span>
    </div>
    <div class="form-actions">
      <button type="button" data-action="open-cleanup" :disabled="busy" @click="cleanupOpen = true">清理附件</button>
      <button type="button" class="reject" data-action="open-delete" :disabled="busy" @click="deleteOpen = true">彻底删除赛事</button>
    </div>
    <div v-if="cleanupOpen" class="cleanup-confirmation">
      <p>清理只删除物理附件，保留报名、成绩和证书记录；失败文件会进入后台重试队列。</p>
      <label><input v-model="categories" type="checkbox" value="certificates" />证书附件</label>
      <label><input v-model="categories" type="checkbox" value="imports" />导入暂存附件</label>
      <div class="form-actions">
        <button type="button" class="reject" data-action="confirm-cleanup" :disabled="busy || categories.length === 0" @click="cleanup">确认清理</button>
        <button type="button" :disabled="busy" @click="cleanupOpen = false">取消</button>
      </div>
    </div>
    <DangerConfirmationDialog
      :open="deleteOpen"
      title="彻底删除历史赛事"
      message="此操作会删除本届赛事、赛项、报名、成绩、证书记录及附件，无法恢复；用户、组织和成员关系不会删除。"
      :expected-name="event.name"
      :busy="busy"
      @cancel="deleteOpen = false"
      @confirm="deleteEvent"
    />
  </section>
</template>

