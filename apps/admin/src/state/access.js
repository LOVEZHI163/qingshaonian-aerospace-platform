export const accessMessages = Object.freeze({
  ACTIVE_ORGANIZATION_REQUIRED: "请先加入已通过审核的组织后再报名",
  INVALID_STUDENT_ID_NUMBER: "输入的身份证号码不符合国家标准，请检查后重新填写",
  ORGANIZATION_LEADER_REQUIRED: "所属组织尚无审核通过且已启用的领队，请联系组织负责人",
  ORGANIZATION_REVIEW_PENDING: "组织资质正在审核中",
  ORGANIZATION_REJECTED: "组织资质未通过，请按原因重新提交",
  ORGANIZATION_DISABLED: "组织已被平台停用",
  ORGANIZATION_OWNER_REQUIRED: "当前账号没有可管理的组织"
});

const organizationRestrictionCodes = new Set([
  "ORGANIZATION_REVIEW_PENDING",
  "ORGANIZATION_REJECTED",
  "ORGANIZATION_DISABLED",
  "ORGANIZATION_OWNER_REQUIRED"
]);

export function isOrganizationRestrictionError(error) {
  return organizationRestrictionCodes.has(error?.code);
}

export function accessMessage(error, fallback = "操作失败，请稍后重试") {
  if (typeof error === "string" && error.trim()) return error;
  return accessMessages[error?.code] || error?.message || fallback;
}

export function organizationAccessFor(user, organizations = []) {
  if (user?.type !== "organization") return { operational: true, code: "OK", organization: null };
  const organization = Array.isArray(organizations) && organizations.length === 1 ? organizations[0] : null;
  if (!organization) return { operational: false, code: "ORGANIZATION_OWNER_REQUIRED", organization: null };
  if (organization.reviewStatus === "pending") return { operational: false, code: "ORGANIZATION_REVIEW_PENDING", organization };
  if (organization.reviewStatus === "rejected") return { operational: false, code: "ORGANIZATION_REJECTED", organization };
  if (organization.status !== "active") return { operational: false, code: "ORGANIZATION_DISABLED", organization };
  return { operational: true, code: "OK", organization };
}
