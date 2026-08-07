import express from "express";
import multer from "multer";
import crypto from "node:crypto";

import { buildLeaderAuthorizationDocx } from "../exports/leader-authorization-docx.js";
import { appendLeaderCleanupFallback } from "../files/cleanup-fallback-journal.js";
import { deletePrivateFile, readPrivateFile } from "../files/storage.js";
import { requireOrganizationAccess, requireOrganizationOwner } from "../services/access-control.js";
import {
  createOrganizationLeader,
  listOrganizationLeaders,
  OrganizationLeaderError,
  reviewOrganizationLeader,
  setOrganizationLeaderEnabled,
  updateOrganizationLeader
} from "../services/organization-leaders.js";

const AUTHORIZED_ORGANIZATION = Symbol("authorizedOrganization");
const AUTHORIZED_LEADER = Symbol("authorizedLeader");

function publicDocument(document) {
  if (!document) return null;
  const { filePath, storedName, ...safe } = document;
  return safe;
}

function publicReview(review) {
  if (!review) return null;
  return { ...review };
}

function leaderPayload(db, leader) {
  const organization = (db.organizations || []).find((row) => row.id === leader.organizationId);
  const document = (db.organizationLeaderDocuments || []).find((row) => row.id === leader.currentDocumentId && !row.cleanedAt);
  return {
    ...leader,
    organization: organization ? { id: organization.id, name: organization.name } : null,
    document: publicDocument(document)
  };
}

function leaderOrError(db, leaderId) {
  const leader = (db.organizationLeaders || []).find((row) => row.id === leaderId);
  if (!leader) throw new OrganizationLeaderError(404, "组织领队不存在");
  return leader;
}

function organizationLeaderOrError(db, organization, leaderId) {
  const leader = leaderOrError(db, leaderId);
  if (leader.organizationId !== organization.id) {
    throw new OrganizationLeaderError(403, "无权管理其他组织的领队");
  }
  return leader;
}

function revalidateOrganizationAccess(db, req) {
  const organization = requireOrganizationAccess(db, req.user);
  if (organization.id !== req[AUTHORIZED_ORGANIZATION]?.id) {
    throw new OrganizationLeaderError(403, "组织访问权限已发生变化");
  }
  return organization;
}

function revalidateOrganizationLeaderAccess(db, organization, req) {
  const leader = organizationLeaderOrError(db, organization, req.params.leaderId);
  if (leader.id !== req[AUTHORIZED_LEADER]?.id) {
    throw new OrganizationLeaderError(403, "领队访问权限已发生变化");
  }
  return leader;
}

function booleanFilter(value) {
  if (value === undefined) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new OrganizationLeaderError(422, "启用筛选必须是 true 或 false");
}

function uploadError(error, res, next) {
  if (!error) return next();
  return res.status(422).json({
    error: error.code === "LIMIT_FILE_SIZE" ? "授权书大小不能超过 10MB" : "授权书上传无效"
  });
}

function normalizePhone(value) {
  return String(value ?? "").replace(/[^\d]/g, "");
}

function sensitiveDetailsChanged(leader, input) {
  return (Object.hasOwn(input, "name") && String(input.name ?? "").trim() !== leader.name)
    || (Object.hasOwn(input, "phone") && normalizePhone(input.phone) !== leader.phone);
}

function respondError(error, res, next) {
  if (error instanceof OrganizationLeaderError || Number.isInteger(error?.status)) {
    return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  return next(error);
}

async function removeNewFile(file, removePrivateFile) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await removePrivateFile(file);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  return { error: lastError };
}

async function persistOrphanJournal({
  store,
  rollbackDb,
  file,
  cleanupResult,
  databaseError,
  writeCleanupFallback,
  makeId,
  now
}) {
  if (!file?.filePath || cleanupResult === true) return;
  rollbackDb.fileCleanupJournal ||= [];
  const marker = {
    id: makeId("CLN"),
    filePath: file.filePath,
    category: "organization-leader-documents",
    attempts: 3,
    lastError: String(cleanupResult?.error?.message || "授权书文件清理失败"),
    createdAt: now(),
    lastAttemptAt: now()
  };
  rollbackDb.fileCleanupJournal.push(marker);
  try {
    await store.writeDb(rollbackDb);
  } catch (journalError) {
    try {
      databaseError.cleanupFallback = await writeCleanupFallback(marker);
    } catch (fallbackError) {
      const untracked = new AggregateError(
        [databaseError, cleanupResult.error, journalError, fallbackError],
        `${databaseError.message}; cleanup fallback persistence failed: ${fallbackError.message}`
      );
      untracked.code = "ORPHAN_CLEANUP_UNTRACKED";
      untracked.cleanupTarget = { filePath: file.filePath, category: marker.category };
      throw untracked;
    }
  }
}

async function persistLeaderMutation({ store, db, rollbackDb, mutation, removePrivateFile, writeCleanupFallback, makeId, now }) {
  let result;
  try {
    result = await mutation();
    await store.writeDb(db);
    return result;
  } catch (error) {
    const newDocument = result?.document;
    if (newDocument?.filePath) {
      const cleanupResult = await removeNewFile(newDocument, removePrivateFile);
      await persistOrphanJournal({
        store,
        rollbackDb,
        file: newDocument,
        cleanupResult,
        databaseError: error,
        writeCleanupFallback,
        makeId,
        now
      });
    }
    throw error;
  }
}

export function createOrganizationLeadersRouter({
  store,
  requireUser,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  removePrivateFile = deletePrivateFile,
  writeCleanupFallback = appendLeaderCleanupFallback,
  makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  now = () => new Date().toISOString()
}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const uploadAuthorization = (req, res, next) => upload.single("authorization")(req, res, (error) => uploadError(error, res, next));
  const preauthorizeOrganization = ({ leader = false, allowAdmin = false } = {}) => (req, res, next) => {
    Promise.resolve().then(async () => {
      if (allowAdmin && req.user?.type === "admin") return;
      const db = await store.readDb();
      if (leader) {
        const ownedOrganization = requireOrganizationOwner(db, req.user);
        const authorizedLeader = organizationLeaderOrError(db, ownedOrganization, req.params.leaderId);
        req[AUTHORIZED_ORGANIZATION] = requireOrganizationAccess(db, req.user);
        req[AUTHORIZED_LEADER] = authorizedLeader;
        return;
      }
      const organization = requireOrganizationAccess(db, req.user);
      req[AUTHORIZED_ORGANIZATION] = organization;
    }).then(next, (error) => respondError(error, res, next));
  };
  const organizationAccess = [requireUser, preauthorizeOrganization(), requirePasswordReady];
  const organizationLeaderAccess = [requireUser, preauthorizeOrganization({ leader: true }), requirePasswordReady];
  const organizationLeaderReadAccess = [requireUser, preauthorizeOrganization({ leader: true, allowAdmin: true }), requirePasswordReady];
  const adminAccess = [requireAdmin, requirePasswordReady];

  router.get("/organization/leaders", ...organizationAccess, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const organization = revalidateOrganizationAccess(db, req);
      const rows = listOrganizationLeaders(db, organization.id).map((leader) => leaderPayload(db, leader));
      res.json({ rows });
    } catch (error) { respondError(error, res, next); }
  }));

  router.post("/organization/leaders/authorization-template.docx", ...organizationAccess, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const organization = revalidateOrganizationAccess(db, req);
      const buffer = await buildLeaderAuthorizationDocx({
        organizationName: organization.name,
        leaderName: req.body?.name,
        leaderPhone: req.body?.phone
      });
      res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        .attachment("organization-leader-authorization.docx")
        .send(buffer);
    } catch (error) { respondError(error, res, next); }
  }));

  router.post("/organization/leaders", ...organizationAccess, uploadAuthorization, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const rollbackDb = structuredClone(db);
      const organization = revalidateOrganizationAccess(db, req);
      const result = await persistLeaderMutation({
        store, db, rollbackDb, removePrivateFile, writeCleanupFallback, makeId, now,
        mutation: () => createOrganizationLeader(db, {
          ...(req.body || {}),
          organizationId: organization.id,
          authorizationFile: req.file
        }, req.user)
      });
      res.status(201).json({
        row: leaderPayload(db, result.leader),
        document: publicDocument(result.document),
        review: publicReview(result.review)
      });
    } catch (error) { respondError(error, res, next); }
  }));

  router.patch("/organization/leaders/:leaderId", ...organizationLeaderAccess, uploadAuthorization, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const rollbackDb = structuredClone(db);
      const organization = revalidateOrganizationAccess(db, req);
      const leader = revalidateOrganizationLeaderAccess(db, organization, req);
      const input = { ...(req.body || {}), ...(req.file ? { authorizationFile: req.file } : {}) };
      if (sensitiveDetailsChanged(leader, input) && !req.file) {
        throw new OrganizationLeaderError(422, "修改姓名或手机号时必须上传新的授权书");
      }
      const result = await persistLeaderMutation({
        store, db, rollbackDb, removePrivateFile, writeCleanupFallback, makeId, now,
        mutation: () => updateOrganizationLeader(db, leader.id, input, req.user)
      });
      res.json({
        row: leaderPayload(db, result.leader),
        document: publicDocument(result.document),
        review: publicReview(result.review)
      });
    } catch (error) { respondError(error, res, next); }
  }));

  router.patch("/organization/leaders/:leaderId/enabled", ...organizationLeaderAccess, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const organization = revalidateOrganizationAccess(db, req);
      const leader = revalidateOrganizationLeaderAccess(db, organization, req);
      const result = setOrganizationLeaderEnabled(db, leader.id, req.body?.enabled, req.user);
      await store.writeDb(db);
      res.json({ row: leaderPayload(db, result.leader), review: publicReview(result.review) });
    } catch (error) { respondError(error, res, next); }
  }));

  router.get("/organization/leaders/:leaderId/authorization/:documentId", ...organizationLeaderReadAccess, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const organization = req.user.type === "admin" ? null : revalidateOrganizationAccess(db, req);
      const leader = req.user.type === "admin"
        ? leaderOrError(db, req.params.leaderId)
        : revalidateOrganizationLeaderAccess(db, organization, req);
      if (req.user.type !== "admin") {
        if (leader.organizationId !== organization.id) {
          throw new OrganizationLeaderError(403, "无权下载其他组织的授权书");
        }
      }
      const document = (db.organizationLeaderDocuments || []).find((row) => (
        row.id === req.params.documentId && row.leaderId === leader.id && !row.cleanedAt
      ));
      if (!document) throw new OrganizationLeaderError(404, "授权书不存在");
      const buffer = await readPrivateFile(document);
      res.set("Cache-Control", "no-store, private");
      res.type(document.mimeType).attachment(document.originalName).send(buffer);
    } catch (error) { respondError(error, res, next); }
  }));

  router.get("/organization/leaders/:leaderId/reviews", ...organizationLeaderReadAccess, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const organization = req.user.type === "admin" ? null : revalidateOrganizationAccess(db, req);
      const leader = req.user.type === "admin"
        ? leaderOrError(db, req.params.leaderId)
        : revalidateOrganizationLeaderAccess(db, organization, req);
      const rows = (db.organizationLeaderReviews || [])
        .filter((review) => review.leaderId === leader.id)
        .map(publicReview);
      res.json({ rows });
    } catch (error) { respondError(error, res, next); }
  }));

  router.get("/admin/organization-leaders", ...adminAccess, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const enabled = booleanFilter(req.query.enabled);
      let rows = db.organizationLeaders || [];
      if (req.query.organizationId) rows = rows.filter((row) => row.organizationId === req.query.organizationId);
      if (req.query.reviewStatus) rows = rows.filter((row) => row.reviewStatus === req.query.reviewStatus);
      if (enabled !== null) rows = rows.filter((row) => row.enabled === enabled);
      res.json({ rows: rows.map((leader) => leaderPayload(db, leader)) });
    } catch (error) { respondError(error, res, next); }
  }));

  router.patch("/admin/organization-leaders/:leaderId/review", ...adminAccess, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const result = reviewOrganizationLeader(db, req.params.leaderId, {
        status: req.body?.decision,
        reason: req.body?.reason
      }, req.user);
      await store.writeDb(db);
      res.json({ row: leaderPayload(db, result.leader), review: publicReview(result.review) });
    } catch (error) { respondError(error, res, next); }
  }));

  router.patch("/admin/organization-leaders/:leaderId/enabled", ...adminAccess, asyncRoute(async (req, res, next) => {
    try {
      const db = await store.readDb();
      const result = setOrganizationLeaderEnabled(db, req.params.leaderId, req.body?.enabled, req.user);
      await store.writeDb(db);
      res.json({ row: leaderPayload(db, result.leader), review: publicReview(result.review) });
    } catch (error) { respondError(error, res, next); }
  }));

  return router;
}
