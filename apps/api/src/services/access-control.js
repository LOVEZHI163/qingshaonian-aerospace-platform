import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError } from "./events.js";

export function organizationForOwner(db, userId) {
  return db.organizations.find((row) => row.ownerUserId === userId) || null;
}

export function organizationAccessState(db, user) {
  const organization = organizationForOwner(db, user?.id);
  if (user?.type !== "organization" || !organization) {
    return { allowed: false, code: "ORGANIZATION_OWNER_REQUIRED", organization };
  }
  if (organization.reviewStatus === "pending") {
    return { allowed: false, code: "ORGANIZATION_REVIEW_PENDING", organization };
  }
  if (organization.reviewStatus === "rejected") {
    return { allowed: false, code: "ORGANIZATION_REJECTED", organization };
  }
  if (organization.status !== "active") {
    return { allowed: false, code: "ORGANIZATION_DISABLED", organization };
  }
  if (user.mustChangePassword) {
    return { allowed: false, code: "PASSWORD_CHANGE_REQUIRED", organization };
  }
  return { allowed: true, code: "OK", organization };
}

export function ordinaryRegistrationEligibility(db, userId) {
  const candidates = db.memberships.flatMap((membership) => {
    if (membership.userId !== userId || membership.role !== "member" || membership.status !== "active") return [];
    const organization = db.organizations.find((row) => row.id === membership.organizationId);
    return organization?.reviewStatus === "approved" && organization?.status === "active"
      ? [{ membership, organization }]
      : [];
  });
  const eligible = candidates.length === 1;
  const { membership = null, organization = null } = eligible ? candidates[0] : {};
  return {
    eligible,
    code: eligible ? "OK" : "ACTIVE_ORGANIZATION_REQUIRED",
    organization,
    membership
  };
}

function organizationAccessMessage(code) {
  return {
    ORGANIZATION_OWNER_REQUIRED: "仅组织负责人可以执行此操作",
    ORGANIZATION_REVIEW_PENDING: "组织资质正在审核中",
    ORGANIZATION_REJECTED: "组织资质审核未通过",
    ORGANIZATION_DISABLED: "组织已停用",
    PASSWORD_CHANGE_REQUIRED: "请先修改临时密码"
  }[code] || "组织当前不可用";
}

export function requireOrganizationAccess(db, user) {
  const access = organizationAccessState(db, user);
  if (!access.allowed) {
    throw businessError(access.code === "PASSWORD_CHANGE_REQUIRED" ? 428 : 403, organizationAccessMessage(access.code), access.code);
  }
  return access.organization;
}

export function requireOrdinaryRegistrationEligibility(db, userId) {
  const eligibility = ordinaryRegistrationEligibility(db, userId);
  if (!eligibility.eligible) {
    throw businessError(403, "需要加入已审核且正常启用的组织后才能报名", eligibility.code);
  }
  return eligibility;
}

export function requireOrdinaryUser(user) {
  if (user?.type !== "ordinary") {
    throw businessError(403, "仅普通用户可以个人报名", "ORDINARY_USER_REQUIRED");
  }
  return user;
}

export function requireOrganizationOwner(db, user) {
  if (user?.type !== "organization") {
    throw businessError(403, "仅组织负责人可以执行此操作", "ORGANIZATION_OWNER_REQUIRED");
  }
  const organization = organizationForOwner(db, user.id);
  if (!organization) {
    throw businessError(403, "当前账号没有负责的组织", "ORGANIZATION_OWNER_REQUIRED");
  }
  return organization;
}

export function requireWritableEvent(db, eventId, clock = () => new Date()) {
  const event = db.events.find((row) => row.id === eventId);
  if (!event) {
    throw businessError(404, "赛事不存在或尚未发布", "EVENT_NOT_AVAILABLE");
  }
  if (event.archivedAt || event.status === "archived") {
    throw businessError(409, "赛事已归档，只允许查看历史信息", "EVENT_ARCHIVED");
  }
  const now = typeof clock === "function" ? clock() : clock;
  if (event.status !== "published" && !isRegistrationOpen(event, now || new Date()).open) {
    throw businessError(404, "赛事不存在或尚未发布", "EVENT_NOT_AVAILABLE");
  }
  return event;
}

export function requireOrganizationEventParticipation(db, user, eventId, { writable = false } = {}) {
  const organization = requireOrganizationAccess(db, user);
  const event = writable
    ? requireWritableEvent(db, eventId)
    : db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在", "EVENT_NOT_AVAILABLE");
  const participation = db.organizationEventParticipations.find(
    (row) => row.organizationId === organization.id && row.eventId === eventId
  );
  if (!participation) {
    throw businessError(403, "组织尚未加入该赛事", "ORGANIZATION_NOT_JOINED");
  }
  return { organization, event, participation };
}
