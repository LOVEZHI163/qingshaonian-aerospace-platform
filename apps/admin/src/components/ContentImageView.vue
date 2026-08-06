<script setup>
import { NodeViewWrapper, nodeViewProps } from "@tiptap/vue-3";
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps(nodeViewProps);
const editable = ref(props.editor.isEditable);

function syncEditable() {
  editable.value = props.editor.isEditable;
}

function edit() {
  if (!editable.value) return;
  props.extension.options.onEdit?.({
    node: props.node,
    position: props.getPos()
  });
}

function remove() {
  if (editable.value) props.deleteNode();
}

onMounted(() => {
  props.editor.on("transaction", syncEditable);
  props.editor.on("update", syncEditable);
});

onBeforeUnmount(() => {
  props.editor.off("transaction", syncEditable);
  props.editor.off("update", syncEditable);
});
</script>

<template>
  <NodeViewWrapper
    as="figure"
    :data-content-image="node.attrs.mediaId"
    :class="{ 'is-selected': selected }"
    contenteditable="false"
  >
    <img
      :src="`/api/admin/site-media/${encodeURIComponent(node.attrs.mediaId)}/preview`"
      :alt="node.attrs.alt || ''"
    >
    <figcaption v-if="node.attrs.caption">{{ node.attrs.caption }}</figcaption>
    <div v-if="editable" class="content-image-actions">
      <button type="button" data-action="edit-content-image" @click="edit">编辑图片</button>
      <button type="button" data-action="replace-content-image" @click="edit">替换图片</button>
      <button type="button" data-action="remove-content-image" @click="remove">删除图片</button>
    </div>
  </NodeViewWrapper>
</template>
