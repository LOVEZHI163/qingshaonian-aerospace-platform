export const GRADE_GROUPS = [
  { id: "primary_lower", name: "小学低段", grades: ["一年级", "二年级", "三年级"] },
  { id: "primary_upper", name: "小学高段", grades: ["四年级", "五年级", "六年级"] },
  { id: "middle_school", name: "中学组", grades: ["初一", "初二", "初三"] },
  { id: "high_vocational", name: "职高/高中组", grades: ["高一", "高二", "高三", "职高一年级", "职高二年级", "职高三年级"] }
];

export function groupForGrade(value) {
  const grade = String(value || "").trim();
  return GRADE_GROUPS.find((group) => group.grades.includes(grade))?.name || null;
}
