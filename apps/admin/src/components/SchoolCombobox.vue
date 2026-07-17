<script setup>
import { onBeforeUnmount, ref, watch } from "vue";

import { api } from "../lib/api.js";

const props = defineProps({ modelValue: { type: String, default: "" } });
const emit = defineEmits(["update:modelValue"]);
const options = ref([]);
let timer;

watch(() => props.modelValue, (value) => {
  clearTimeout(timer);
  const query = String(value || "").trim();
  if (!query) { options.value = []; return; }
  timer = setTimeout(async () => {
    try { options.value = (await api(`/api/schools?q=${encodeURIComponent(query)}`)).rows || []; } catch { options.value = []; }
  }, 300);
});
onBeforeUnmount(() => clearTimeout(timer));
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
