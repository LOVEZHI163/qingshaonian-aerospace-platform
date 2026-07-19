<script setup>
import { ref } from "vue";
import { api } from "../lib/api.js";

const props = defineProps({ purpose: { type: String, required: true }, accept: { type: String, required: true }, label: { type: String, default: "上传媒体" }, disabled: Boolean });
const emit = defineEmits(["uploaded", "error"]);
const busy = ref(false);

async function upload(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  busy.value = true;
  try {
    const body = new FormData(); body.append("purpose", props.purpose); body.append("file", file);
    const payload = await api("/api/admin/site-media", { method: "POST", body });
    emit("uploaded", payload.row);
  } catch (error) { emit("error", error); }
  finally { busy.value = false; }
}
</script>

<template>
  <label class="file-action">{{ busy ? "上传中…" : label }}<input type="file" :accept="accept" :disabled="disabled || busy" data-action="upload-content-media" @change="upload"></label>
</template>
