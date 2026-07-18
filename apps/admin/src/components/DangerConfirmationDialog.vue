<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: "确认危险操作" },
  message: { type: String, default: "" },
  expectedName: { type: String, required: true },
  busy: { type: Boolean, default: false }
});
const emit = defineEmits(["cancel", "confirm"]);
const confirmName = ref("");
const valid = computed(() => confirmName.value === props.expectedName);

watch(() => props.open, (open) => {
  if (open) confirmName.value = "";
});

function submit() {
  if (!valid.value || props.busy) return;
  emit("confirm", confirmName.value);
}
</script>

<template>
  <div v-if="open" class="dialog-backdrop" @click.self="emit('cancel')">
    <form class="panel danger-confirmation-dialog" @submit.prevent="submit">
      <h3>{{ title }}</h3>
      <p class="danger-message">{{ message }}</p>
      <p>请输入完整名称 <strong>{{ expectedName }}</strong> 以确认：</p>
      <input v-model="confirmName" data-testid="danger-confirm-name" autocomplete="off" />
      <div class="form-actions">
        <button type="button" class="reject" data-action="confirm-danger" :disabled="!valid || busy" @click="submit">确认执行</button>
        <button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
      </div>
    </form>
  </div>
</template>
