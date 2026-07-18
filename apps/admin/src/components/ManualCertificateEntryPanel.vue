<script setup>
import { computed, onMounted, reactive, ref } from "vue";

import { loadAdminRegistrations } from "../lib/admin-registrations.js";
import { api } from "../lib/api.js";
import CertificateSlotEditor from "./CertificateSlotEditor.vue";

const props = defineProps({
  events: { type: Array, default: () => [] },
  initialEventId: { type: String, default: "" },
  initialRegistrationId: { type: String, default: "" }
});

const emit = defineEmits(["changed"]);

const initialEvent = props.events.find((event) => event.id === props.initialEventId)
  || props.events.find((event) => event.isCurrent)
  || props.events[0];
const eventId = ref(initialEvent?.id || "");
const athleteName = ref("");
const searchRows = ref([]);
const selectedRegistrationId = ref("");
const selectedCertificates = ref([]);
const searchLoading = ref(false);
const certificateLoading = ref(false);
const resultLoading = ref(false);
const searchAttempted = ref(false);
const error = ref("");
const success = ref("");
const result = reactive({ awardName: "", rank: "", score: "" });
let searchGeneration = 0;
let certificateGeneration = 0;
let resultGeneration = 0;

const selectedRegistration = computed(() => searchRows.value
  .find((row) => row.id === selectedRegistrationId.value) || null);

function clearSelection() {
  resultGeneration += 1;
  resultLoading.value = false;
  selectedRegistrationId.value = "";
  selectedCertificates.value = [];
  Object.assign(result, { awardName: "", rank: "", score: "" });
}

function changeEvent() {
  searchGeneration += 1;
  certificateGeneration += 1;
  athleteName.value = "";
  searchRows.value = [];
  searchAttempted.value = false;
  searchLoading.value = false;
  certificateLoading.value = false;
  error.value = "";
  success.value = "";
  clearSelection();
}

async function searchByName() {
  if (!eventId.value) {
    error.value = "请先选择赛事后再查询。";
    return;
  }
  const name = athleteName.value.trim();
  if (!name) {
    error.value = "请输入学生姓名后再查询。";
    return;
  }

  const generation = ++searchGeneration;
  searchLoading.value = true;
  searchAttempted.value = true;
  error.value = "";
  success.value = "";
  try {
    const rows = await loadAdminRegistrations({
      eventId: eventId.value,
      status: "approved",
      athleteName: name
    });
    if (generation !== searchGeneration) return;
    searchRows.value = rows;
    certificateGeneration += 1;
    clearSelection();
  } catch (cause) {
    if (generation === searchGeneration) {
      searchRows.value = [];
      clearSelection();
      error.value = cause.message || "学生报名查询失败，请稍后重试。";
    }
  } finally {
    if (generation === searchGeneration) searchLoading.value = false;
  }
}

function certificateListPath(registrationId) {
  const params = new URLSearchParams({
    registrationId,
    sort: "uploadedAt",
    direction: "desc",
    page: "1",
    pageSize: "2"
  });
  return `/api/admin/certificates?${params}`;
}

async function loadSelectedCertificates(registrationId) {
  const generation = ++certificateGeneration;
  certificateLoading.value = true;
  try {
    const payload = await api(certificateListPath(registrationId));
    if (generation !== certificateGeneration || selectedRegistrationId.value !== registrationId) return false;
    selectedCertificates.value = Array.isArray(payload?.rows) ? payload.rows : [];
    return true;
  } catch (cause) {
    if (generation !== certificateGeneration || selectedRegistrationId.value !== registrationId) return false;
    selectedCertificates.value = [];
    error.value = cause.message || "所选报名的证书加载失败，请稍后重试。";
    return false;
  } finally {
    if (generation === certificateGeneration) certificateLoading.value = false;
  }
}

async function selectRegistration(row) {
  resultGeneration += 1;
  resultLoading.value = false;
  selectedRegistrationId.value = row.id;
  selectedCertificates.value = [];
  error.value = "";
  success.value = "";
  Object.assign(result, {
    awardName: row.awardName || "",
    rank: row.rank || "",
    score: row.score || ""
  });
  await loadSelectedCertificates(row.id);
}

async function openDirectRegistration() {
  if (!props.initialRegistrationId || !eventId.value) return;
  const generation = ++searchGeneration;
  searchLoading.value = true;
  error.value = "";
  try {
    const rows = await loadAdminRegistrations({ eventId: eventId.value, q: props.initialRegistrationId });
    if (generation !== searchGeneration) return;
    const row = rows.find((registration) => registration.id === props.initialRegistrationId);
    if (!row) {
      error.value = "未找到指定的报名记录。";
      return;
    }
    if (row.status !== "approved") {
      error.value = "报名审核通过后才能录入证书。";
      return;
    }
    searchRows.value = [row];
    await selectRegistration(row);
  } catch (cause) {
    if (generation === searchGeneration) {
      error.value = cause.message || "报名记录加载失败，请稍后重试。";
    }
  } finally {
    if (generation === searchGeneration) searchLoading.value = false;
  }
}

async function saveResult() {
  const registration = selectedRegistration.value;
  if (!registration) return;
  const registrationId = registration.id;
  const eventIdSnapshot = eventId.value;
  const generation = ++resultGeneration;
  resultLoading.value = true;
  error.value = "";
  success.value = "";
  try {
    const payload = await api(`/api/admin/registrations/${registrationId}/result`, {
      method: "POST",
      body: JSON.stringify({
        awardName: result.awardName,
        rank: result.rank,
        score: result.score
      })
    });
    if (generation !== resultGeneration
      || selectedRegistrationId.value !== registrationId
      || eventId.value !== eventIdSnapshot) return;
    const saved = payload?.row || { ...registration, ...result };
    const index = searchRows.value.findIndex((row) => row.id === registrationId);
    if (index >= 0) searchRows.value.splice(index, 1, saved);
    success.value = "成绩已保存。";
    emit("changed", { message: "成绩已保存。" });
  } catch (cause) {
    if (generation === resultGeneration
      && selectedRegistrationId.value === registrationId
      && eventId.value === eventIdSnapshot) {
      error.value = cause.message || "成绩保存失败，请稍后重试。";
    }
  } finally {
    if (generation === resultGeneration) resultLoading.value = false;
  }
}

function eventNameFor(row) {
  return props.events.find((event) => event.id === row.eventId)?.name
    || row.eventName
    || row.eventId
    || "未知赛事";
}

async function afterCertificateChanged(change) {
  const registrationId = selectedRegistrationId.value;
  if (!registrationId) return;
  await loadSelectedCertificates(registrationId);
  if (selectedRegistrationId.value === registrationId) emit("changed", change || { message: "证书操作已完成。" });
}

onMounted(openDirectRegistration);
</script>

<template>
  <section>
    <form @submit.prevent="searchByName">
      <label>
        赛事
        <select v-model="eventId" data-manual-event @change="changeEvent">
          <option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option>
        </select>
      </label>
      <label>
        学生姓名
        <input v-model="athleteName" data-manual-name autocomplete="off">
      </label>
      <button type="button" class="primary" data-action="search-student" :disabled="searchLoading || !eventId" @click="searchByName">
        {{ searchLoading ? "正在查询…" : "查找已通过报名" }}
      </button>
    </form>

    <p v-if="error" class="message" role="alert">{{ error }}</p>
    <p v-if="success" class="success-message">{{ success }}</p>
    <p v-if="searchAttempted && !searchLoading && !searchRows.length">未找到已通过的报名记录</p>

    <div v-if="searchRows.length">
      <button
        v-for="row in searchRows"
        :key="row.id"
        type="button"
        data-manual-result
        @click="selectRegistration(row)"
      >
        <strong>{{ row.athlete?.name || "-" }}</strong>
        <span>{{ eventNameFor(row) }} · {{ row.athlete?.school || "-" }} · {{ row.group || "-" }} · {{ row.projectName || "-" }} · {{ row.id }}</span>
      </button>
    </div>

    <section v-if="selectedRegistration" data-manual-selected>
      <h3>{{ selectedRegistration.athlete?.name || "-" }} · {{ selectedRegistration.id }}</h3>
      <p>{{ selectedRegistration.athlete?.school || "-" }} · {{ selectedRegistration.group || "-" }} · {{ selectedRegistration.projectName || "-" }}</p>
      <div>
        <label>奖项 / 等级<input v-model="result.awardName" data-result="awardName"></label>
        <label>名次<input v-model="result.rank" data-result="rank"></label>
        <label>成绩 / 分数<input v-model="result.score" data-result="score"></label>
        <button type="button" class="primary" data-action="save-result" :disabled="resultLoading" @click="saveResult">
          {{ resultLoading ? "正在保存…" : "保存成绩" }}
        </button>
      </div>
      <p v-if="certificateLoading">正在加载证书…</p>
      <CertificateSlotEditor
        :key="selectedRegistration.id"
        :registration="selectedRegistration"
        :certificates="selectedCertificates"
        @changed="afterCertificateChanged"
      />
    </section>
  </section>
</template>
