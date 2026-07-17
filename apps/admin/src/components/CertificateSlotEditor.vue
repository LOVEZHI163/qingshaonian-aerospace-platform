<script setup>
import { onBeforeUnmount, reactive, ref, watch } from "vue";

import { api, apiBlob } from "../lib/api.js";
import { createBlobDownloadManager } from "../lib/download.js";
import FilePreviewDialog from "./FilePreviewDialog.vue";

const props = defineProps({
  registration: { type: Object, required: true },
  certificates: { type: Array, default: () => [] }
});

const emit = defineEmits(["changed"]);
const slots = [1, 2];
const forms = reactive({
  1: { title: "获奖证书", file: null },
  2: { title: "获奖证书", file: null }
});
const busySlots = ref(new Set());
const error = ref("");
const success = ref("");
const deleteTarget = ref(null);
const previewTarget = ref(null);
const downloads = createBlobDownloadManager();
const certificateAccept = "application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp";

function certificateFor(slot) {
  return props.certificates.find((certificate) => Number(certificate.slot) === slot) || null;
}

function isSlotBusy(slot) {
  return busySlots.value.has(Number(slot));
}

function hasBusySlots() {
  return busySlots.value.size > 0;
}

function beginSlotWork(slot) {
  const next = new Set(busySlots.value);
  next.add(Number(slot));
  busySlots.value = next;
}

function endSlotWork(slot) {
  const next = new Set(busySlots.value);
  next.delete(Number(slot));
  busySlots.value = next;
}

watch(
  () => props.certificates,
  () => {
    for (const slot of slots) forms[slot].title = certificateFor(slot)?.title || "获奖证书";
  },
  { immediate: true, deep: true }
);

function chooseFile(slot, event) {
  error.value = "";
  const file = event.target.files?.[0] || null;
  const extension = file?.name.split(".").pop()?.toLowerCase();
  if (file && !["pdf", "png", "jpg", "jpeg", "webp"].includes(extension)) {
    forms[slot].file = null;
    event.target.value = "";
    error.value = "证书文件仅支持 PDF、PNG、JPG、JPEG 或 WEBP。";
    return;
  }
  forms[slot].file = file;
}

async function saveSlot(slot) {
  const current = certificateFor(slot);
  if (!forms[slot].title.trim()) {
    error.value = `请填写证书位置 ${slot} 的标题。`;
    return;
  }
  if (!current && !forms[slot].file) {
    error.value = `请为证书位置 ${slot} 选择文件。`;
    return;
  }
  beginSlotWork(slot);
  error.value = "";
  success.value = "";
  try {
    if (forms[slot].file) {
      const body = new FormData();
      body.append("title", forms[slot].title.trim());
      body.append("certificate", forms[slot].file);
      await api(`/api/admin/registrations/${props.registration.id}/certificates/${slot}`, { method: "POST", body });
      forms[slot].file = null;
      success.value = "";
    } else {
      await api(`/api/admin/certificates/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: forms[slot].title.trim() })
      });
      success.value = "";
    }
    emit("changed", { message: `证书位置 ${slot} 已保存。` });
  } catch (cause) {
    error.value = cause.message || `证书位置 ${slot} 保存失败，请稍后重试。`;
  } finally {
    endSlotWork(slot);
  }
}

async function changeStatus(certificate, status) {
  const slot = Number(certificate.slot);
  beginSlotWork(slot);
  error.value = "";
  success.value = "";
  try {
    await api("/api/admin/certificates/bulk-status", {
      method: "POST",
      body: JSON.stringify({ ids: [certificate.id], status })
    });
    success.value = "";
    emit("changed", { message: status === "published" ? "证书已发布。" : "证书已撤回为未发布。" });
  } catch (cause) {
    error.value = cause.message || "证书状态更新失败，请稍后重试。";
  } finally {
    endSlotWork(slot);
  }
}

async function download(certificate) {
  if (!certificate.downloadUrl || certificate.cleanedAt) return;
  error.value = "";
  try {
    const blob = await apiBlob(certificate.downloadUrl);
    downloads.save(blob, certificate.fileName || `${certificate.title || "证书"}`);
  } catch (cause) {
    error.value = cause.message || "证书下载失败，请稍后重试。";
  }
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  const certificate = deleteTarget.value;
  const slot = Number(certificate.slot);
  beginSlotWork(slot);
  error.value = "";
  success.value = "";
  try {
    await api(`/api/admin/certificates/${certificate.id}`, { method: "DELETE" });
    deleteTarget.value = null;
    success.value = "";
    emit("changed", { message: "证书已删除。" });
  } catch (cause) {
    error.value = cause.message || "证书删除失败，请稍后重试。";
  } finally {
    endSlotWork(slot);
  }
}

onBeforeUnmount(() => downloads.dispose());
</script>

<template>
  <section class="certificate-slot-editor">
    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="success" class="success-message">{{ success }}</p>
    <div class="certificate-slot-grid">
      <article v-for="slot in slots" :key="slot" class="certificate-slot-card">
        <div class="panel-title"><h4>证书位置 {{ slot }}</h4><em :class="certificateFor(slot)?.status || 'empty'">{{ certificateFor(slot) ? (certificateFor(slot).status === 'published' ? '已发布' : '未发布') : '尚未上传' }}</em></div>
        <label>证书标题<input v-model="forms[slot].title" :disabled="isSlotBusy(slot)" :aria-label="`证书位置 ${slot} 标题`"></label>
        <label>{{ certificateFor(slot) ? "替换文件" : "选择文件" }}
          <input :data-slot-file="slot" type="file" :accept="certificateAccept" :disabled="isSlotBusy(slot)" @change="chooseFile(slot, $event)">
        </label>
        <p class="hint">{{ forms[slot].file?.name || certificateFor(slot)?.fileName || "支持 PDF、PNG、JPG、WEBP，最大 10 MB" }}</p>
        <p v-if="certificateFor(slot)?.cleanedAt" class="message">原文件已清理，可替换；当前不可预览或下载。</p>
        <div class="form-actions certificate-slot-actions">
          <button type="button" class="primary" :data-action="`save-slot-${slot}`" :disabled="isSlotBusy(slot)" @click="saveSlot(slot)">
            {{ isSlotBusy(slot) ? "正在保存…" : certificateFor(slot) && forms[slot].file ? "替换文件" : certificateFor(slot) ? "保存标题" : "上传文件" }}
          </button>
          <template v-if="certificateFor(slot)">
            <button v-if="certificateFor(slot).previewUrl && !certificateFor(slot).cleanedAt" type="button" class="mini" :data-action="`preview-${certificateFor(slot).id}`" @click="previewTarget = certificateFor(slot)">预览</button>
            <button v-if="certificateFor(slot).downloadUrl && !certificateFor(slot).cleanedAt" type="button" class="mini" :data-action="`download-${certificateFor(slot).id}`" @click="download(certificateFor(slot))">下载</button>
            <button v-if="certificateFor(slot).status !== 'published'" type="button" class="mini" :disabled="isSlotBusy(slot)" @click="changeStatus(certificateFor(slot), 'published')">发布</button>
            <button v-else type="button" class="mini reject" :disabled="isSlotBusy(slot)" @click="changeStatus(certificateFor(slot), 'draft')">撤回</button>
            <button type="button" class="mini reject" :data-action="`request-delete-${certificateFor(slot).id}`" :disabled="isSlotBusy(slot)" @click="deleteTarget = certificateFor(slot)">删除</button>
          </template>
        </div>
      </article>
    </div>

    <div v-if="deleteTarget" class="dialog-backdrop" role="presentation">
      <section class="panel confirm-dialog" role="alertdialog" aria-modal="true" aria-label="删除证书确认">
        <h3>确认删除{{ deleteTarget.title }}？</h3>
        <p>删除后该位置会变为空白，文件也将无法恢复。</p>
        <div class="form-actions">
          <button type="button" class="reject" data-action="confirm-delete" :disabled="hasBusySlots()" @click="confirmDelete">确认删除</button>
          <button type="button" data-action="cancel-delete" :disabled="hasBusySlots()" @click="deleteTarget = null">暂不删除</button>
        </div>
      </section>
    </div>
    <FilePreviewDialog :file="previewTarget" @close="previewTarget = null" />
  </section>
</template>
