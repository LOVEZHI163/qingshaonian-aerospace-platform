import { businessError } from "./events.js";

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function organizationSummary(organization) {
  return {
    id: organization.id,
    name: organization.name,
    code: organization.code,
    contactName: organization.contactName,
    contactPhone: organization.contactPhone
  };
}

function requireOperationalOrganization(db, organizationId) {
  const organization = db.organizations.find((row) => row.id === organizationId);
  if (!organization) throw businessError(404, "组织不存在", "ORGANIZATION_NOT_FOUND");
  if (organization.status !== "active" || organization.reviewStatus !== "approved") {
    throw businessError(403, "组织尚未通过审核或已停用", "ORGANIZATION_NOT_OPERATIONAL");
  }
  return organization;
}

function requireOwnerOrganization(db, owner) {
  const organization = db.organizations.find((row) => row.ownerUserId === owner?.id);
  if (!organization) throw businessError(403, "只有组织负责人可以执行此操作", "ORGANIZATION_OWNER_REQUIRED");
  return requireOperationalOrganization(db, organization.id);
}

function userSummary(user) {
  return { id: user.id, name: user.name, phone: user.phone };
}

function upsertPending(db, { user, organization, direction, note, makeId, now }) {
  const existing = db.memberships.find((row) => row.userId === user.id && row.organizationId === organization.id);
  if (existing?.status === "active" || existing?.status === "pending") return { row: existing, changed: false };
  const row = existing || { id: makeId("M"), userId: user.id, organizationId: organization.id, createdAt: now() };
  Object.assign(row, {
    invitedPhone: user.phone,
    invitedName: user.name,
    role: "member",
    status: "pending",
    direction,
    note: String(note || "").trim().slice(0, 200),
    updatedAt: now()
  });
  if (!existing) db.memberships.unshift(row);
  return { row, changed: true };
}

function mutation(organization, result) {
  return { ...result, organization: organizationSummary(organization), cancelled: [] };
}

function relationWithOrganization(row, organization) {
  return { ...row, organization: organizationSummary(organization) };
}

function requireMembership(db, membershipId) {
  const row = db.memberships.find((item) => item.id === membershipId);
  if (!row) throw businessError(404, "成员关系不存在", "MEMBERSHIP_NOT_FOUND");
  return row;
}

function requireTransition(row, action, transitions) {
  const transition = transitions[action];
  if (!transition) throw businessError(422, "成员关系操作不合法", "MEMBERSHIP_ACTION_INVALID");
  if (row.status !== transition.from || (transition.direction && row.direction !== transition.direction)) {
    throw businessError(409, "当前成员关系不能执行此操作", "MEMBERSHIP_TRANSITION_INVALID");
  }
  return transition;
}

function ensureNoOtherActiveMembership(db, userId, membershipId) {
  const active = db.memberships.find((row) => (
    row.userId === userId && row.id !== membershipId && row.status === "active"
  ));
  if (active) {
    throw businessError(409, "该用户已加入其他组织，不能加入多个组织", "MEMBERSHIP_ACTIVE_CONFLICT");
  }
}

function rejectOtherPendingMemberships(db, userId, membershipId, now) {
  const cancelled = [];
  for (const row of db.memberships) {
    if (row.userId !== userId || row.id === membershipId || row.status !== "pending") continue;
    row.status = "rejected";
    row.updatedAt = now();
    cancelled.push({ id: row.id, organizationId: row.organizationId });
  }
  return cancelled;
}

function requireActiveOrdinaryMember(db, userId) {
  const user = db.users.find((row) => row.id === userId);
  if (!user || user.type !== "ordinary" || user.status !== "active") {
    throw businessError(409, "成员用户已不可用，不能加入组织", "MEMBERSHIP_USER_UNAVAILABLE");
  }
  return user;
}

const PERSONAL_ACTIONS = {
  withdraw: { direction: "user_request", from: "pending", to: "rejected" },
  accept: { direction: "organization_invite", from: "pending", to: "active" },
  reject: { direction: "organization_invite", from: "pending", to: "rejected" },
  leave: { from: "active", to: "removed" }
};

const OWNER_ACTIONS = {
  approve: { direction: "user_request", from: "pending", to: "active" },
  reject: { direction: "user_request", from: "pending", to: "rejected" },
  cancel: { direction: "organization_invite", from: "pending", to: "rejected" },
  remove: { from: "active", to: "removed" }
};

export function requestMembership(db, user, input, makeId, now) {
  if (user?.type !== "ordinary" || user.status !== "active") {
    throw businessError(403, "仅有效普通用户可以申请加入组织", "ORDINARY_USER_REQUIRED");
  }
  const organization = requireOperationalOrganization(db, String(input?.organizationId || "").trim());
  return mutation(organization, upsertPending(db, {
    user, organization, direction: "user_request", note: input?.note, makeId, now
  }));
}

export function findInvitationCandidate(db, owner, phone) {
  requireOwnerOrganization(db, owner);
  const normalized = normalizePhone(phone);
  if (!/^1\d{10}$/.test(normalized)) throw businessError(422, "请输入完整的 11 位手机号", "PHONE_INVALID");
  const user = db.users.find((row) => (
    normalizePhone(row.phone) === normalized && row.type === "ordinary" && row.status === "active"
  ));
  if (!user) throw businessError(404, "未找到有效普通用户", "INVITATION_CANDIDATE_NOT_FOUND");
  return userSummary(user);
}

export function inviteMembership(db, owner, input, makeId, now) {
  const organization = requireOwnerOrganization(db, owner);
  const candidate = findInvitationCandidate(db, owner, input?.phone);
  const user = db.users.find((row) => row.id === candidate.id);
  return mutation(organization, upsertPending(db, {
    user, organization, direction: "organization_invite", note: input?.note, makeId, now
  }));
}

export function actAsPersonalUser(db, user, membershipId, action, now) {
  if (user?.type !== "ordinary" || user.status !== "active") {
    throw businessError(403, "仅有效普通用户可以操作成员关系", "ORDINARY_USER_REQUIRED");
  }
  const row = requireMembership(db, membershipId);
  if (row.userId !== user.id) throw businessError(403, "无权操作该成员关系", "MEMBERSHIP_FORBIDDEN");
  const transition = requireTransition(row, action, PERSONAL_ACTIONS);
  const organization = requireOperationalOrganization(db, row.organizationId);
  if (transition.to === "active") {
    requireActiveOrdinaryMember(db, row.userId);
    ensureNoOtherActiveMembership(db, row.userId, row.id);
  }
  row.status = transition.to;
  row.updatedAt = now();
  const cancelled = transition.to === "active"
    ? rejectOtherPendingMemberships(db, row.userId, row.id, now)
    : [];
  return { row, organization: organizationSummary(organization), cancelled, changed: true };
}

export function actAsOrganizationOwner(db, owner, membershipId, action, now) {
  const organization = requireOwnerOrganization(db, owner);
  const row = requireMembership(db, membershipId);
  if (row.organizationId !== organization.id) {
    throw businessError(403, "无权操作该成员关系", "MEMBERSHIP_FORBIDDEN");
  }
  const transition = requireTransition(row, action, OWNER_ACTIONS);
  if (transition.to === "active") {
    requireActiveOrdinaryMember(db, row.userId);
    ensureNoOtherActiveMembership(db, row.userId, row.id);
  }
  row.status = transition.to;
  row.updatedAt = now();
  const cancelled = transition.to === "active"
    ? rejectOtherPendingMemberships(db, row.userId, row.id, now)
    : [];
  return { row, organization: organizationSummary(organization), cancelled, changed: true };
}

export function listPersonalRelations(db, user) {
  const relations = db.memberships.flatMap((row) => {
    if (row.userId !== user?.id) return [];
    const organization = db.organizations.find((item) => item.id === row.organizationId);
    if (!organization || organization.status !== "active" || organization.reviewStatus !== "approved") return [];
    return [relationWithOrganization(row, organization)];
  });
  return {
    active: relations.filter((row) => row.status === "active"),
    requests: relations.filter((row) => row.status === "pending" && row.direction === "user_request"),
    invitations: relations.filter((row) => row.status === "pending" && row.direction === "organization_invite")
  };
}

export function searchOperationalOrganizations(db, query = "") {
  const needle = String(query || "").trim().toLowerCase();
  return db.organizations
    .filter((row) => row.status === "active" && row.reviewStatus === "approved")
    .filter((row) => !needle || [row.name, row.code].some((value) => String(value || "").toLowerCase().includes(needle)))
    .map(organizationSummary)
    .slice(0, 20);
}

export function listOwnedMemberships(db, owner) {
  const organization = requireOwnerOrganization(db, owner);
  const rows = db.memberships
    .filter((row) => row.organizationId === organization.id)
    .map((row) => {
      const user = db.users.find((item) => item.id === row.userId);
      return { ...row, user: user ? userSummary(user) : null };
    });
  return {
    organization: organizationSummary(organization),
    summary: {
      total: rows.length,
      pending: rows.filter((row) => row.status === "pending").length,
      active: rows.filter((row) => row.status === "active").length
    },
    rows
  };
}
