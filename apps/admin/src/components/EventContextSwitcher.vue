<script setup>
import { computed } from "vue";

const props = defineProps({
  events: { type: Array, default: () => [] },
  modelValue: { type: String, default: "" },
  includeArchived: { type: Boolean, default: false }
});
const emit = defineEmits(["update:modelValue"]);

const visibleEvents = computed(() => props.events.filter((row) => (
  row?.event?.id && (props.includeArchived || !row.event.archivedAt)
)));

function updateEvent(event) {
  const eventId = event.target.value;
  if (visibleEvents.value.some((row) => row.event.id === eventId)) emit("update:modelValue", eventId);
}
</script>

<template>
  <label class="event-context-switcher">
    当前赛事
    <select :value="modelValue" data-event-switcher @change="updateEvent">
      <option value="" disabled>请选择赛事</option>
      <option v-for="row in visibleEvents" :key="row.event.id" :value="row.event.id">{{ row.event.name }}</option>
    </select>
  </label>
</template>
