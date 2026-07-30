import express from "express";
import multer from "multer";

import {
  assertOrganizationReadyForApproval,
  OrganizationError,
  registerOrdinary,
  registerOrganization,
  resubmitOrganization,
  reviewOrganization,
  validateCurrentCredentialFile
} from "../services/organizations.js";
import { recordAudit } from "../services/audit.js";
import { cleanupOrganizationCredentials } from "../services/resource-cleanup.js";

function publicDocument(document, currentDocumentId = null) {
  if (!document) return null;
  const { filePath, storedName, ...safe } = document;
  return { ...safe, isCurrent: document.id === currentDocumentId };
}

function publicOrganization(organization) {
  if (!organization) return null;
  return { ...organization };
}

function organizationWithDocuments(db, organization, membershipRole = null) {
  return {
    ...publicOrganization(organization),
    memberCount: db.memberships.filter((membership) => membership.organizationId === organization.id).length,
    ...(membershipRole ? { membershipRole } : {}),
    documents: db.organizationDocuments
      .filter((document) => document.organizationId === organization.id && !document.cleanedAt)
      .map((document) => publicDocument(document, organization.currentDocumentId))
  };
}

function respondError(error, res, next) {
  if (error instanceof OrganizationError) return res.status(error.status).json({ error: error.message });
  return next(error);
}

export function createOrganizationsRouter({ store, requireUser, requireAdmin, requirePasswordReady, asyncRoute, hashPassword, validatePassword, makeId, now, publicUser }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const deps = { readDb: () => store.readDb(), writeDb: (db) => store.writeDb(db), hashPassword, validatePassword, makeId, now };
  const uploadCredential = (req, res, next) => upload.single("credential")(req, res, (error) => {
    if (!error) return next();
    return res.status(422).json({
      error: error.code === "LIMIT_FILE_SIZE" ? "资质文件大小不能超过 10MB" : "资质文件上传无效"
    });
  });

  router.post("/auth/register/ordinary", asyncRoute(async (req, res, next) => {
    try {
      const result = await registerOrdinary({ ...deps, input: req.body || {} });
      res.status(201).json({ user: publicUser(result.user), organization: null });
    } catch (error) { respondError(error, res, next); }
  }));

  router.post("/auth/register/organization", uploadCredential, asyncRoute(async (req, res, next) => {
    try {
      const result = await registerOrganization({ ...deps, input: req.body || {}, file: req.file });
      res.status(201).json({ user: publicUser(result.user), organization: publicOrganization(result.organization), document: publicDocument(result.document, result.organization.currentDocumentId) });
    } catch (error) { respondError(error, res, next); }
  }));

  router.get("/me/organizations", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
    const db = await deps.readDb();
    const owned = req.user.type === "organization"
      ? db.organizations.filter((organization) => organization.ownerUserId === req.user.id)
        .map((organization) => organizationWithDocuments(db, organization))
      : [];
    const memberships = req.user.type === "ordinary"
      ? db.memberships
        .filter((membership) => membership.userId === req.user.id && membership.status === "active")
        .map((membership) => {
          const organization = db.organizations.find((row) => row.id === membership.organizationId);
          return organization && organizationWithDocuments(db, organization, "member");
        })
        .filter(Boolean)
      : [];
    const rows = [...owned, ...memberships];
    res.json({ rows });
  }));

  router.get("/admin/organizations", requireAdmin, requirePasswordReady, asyncRoute(async (_req, res) => {
    const db = await deps.readDb();
    res.json({ rows: db.organizations.map((organization) => organizationWithDocuments(db, organization)) });
  }));

  router.patch("/admin/organizations/:id/status", requireAdmin, requirePasswordReady, asyncRoute(async (req, res, next) => {
    try {
      const status = String(req.body?.status || "");
      if (!new Set(["active", "disabled"]).has(status)) throw new OrganizationError(422, "组织状态无效");
      const db = await deps.readDb();
      const organization = db.organizations.find((row) => row.id === req.params.id);
      if (!organization) return res.status(404).json({ error: "组织不存在" });
      if (status === "active") {
        const credential = db.organizationDocuments.find((row) => row.id === organization.currentDocumentId && !row.cleanedAt);
        if (!credential || organization.reviewStatus !== "approved") {
          throw new OrganizationError(409, "重新启用前必须上传新资质并重新审核通过");
        }
      }
      organization.status = status;
      organization.updatedAt = now();
      recordAudit(db, {
        actor: req.user,
        action: "organization.status",
        targetType: "organization",
        targetId: organization.id,
        summary: `${organization.name}已${status === "active" ? "启用" : "停用"}`,
        createdAt: now()
      });
      await deps.writeDb(db);
      res.json({ organization: publicOrganization(organization) });
    } catch (error) { respondError(error, res, next); }
  }));

  router.post("/admin/organizations/:id/credential-cleanup", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
    res.json(await cleanupOrganizationCredentials({
      store,
      organizationId: req.params.id,
      confirmName: req.body?.confirmName,
      actor: req.user,
      makeId,
      now
    }));
  }));

  router.patch("/admin/organizations/:id/review", requireAdmin, requirePasswordReady, asyncRoute(async (req, res, next) => {
    try {
      const db = await deps.readDb();
      const organization = db.organizations.find((row) => row.id === req.params.id);
      if (!organization) return res.status(404).json({ error: "组织不存在" });
      if (req.body?.status === "approved") {
        const credential = assertOrganizationReadyForApproval(organization, db.organizationDocuments);
        await validateCurrentCredentialFile(credential);
      }
      reviewOrganization(organization, req.body || {}, req.user.id, now());
      recordAudit(db, {
        actor: req.user,
        action: "organization.review",
        targetType: "organization",
        targetId: organization.id,
        summary: `${organization.name}审核为${organization.reviewStatus === "approved" ? "通过" : "驳回"}`,
        createdAt: now()
      });
      await deps.writeDb(db);
      res.json({ organization: publicOrganization(organization) });
    } catch (error) { respondError(error, res, next); }
  }));

  router.patch("/me/organization", requireUser, requirePasswordReady, uploadCredential, asyncRoute(async (req, res, next) => {
    try {
      const result = await resubmitOrganization({ ...deps, input: req.body || {}, file: req.file, userId: req.user.id });
      res.json({ organization: publicOrganization(result.organization), document: publicDocument(result.document, result.organization.currentDocumentId) });
    } catch (error) { respondError(error, res, next); }
  }));

  router.get("/organizations/:id/credential/:documentId", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
    const db = await deps.readDb();
    const document = db.organizationDocuments.find((row) => row.id === req.params.documentId && row.organizationId === req.params.id && !row.cleanedAt);
    if (!document) return res.status(404).json({ error: "资质文件不存在" });
    const isAdmin = req.user.type === "admin";
    const isOwner = req.user.type === "organization"
      && db.organizations.some((organization) => organization.id === req.params.id && organization.status === "active" && organization.ownerUserId === req.user.id);
    if (!isAdmin && !isOwner) return res.status(403).json({ error: "无权下载该组织资质" });
    res.type(document.mimeType).attachment(document.originalName).sendFile(document.filePath);
  }));

  return router;
}
