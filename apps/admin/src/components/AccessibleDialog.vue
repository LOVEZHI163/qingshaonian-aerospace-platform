<script setup>
import { nextTick, onBeforeUnmount, ref, useAttrs, watch } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  open: { type: Boolean, default: false },
  as: { type: String, default: "section" },
  labelledBy: { type: String, required: true },
  initialFocus: { type: String, default: "" }
});
const emit = defineEmits(["close"]);
const attrs = useAttrs();
const dialog = ref(null);
let returnFocus = null;

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function close() {
  emit("close");
}

function handleKeydown(event) {
  if (!props.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...(dialog.value?.querySelectorAll(focusableSelector) || [])];
  if (!focusable.length) {
    event.preventDefault();
    dialog.value?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  const active = document.activeElement;
  if (!dialog.value?.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if ((!event.shiftKey && active === last) || (event.shiftKey && active === first)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

watch(() => props.open, async (open, previous) => {
  if (open && !previous) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener("keydown", handleKeydown);
    await nextTick();
    const target = props.initialFocus ? dialog.value?.querySelector(props.initialFocus) : null;
    (target || dialog.value?.querySelector(focusableSelector) || dialog.value)?.focus();
    return;
  }
  if (!open && previous) {
    document.removeEventListener("keydown", handleKeydown);
    await nextTick();
    if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus();
    returnFocus = null;
  }
}, { flush: "post" });

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleKeydown);
  if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus();
});
</script>

<template>
  <div v-if="open" class="dialog-backdrop" role="presentation" @click.self="close">
    <component
      :is="as"
      ref="dialog"
      v-bind="attrs"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="labelledBy"
      tabindex="-1"
    ><slot /></component>
  </div>
</template>
