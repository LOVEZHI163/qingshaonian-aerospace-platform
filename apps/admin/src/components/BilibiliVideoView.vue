<script setup>
import { NodeViewWrapper, nodeViewProps } from "@tiptap/vue-3";
import { onBeforeUnmount, onMounted, ref } from "vue";

import { bilibiliPlayerUrl, bilibiliWatchUrl } from "../lib/bilibili-video.js";

const props = defineProps(nodeViewProps);
const editable = ref(props.editor.isEditable);

function syncEditable() {
  editable.value = props.editor.isEditable;
}

function edit() {
  if (editable.value) {
    props.extension.options.onEdit?.({ node: props.node, position: props.getPos() });
  }
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
    class="content-bilibili-video"
    :data-bilibili-video="node.attrs.bvid"
    :class="{ 'is-selected': selected }"
    contenteditable="false"
  >
    <div class="content-bilibili-frame">
      <iframe
        :src="bilibiliPlayerUrl(node.attrs.bvid)"
        :title="`B站视频预览：${node.attrs.title}`"
        loading="lazy"
        allow="fullscreen"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
      />
    </div>
    <figcaption>{{ node.attrs.title }}</figcaption>
    <a :href="bilibiliWatchUrl(node.attrs.bvid)" target="_blank" rel="noopener noreferrer">在哔哩哔哩打开</a>
    <div v-if="editable" class="content-bilibili-actions">
      <button type="button" data-action="edit-bilibili-video" @click="edit">编辑视频</button>
      <button type="button" data-action="remove-bilibili-video" @click="remove">删除视频</button>
    </div>
  </NodeViewWrapper>
</template>
