<script setup>
import { computed } from "vue";
import { contentPublicationState } from "../lib/content-publication-state.js";
import { contentTypeLabel } from "../lib/content-type-labels.js";

const props = defineProps({
  content: { type: Object, required: true },
  event: { type: Object, default: null },
  profile: { type: Object, default: null },
  busy: { type: Boolean, default: false }
});
const emit = defineEmits(["back", "preview", "publish", "navigate"]);
const state = computed(() => contentPublicationState(props));
const statusLabels = { draft: "草稿", scheduled: "定时发布", published: "已发布", offline: "已下线" };

function publishTime(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { hour12: false })
    : "尚未设置";
}
</script>

<template>
  <section class="content-publication-review" data-content-publication-review>
    <div class="panel-title">
      <div><h4>发布检查</h4><p>确认内容、赛事业务状态与官网可见性后再发布。</p></div>
      <strong :class="{ 'message': state.blockingIssues.length, 'success-message': !state.blockingIssues.length }">{{ state.resultLabel }}</strong>
    </div>
    <dl class="event-facts">
      <div><dt>标题</dt><dd>{{ content.title || "未填写" }}</dd></div>
      <div><dt>类型</dt><dd>{{ contentTypeLabel(content.type) }}</dd></div>
      <div><dt>归属赛事</dt><dd>{{ event?.name || (content.eventId ? content.eventId : "平台通用") }}</dd></div>
      <div><dt>公开地址</dt><dd>{{ content.slug || "未填写" }}</dd></div>
      <div><dt>内容状态</dt><dd>{{ statusLabels[content.status] || content.status || "草稿" }}</dd></div>
      <div data-review-fact="body"><dt>正文准备</dt><dd>{{ state.bodyReadinessLabel }}</dd></div>
      <div data-review-fact="media"><dt>媒体准备</dt><dd>{{ state.mediaReadinessLabel }}</dd></div>
      <div data-review-fact="placement"><dt>展示位置</dt><dd>{{ state.placementLabel }}</dd></div>
      <div data-review-fact="publication"><dt>发布意图</dt><dd>{{ state.publicationModeLabel }}<span v-if="state.intendedPublishAt"> · {{ publishTime(state.intendedPublishAt) }}</span></dd></div>
      <div data-review-fact="event-status"><dt>赛事业务状态</dt><dd>{{ state.eventStatusLabel }}</dd></div>
      <div data-review-fact="website-status"><dt>赛事官网状态</dt><dd>{{ state.websiteStatusLabel }}</dd></div>
      <div data-review-public-outcome><dt>实际公开结果</dt><dd>{{ state.publicOutcome }}</dd></div>
      <div data-review-public-entry><dt>实际公开入口</dt><dd>{{ state.publicEntry }}</dd></div>
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
      <button type="button" class="dark" data-action="confirm-review-publish" :disabled="state.blockingIssues.length > 0 || busy" @click="emit('publish')">{{ content.status === "scheduled" ? "确认定时发布" : "确认发布" }}</button>
    </div>
  </section>
</template>
