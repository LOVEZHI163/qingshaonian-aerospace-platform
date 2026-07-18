<script setup>
import { computed, onMounted, reactive, ref } from "vue";

import { ApiError, api } from "../lib/api.js";
import { loadAdminRegistrations } from "../lib/admin-registrations.js";
import ResourceCleanupPanel from "../components/ResourceCleanupPanel.vue";

const emit = defineEmits(["event-changed"]);
const GROUPS = ["小学低段", "小学高段", "中学组", "职高/高中组"];
const EVENT_FIELDS = ["name", "theme", "dateLabel", "venue", "contact", "registrationStartAt", "registrationEndAt", "registrationMode"];
const PROJECT_FIELDS = ["name", "type", "category", "enabled", "instructorRequired", "displayOrder", "allowedGroups"];

const events = ref([]);
const projects = ref([]);
const registrations = ref([]);
const selectedId = ref("");
const creating = ref(false);
const loading = ref(true);
const saving = ref(false);
const pageError = ref("");
const success = ref("");
const fieldErrors = reactive({});
const eventForm = reactive(emptyEvent());
const projectForm = reactive(emptyProject());

const selectedEvent = computed(() => events.value.find((row) => row.id === selectedId.value) || null);
const selectedProjects = computed(() => projects.value
  .filter((row) => row.eventId === selectedId.value)
  .sort((left, right) => left.displayOrder - right.displayOrder));

function emptyEvent() {
  return {
    name: "",
    theme: "",
    dateLabel: "",
    venue: "",
    contact: "",
    registrationStartAt: "",
    registrationEndAt: "",
    registrationMode: "automatic"
  };
}

function emptyProject() {
  return {
    id: "",
    name: "",
    type: "individual",
    category: "",
    enabled: true,
    instructorRequired: false,
    displayOrder: 0,
    allowedGroups: [...GROUPS]
  };
}

function toLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function selectEvent(id) {
  creating.value = false;
  selectedId.value = id;
  const row = events.value.find((item) => item.id === id);
  if (!row) return;
  Object.assign(eventForm, row, {
    registrationStartAt: toLocalDateTime(row.registrationStartAt),
    registrationEndAt: toLocalDateTime(row.registrationEndAt)
  });
  Object.assign(projectForm, emptyProject());
}

function registrationCount(projectId) {
  return registrations.value.filter((row) => row.projectId === projectId).length;
}

async function loadEvents({ preserveSelection = true } = {}) {
  loading.value = true;
  pageError.value = "";
  try {
    const [eventPayload, registrationPayload] = await Promise.all([
      api("/api/admin/events"),
      loadAdminRegistrations()
    ]);
    events.value = eventPayload.rows || [];
    projects.value = eventPayload.projects || [];
    registrations.value = registrationPayload;
    const nextId = preserveSelection && events.value.some((row) => row.id === selectedId.value)
      ? selectedId.value
      : events.value.find((row) => row.isCurrent)?.id || events.value[0]?.id || "";
    if (nextId) selectEvent(nextId);
  } catch (error) {
    pageError.value = error.message || "赛事加载失败";
  } finally {
    loading.value = false;
  }
}

function eventPayload() {
  return Object.fromEntries(EVENT_FIELDS.map((field) => [field, ["registrationStartAt", "registrationEndAt"].includes(field)
    ? toIsoDateTime(eventForm[field])
    : eventForm[field]]));
}

function validateEvent() {
  Object.keys(fieldErrors).forEach((key) => delete fieldErrors[key]);
  for (const field of ["name", "theme", "dateLabel", "venue", "contact", "registrationStartAt", "registrationEndAt"]) {
    if (!String(eventForm[field] || "").trim()) fieldErrors[field] = "此项不能为空";
  }
  if (eventForm.registrationStartAt && eventForm.registrationEndAt
    && new Date(eventForm.registrationStartAt) >= new Date(eventForm.registrationEndAt)) {
    fieldErrors.registrationEndAt = "截止时间必须晚于开始时间";
  }
  return Object.keys(fieldErrors).length === 0;
}

async function perform(action, successText, { changed = true } = {}) {
  if (saving.value) return;
  saving.value = true;
  pageError.value = "";
  success.value = "";
  try {
    await action();
    await loadEvents();
    success.value = successText;
    if (changed) emit("event-changed");
  } catch (error) {
    pageError.value = error instanceof ApiError && error.status === 409
      ? `${error.message}，请改用停用操作。`
      : error.message || "操作失败";
  } finally {
    saving.value = false;
  }
}

async function saveEvent() {
  if (!validateEvent()) return;
  await perform(
    () => api(`/api/admin/events/${selectedId.value}`, { method: "PATCH", body: JSON.stringify(eventPayload()) }),
    "赛事资料已保存"
  );
}

function startCreateEvent() {
  creating.value = true;
  selectedId.value = "";
  Object.assign(eventForm, emptyEvent());
  success.value = "";
  pageError.value = "";
}

async function createDraft() {
  if (!validateEvent()) return;
  let createdId = "";
  await perform(async () => {
    const payload = await api("/api/admin/events", { method: "POST", body: JSON.stringify(eventPayload()) });
    createdId = payload.row.id;
    selectedId.value = createdId;
  }, "赛事草稿已创建");
  if (createdId) selectEvent(createdId);
}

async function updateMode(mode) {
  await perform(
    () => api(`/api/admin/events/${selectedId.value}`, { method: "PATCH", body: JSON.stringify({ registrationMode: mode }) }),
    "报名控制已更新"
  );
}

async function copySelected() {
  const name = window.prompt("请输入复制后的赛事名称", `${selectedEvent.value?.name || "赛事"}（副本）`)?.trim();
  if (!name) return;
  await perform(
    () => api(`/api/admin/events/${selectedId.value}/copy`, { method: "POST", body: JSON.stringify({ name }) }),
    "赛事已复制"
  );
}

async function setCurrent() {
  await perform(() => api(`/api/admin/events/${selectedId.value}/current`, { method: "POST" }), "已设为当前赛事");
}

async function archiveSelected() {
  if (!window.confirm(`确认归档“${selectedEvent.value?.name}”？归档后将不再作为当前赛事。`)) return;
  if (!window.confirm("请再次确认：归档会关闭该届赛事的管理入口，确定继续吗？")) return;
  await perform(() => api(`/api/admin/events/${selectedId.value}/archive`, { method: "POST" }), "赛事已归档");
}

async function eventDeleted() {
  selectedId.value = "";
  await loadEvents({ preserveSelection: false });
  success.value = "历史赛事已彻底删除";
  emit("event-changed");
}

function editProject(row) {
  Object.assign(projectForm, emptyProject(), row, { allowedGroups: [...(row.allowedGroups || [])] });
}

function projectPayload() {
  const raw = { ...projectForm, displayOrder: Number(projectForm.displayOrder), allowedGroups: [...projectForm.allowedGroups] };
  return Object.fromEntries(PROJECT_FIELDS.map((field) => [field, raw[field]]));
}

async function saveProject() {
  if (!projectForm.name.trim() || !projectForm.category.trim() || projectForm.allowedGroups.length === 0) {
    pageError.value = "请填写赛项名称、类别并至少选择一个组别";
    return;
  }
  const editing = Boolean(projectForm.id);
  await perform(
    () => api(editing ? `/api/admin/projects/${projectForm.id}` : `/api/admin/events/${selectedId.value}/projects`, {
      method: editing ? "PATCH" : "POST",
      body: JSON.stringify(projectPayload())
    }),
    editing ? "赛项已更新" : "赛项已新增"
  );
  Object.assign(projectForm, emptyProject());
}

async function disableProject(row) {
  await perform(
    () => api(`/api/admin/projects/${row.id}`, { method: "PATCH", body: JSON.stringify({ ...Object.fromEntries(PROJECT_FIELDS.map((field) => [field, row[field]])), enabled: false }) }),
    "赛项已停用"
  );
}

async function deleteProject(row) {
  if (!window.confirm(`确认删除赛项“${row.name}”？`)) return;
  await perform(() => api(`/api/admin/projects/${row.id}`, { method: "DELETE" }), "赛项已删除");
}

onMounted(() => loadEvents({ preserveSelection: false }));
</script>

<template>
  <section class="event-management">
    <div class="page-title-row">
      <div><h2>赛事管理</h2><p>管理多届赛事、报名开放状态、赛项及适用组别。</p></div>
      <button type="button" class="dark" @click="startCreateEvent">新建赛事草稿</button>
    </div>
    <p v-if="pageError" class="message danger-message">{{ pageError }}</p>
    <p v-if="success" class="message success-message">{{ success }}</p>
    <p v-if="loading" class="panel">正在加载赛事…</p>
    <p v-else-if="events.length === 0 && !creating" class="panel">暂无赛事，请先新建草稿。</p>

    <div v-else class="event-layout">
      <section class="panel event-list-panel">
        <h3>赛事列表</h3>
        <button
          v-for="row in events"
          :key="row.id"
          type="button"
          class="event-list-item"
          :class="{ selected: row.id === selectedId }"
          @click="selectEvent(row.id)"
        >
          <strong>{{ row.name }}</strong>
          <span>{{ row.isCurrent ? "当前赛事" : row.status }} · {{ row.registrationMode }}</span>
          <small>{{ toLocalDateTime(row.registrationStartAt) }} 至 {{ toLocalDateTime(row.registrationEndAt) }}</small>
        </button>
      </section>

      <div class="event-editor-stack">
        <form class="panel event-form" @submit.prevent="selectedId ? saveEvent() : createDraft()">
          <div class="panel-title"><h3>{{ selectedId ? "编辑赛事" : "新建赛事" }}</h3><span v-if="selectedEvent?.isCurrent">当前赛事</span></div>
          <div class="two">
            <label>赛事名称<input v-model="eventForm.name" /><small v-if="fieldErrors.name">{{ fieldErrors.name }}</small></label>
            <label>主题<input v-model="eventForm.theme" /><small v-if="fieldErrors.theme">{{ fieldErrors.theme }}</small></label>
          </div>
          <div class="two">
            <label>比赛日期说明<input v-model="eventForm.dateLabel" /><small v-if="fieldErrors.dateLabel">{{ fieldErrors.dateLabel }}</small></label>
            <label>比赛地点<input v-model="eventForm.venue" /><small v-if="fieldErrors.venue">{{ fieldErrors.venue }}</small></label>
          </div>
          <label>联系方式<input v-model="eventForm.contact" /><small v-if="fieldErrors.contact">{{ fieldErrors.contact }}</small></label>
          <div class="two">
            <label>报名开始<input v-model="eventForm.registrationStartAt" type="datetime-local" /><small v-if="fieldErrors.registrationStartAt">{{ fieldErrors.registrationStartAt }}</small></label>
            <label>报名截止<input v-model="eventForm.registrationEndAt" type="datetime-local" /><small v-if="fieldErrors.registrationEndAt">{{ fieldErrors.registrationEndAt }}</small></label>
          </div>
          <div v-if="selectedId" class="registration-modes">
            <button type="button" data-mode="automatic" :disabled="saving" @click="updateMode('automatic')">自动</button>
            <button type="button" data-mode="force_open" :disabled="saving" @click="updateMode('force_open')">临时开放</button>
            <button type="button" data-mode="force_closed" :disabled="saving" @click="updateMode('force_closed')">临时关闭</button>
          </div>
          <div class="form-actions">
            <button class="primary" :disabled="saving">{{ selectedId ? "保存赛事" : "创建草稿" }}</button>
            <button v-if="selectedId" type="button" data-action="copy-event" :disabled="saving" @click="copySelected">复制</button>
            <button v-if="selectedId && !selectedEvent?.isCurrent" type="button" :disabled="saving" @click="setCurrent">设为当前</button>
            <button v-if="selectedId && selectedEvent?.status !== 'archived'" type="button" class="reject" :disabled="saving" @click="archiveSelected">归档</button>
          </div>
        </form>

        <section v-if="selectedId" id="projects" class="panel project-panel">
          <div class="panel-title"><h3>赛项与组别</h3><span>{{ selectedProjects.length }} 个赛项</span></div>
          <div class="project-list">
            <article v-for="row in selectedProjects" :key="row.id">
              <div><strong>{{ row.name }}</strong><span>{{ row.category }} · {{ row.type === 'team' ? '团体赛' : '个人赛' }}</span><small>{{ row.allowedGroups.join('、') }}</small></div>
              <div class="project-actions">
                <button type="button" class="mini" @click="editProject(row)">编辑</button>
                <button v-if="registrationCount(row.id)" type="button" class="mini reject" data-action="disable-project" :disabled="!row.enabled || saving" @click="disableProject(row)">停用</button>
                <button v-else type="button" class="mini reject" data-action="delete-project" :disabled="saving" @click="deleteProject(row)">删除</button>
              </div>
            </article>
            <p v-if="selectedProjects.length === 0">暂无赛项。</p>
          </div>
          <form class="project-form" @submit.prevent="saveProject">
            <h4>{{ projectForm.id ? "编辑赛项" : "新增赛项" }}</h4>
            <div class="two"><label>赛项名称<input v-model="projectForm.name" /></label><label>类别<input v-model="projectForm.category" /></label></div>
            <div class="two">
              <label>类型<select v-model="projectForm.type"><option value="individual">个人赛</option><option value="team">团体赛</option></select></label>
              <label>显示顺序<input v-model.number="projectForm.displayOrder" type="number" min="0" /></label>
            </div>
            <div class="checkbox-row">
              <label v-for="group in GROUPS" :key="group"><input v-model="projectForm.allowedGroups" type="checkbox" :value="group" />{{ group }}</label>
            </div>
            <div class="checkbox-row"><label><input v-model="projectForm.enabled" type="checkbox" />启用</label><label><input v-model="projectForm.instructorRequired" type="checkbox" />必须填写指导老师</label></div>
            <div class="form-actions"><button class="primary" :disabled="saving">{{ projectForm.id ? "保存赛项" : "新增赛项" }}</button><button v-if="projectForm.id" type="button" @click="Object.assign(projectForm, emptyProject())">取消编辑</button></div>
          </form>
        </section>
        <ResourceCleanupPanel
          v-if="selectedEvent"
          :event="selectedEvent"
          @deleted="eventDeleted"
        />
      </div>
    </div>
  </section>
</template>
