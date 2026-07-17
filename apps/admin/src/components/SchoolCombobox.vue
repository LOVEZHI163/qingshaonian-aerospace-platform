<script setup>
import { onBeforeUnmount, ref, watch } from "vue";

import { api } from "../lib/api.js";

const props = defineProps({ modelValue: { type: String, default: "" } });
const emit = defineEmits(["update:modelValue"]);
const options = ref([]);
let timer;
let controller = null;
let requestId = 0;

watch(() => props.modelValue, (value) => {
  clearTimeout(timer);
  controller?.abort();
  controller = null;
  const currentRequestId = ++requestId;
  const query = String(value || "").trim();
  if (!query) { options.value = []; return; }
  timer = setTimeout(async () => {
    const activeController = new AbortController();
    controller = activeController;
    try {
      const payload = await api(`/api/schools?q=${encodeURIComponent(query)}`, { signal: activeController.signal });
      if (currentRequestId === requestId) options.value = payload.rows || [];
    } catch (error) {
      if (error?.name !== "AbortError" && currentRequestId === requestId) options.value = [];
    } finally {
      if (controller === activeController) controller = null;
    }
  }, 300);
});
onBeforeUnmount(() => { clearTimeout(timer); controller?.abort(); controller = null; requestId += 1; });
</script>

<template>
  <input
    :value="modelValue"
    list="school-options"
    placeholder="输入或选择学校"
    required
    @input="emit('update:modelValue', $event.target.value)"
  />
  <datalist id="school-options"><option v-for="school in options" :key="school" :value="school" /></datalist>
</template>
