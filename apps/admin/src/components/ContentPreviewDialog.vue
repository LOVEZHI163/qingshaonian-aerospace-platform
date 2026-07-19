<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({ open: Boolean, title: { type: String, default: "内容预览" }, html: { type: String, default: "" } });
const emit = defineEmits(["close"]);
const closeButton = ref(null);
let returnFocus = null;

function close() { emit("close"); }
function keydown(event) { if (event.key === "Escape") close(); }
watch(() => props.open, async (open) => {
  if (open) {
    returnFocus = document.activeElement;
    document.addEventListener("keydown", keydown);
    await nextTick(); closeButton.value?.focus();
  } else {
    document.removeEventListener("keydown", keydown);
    returnFocus?.focus?.();
  }
});
onBeforeUnmount(() => document.removeEventListener("keydown", keydown));
</script>

<template>
  <div v-if="open" class="dialog-backdrop" @click.self="close">
    <section class="panel content-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="content-preview-title">
      <div class="panel-title"><h3 id="content-preview-title">{{ title }}</h3><button ref="closeButton" type="button" aria-label="关闭预览" @click="close">关闭</button></div>
      <article class="content-preview-body" data-preview-body v-html="html"></article>
    </section>
  </div>
</template>
