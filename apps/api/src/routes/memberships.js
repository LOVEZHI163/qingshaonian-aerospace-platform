import express from "express";

import { recordAudit } from "../services/audit.js";
import {
  actAsOrganizationOwner,
  actAsPersonalUser,
  findInvitationCandidate,
  inviteMembership,
  listOwnedMemberships,
  listPersonalRelations,
  requestMembership,
  searchOperationalOrganizations
} from "../services/memberships.js";

const PERSONAL_ACTIONS = new Set(["withdraw", "accept", "reject", "leave"]);
const OWNER_ACTIONS = new Set(["approve", "reject", "cancel", "remove"]);
const LEGACY_STATUSES = new Set(["active", "rejected", "removed"]);
const PHONE = /^1\d{10}$/;

function routeError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function requireAction(input, allowed) {
  const action = typeof input?.action === "string" ? input.action : "";
  if (!allowed.has(action)) {
    throw routeError(422, "成员关系操作不合法", "MEMBERSHIP_ACTION_INVALID");
  }
  return action;
}

function legacyOwnerAction(db, membershipId, status) {
  if (!LEGACY_STATUSES.has(status)) {
    throw routeError(422, "状态不合法", "MEMBERSHIP_ACTION_INVALID");
  }
  if (status === "active") return "approve";
  if (status === "removed") return "remove";
  const row = db.memberships.find((item) => item.id === membershipId);
  if (!row) return "reject";
  return row.direction === "organization_invite" ? "cancel" : "reject";
}

function legacyMembershipDto(row) {
  return {
    id: row.id,
    userId: row.userId,
    ...(row.invitedPhone ? { invitedPhone: row.invitedPhone } : {}),
    ...(row.invitedName ? { invitedName: row.invitedName } : {}),
    organizationId: row.organizationId,
    role: row.role,
    status: row.status,
    direction: row.direction,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function auditMutation(db, actor, action, result, createdAt) {
  recordAudit(db, {
    actor,
    action,
    targetType: "membership",
    targetId: result.row.id,
    summary: `成员关系 ${result.row.id} 执行 ${action}${result.changed === false ? "（重复请求）" : ""}`,
    createdAt
  });
  for (const cancelled of result.cancelled || []) {
    recordAudit(db, {
      actor,
      action: "membership.auto-reject",
      targetType: "membership",
      targetId: cancelled.id,
      summary: `成员关系 ${cancelled.id} 因 ${result.row.id} 激活而自动拒绝`,
      createdAt
    });
  }
}

export function createMembershipsRouter({
  store, requireUser, requirePasswordReady, asyncRoute, mutationAsyncRoute, makeId, now
}) {
  const router = express.Router();
  const authenticated = [requireUser, requirePasswordReady];

  router.get("/me/organization-relations", ...authenticated, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(listPersonalRelations(db, req.user));
  }));

  router.get("/organizations/search", ...authenticated, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json({ rows: searchOperationalOrganizations(db, req.query.q) });
  }));

  router.get("/organization/member-candidate", ...authenticated, asyncRoute(async (req, res) => {
    const phone = typeof req.query.phone === "string" ? req.query.phone : "";
    if (!PHONE.test(phone)) throw routeError(422, "请输入完整的 11 位手机号", "PHONE_INVALID");
    const db = await store.readDb();
    res.json({ user: findInvitationCandidate(db, req.user, phone) });
  }));

  router.get("/organization/memberships", ...authenticated, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(listOwnedMemberships(db, req.user));
  }));

  router.get("/organizations", ...authenticated, asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.json({ rows: searchOperationalOrganizations(db) });
  }));

  router.get("/organizations/:id/members", ...authenticated, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const result = listOwnedMemberships(db, req.user);
    if (result.organization.id !== req.params.id) {
      throw routeError(403, "无权查看该组织成员", "MEMBERSHIP_FORBIDDEN");
    }
    res.json({
      rows: db.memberships
        .filter((row) => row.organizationId === result.organization.id)
        .map(legacyMembershipDto)
    });
  }));

  const createRequest = mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const result = requestMembership(db, req.user, req.body, makeId, now);
    auditMutation(db, req.user, "membership.request", result, now());
    await store.writeDb(db);
    res.status(result.changed ? 201 : 200).json(result);
  });
  router.post("/me/organization-requests", ...authenticated, createRequest);
  router.post("/organizations/request", ...authenticated, createRequest);

  router.post("/organization/invitations", ...authenticated, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const result = inviteMembership(db, req.user, req.body, makeId, now);
    auditMutation(db, req.user, "membership.invite", result, now());
    await store.writeDb(db);
    res.status(result.changed ? 201 : 200).json(result);
  }));

  router.patch("/me/organization-relations/:id", ...authenticated, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const action = requireAction(req.body, PERSONAL_ACTIONS);
    const result = actAsPersonalUser(db, req.user, req.params.id, action, now);
    auditMutation(db, req.user, `membership.personal.${action}`, result, now());
    await store.writeDb(db);
    res.json(result);
  }));

  router.patch("/organization/memberships/:id", ...authenticated, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const action = requireAction(req.body, OWNER_ACTIONS);
    const result = actAsOrganizationOwner(db, req.user, req.params.id, action, now);
    auditMutation(db, req.user, `membership.organization.${action}`, result, now());
    await store.writeDb(db);
    res.json(result);
  }));

  router.patch("/memberships/:id", ...authenticated, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const action = legacyOwnerAction(db, req.params.id, req.body?.status);
    const result = actAsOrganizationOwner(db, req.user, req.params.id, action, now);
    auditMutation(db, req.user, `membership.organization.${action}`, result, now());
    await store.writeDb(db);
    const row = db.memberships.find((item) => item.id === result.row.id);
    res.json({ row: legacyMembershipDto(row) });
  }));

  return router;
}
