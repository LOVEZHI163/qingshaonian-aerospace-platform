<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  minMembers: { type: Number, default: 1 },
  maxMembers: { type: Number, default: 8 },
  defaultSchool: { type: String, default: "" }
});
const emit = defineEmits(["update:modelValue"]);

let keySequence = 0;
const keys = ref([]);
const minimum = computed(() => Math.max(1, Math.min(8, Number(props.minMembers) || 1)));
const maximum = computed(() => Math.max(minimum.value, Math.min(8, Number(props.maxMembers) || 8)));

function blankParticipant() {
  return { name: "", school: props.defaultSchool || "", grade: "", phone: "", studentIdNumber: "" };
}

function participantKey(index) {
  return props.modelValue[index]?.id || keys.value[index];
}

function emitRows(rows) {
  emit("update:modelValue", rows.map((row) => ({ ...row })));
}

function addParticipant() {
  if (props.modelValue.length >= maximum.value) return;
  keys.value.push(`team-participant-${++keySequence}`);
  emitRows([...props.modelValue, blankParticipant()]);
}

function removeParticipant(index) {
  if (props.modelValue.length <= minimum.value) return;
  keys.value.splice(index, 1);
  emitRows(props.modelValue.filter((_, rowIndex) => rowIndex !== index));
}

function updateParticipant(index, field, value) {
  emitRows(props.modelValue.map((row, rowIndex) => (
    rowIndex === index ? { ...row, [field]: value } : row
  )));
}

watch(() => props.modelValue.length, (length) => {
  while (keys.value.length < length) keys.value.push(`team-participant-${++keySequence}`);
  if (keys.value.length > length) keys.value.splice(length);
}, { immediate: true });
</script>

<template>
  <section class="team-registration-fields" aria-label="团队队员">
    <article v-for="(participant, index) in modelValue" :key="participantKey(index)" class="team-participant" :data-participant-index="index">
      <div class="panel-title">
        <h4>队员 {{ index + 1 }}</h4>
        <button type="button" class="mini" :data-action="`remove-team-participant-${index}`" :disabled="modelValue.length <= minimum" @click="removeParticipant(index)">删除队员</button>
      </div>
      <div class="two">
        <label>姓名<input :value="participant.name" data-field="participant-name" required @input="updateParticipant(index, 'name', $event.target.value)" /></label>
        <label>学校<input :value="participant.school" data-field="participant-school" required @input="updateParticipant(index, 'school', $event.target.value)" /></label>
      </div>
      <div class="two">
        <label>年级<input :value="participant.grade" data-field="participant-grade" required @input="updateParticipant(index, 'grade', $event.target.value)" /></label>
        <label>手机/监护人手机<input :value="participant.phone" data-field="participant-phone" inputmode="tel" required @input="updateParticipant(index, 'phone', $event.target.value)" /></label>
      </div>
      <label>学生身份证号<input :value="participant.studentIdNumber" data-field="participant-student-id" inputmode="text" autocomplete="off" minlength="18" maxlength="18" pattern="[0-9]{17}[0-9Xx]" required @input="updateParticipant(index, 'studentIdNumber', $event.target.value)" /></label>
    </article>
    <button type="button" class="mini" data-action="add-team-participant" :disabled="modelValue.length >= maximum" @click="addParticipant">添加队员</button>
    <p class="hint">每次提交创建一支队伍，可填写 {{ minimum }}–{{ maximum }} 名队员。</p>
  </section>
</template>
