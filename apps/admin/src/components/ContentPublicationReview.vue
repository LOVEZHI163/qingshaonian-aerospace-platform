<script setup>
import { computed } from "vue";
import { contentPublicationState } from "../lib/content-publication-state.js";

const props = defineProps({
  content: { type: Object, required: true },
  event: { type: Object, default: null },
  profile: { type: Object, default: null },
  busy: { type: Boolean, default: false }
});
const emit = defineEmits(["back", "preview", "publish", "navigate"]);
const state = computed(() => contentPublicationState(props));
const typeLabels = { announcement: "公告", news: "新闻", work: "作品", recap: "回顾", guide: "指南" };
const statusLabels = { draft: "草稿", scheduled: "定时发布", published: "已发布", offline: "已下线" };
</script>

<template>
  <section class="content-publication-review" data-content-publication-review>
    <div class="panel-title">
      <div><h4>发布检查</h4><p>确认内容、赛事业务状态与官网可见性后再发布。</p></div>
      <strong :class="{ 'message': state.blockingIssues.length, 'success-message': !state.blockingIssues.length }">{{ state.resultLabel }}</strong>
    </div>
    <dl class="event-facts">
      <div><dt>标题</dt><dd>{{ content.title || "未填写" }}</dd></div>
      <div><dt>类型</dt><dd>{{ typeLabels[content.type] || content.type || "未填写" }}</dd></div>
      <div><dt>归属赛事</dt><dd>{{ event?.name || (content.eventId ? content.eventId : "平台通用") }}</dd></div>
      <div><dt>公开地址</dt><dd>{{ content.slug || "未填写" }}</dd></div>
      <div><dt>内容状态</dt><dd>{{ statusLabels[content.status] || content.status || "草稿" }}</dd></div>
    </dl>
    <div v-if="state.blockingIssues.length" class="message" role="alert" data-review-blocking-issues>
      <p v-for="item in state.blockingIssues" :key="item.code">{{ item.message }}</p>
      <button v-if="state.blockingIssues.some((item) => item.code === 'event-draft')" type="button" data-action="go-event-settings" @click="emit('navigate', 'events')">去赛事设置</button>
    </div>
    <div v-if="state.warnings.length" role="status" data-review-warnings>
      <p v-for="item in state.warnings" :key="item.code">{{ item.message }}</p>
    </div>
    <div class="form-actions">
      <button type="button" data-action="back-to-editor" :disabled="busy" @click="emit('back')">返回编辑</button>
      <button type="button" data-action="review-preview" :disabled="busy" @click="emit('preview')">预览当前草稿</button>
      <button type="button" class="dark" data-action="confirm-review-publish" :disabled="state.blockingIssues.length > 0 || busy" @click="emit('publish')">确认发布</button>
    </div>
  </section>
</template>
