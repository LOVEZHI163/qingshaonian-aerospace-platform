<script setup>
import { onMounted, ref } from "vue";

import { api } from "../lib/api.js";
import { useSession } from "../state/session.js";

const props = defineProps({ eventId: { type: String, default: "" } });
const emit = defineEmits(["error"]);
const session = useSession();
const rows = ref([]);
const loading = ref(true);
const statusText = { pending: "待审核", approved: "已通过", rejected: "已驳回", cancelled: "已取消" };

onMounted(async () => {
  try {
    if (session.user.value?.type === "organization") {
      emit("error", "请在赛事工作台中查看组织报名记录。");
    } else if (!props.eventId) {
      emit("error", "请先从赛事中心选择赛事后查看当前报名");
    } else {
      rows.value = (await api(`/api/me/events/${encodeURIComponent(props.eventId)}/registrations`)).rows || [];
    }
  } catch (error) {
    emit("error", error.message);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="panel registration-records-page" data-testid="registration-records-page">
    <div class="panel-title"><h3>报名记录</h3><span>{{ rows.length }} 条</span></div>
    <p class="hint">仅显示当前赛事中本人的报名记录。</p>
    <p v-if="loading" class="hint">正在加载报名记录…</p>
    <div v-else class="table-wrap"><table class="registration-record-table"><thead><tr><th>编号</th><th>姓名</th><th>学校/年级</th><th>组织</th><th>赛项</th><th>指导老师</th><th>审核状态</th><th>成绩/奖项</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.id"><td>{{ row.id }}</td><td>{{ row.athlete?.name }}</td><td>{{ row.athlete?.school }}<br /><span>{{ row.athlete?.grade }}</span></td><td>{{ row.organization || row.organizationName || "个人报名" }}</td><td>{{ row.projectName }}<br /><span>{{ row.projectType === "team" ? "团体赛" : "个人赛" }}</span></td><td>{{ row.instructor || "-" }}</td><td><em :class="row.status">{{ statusText[row.status] || row.status }}</em><p v-if="row.rejectReason" class="hint">驳回原因：{{ row.rejectReason }}</p></td><td>{{ row.awardName || "未录入" }}<br /><span>名次 {{ row.rank || "-" }} · 成绩 {{ row.score || "-" }}</span></td></tr>
    </tbody></table><p v-if="rows.length === 0" class="hint empty-state">暂无报名记录。</p></div>
  </section>
</template>
