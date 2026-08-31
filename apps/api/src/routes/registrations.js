import express from "express";
import { deleteSubmissionFile } from "../files/submission-storage.js";

import { MAX_CERTIFICATE_ROWS } from "../certificates/workbook-parser.js";
import { buildCertificateTemplate, certificateTargets } from "../certificates/template.js";
import { buildBoundRegistrationWorkbook, contentDisposition } from "../exports/registration-workbook.js";
import { sendPrivateJson, setPrivateNoStore } from "../http/private-response.js";

import {
  attachAuthorizedIdentity,
  createOrMergeRegistration,
  findSchools,
  filterAdminRegistrations,
  listAdminRegistrations,
  listOrganizationRegistrations,
  prepareAdminRegistrationUpdate,
  prepareOrdinaryRegistrationUpdate,
  requireEventId,
  registrationDuplicateCheck,
  registrationContextPayload,
  updateExistingRegistrationIdentity,
  updateRegistrationStatus
} from "../services/registrations.js";
import { requireOrganizationAccess, requireOrganizationEventParticipation, requireOrdinaryRegistrationEligibility, requireOrdinaryUser, requireWritableEvent } from "../services/access-control.js";
import { recordAudit } from "../services/audit.js";
import {
  commitUploadSession,
  replacementSessionAsset,
  replaceRegistrationAsset,
  registrationSubmissionAvailability,
  submissionAssetSummary,
  withRegistrationSubmission
} from "../services/submission-assets.js";

export function createRegistrationsRouter({
  store, requireUser, requireAdmin, requirePasswordReady, asyncRoute, makeId, now,
  clock = () => new Date(), deleteFile = deleteSubmissionFile, logger = console
}) {
  const router = express.Router();
  const user = [requireUser, requirePasswordReady];
  const admin = [requireAdmin, requirePasswordReady];

  router.get("/schools", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json({ rows: findSchools(db, req.query.q) });
  }));

  router.get("/me/registration-context", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(registrationContextPayload(db, req.user.id, req.query, clock));
  }));

  router.get("/organization/registrations", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const organization = requireOrganizationAccess(db, req.user);
    sendPrivateJson(res, listOrganizationRegistrations(db, organization.id, req.query, clock));
  }));

  function eventScopedInput(req) {
    if (req.body?.eventId && req.body.eventId !== req.params.eventId) {
      throw Object.assign(new Error("Event id does not match URL"), { status: 422, code: "EVENT_ID_MISMATCH" });
    }
    return { ...(req.body || {}), eventId: req.params.eventId };
  }

  async function cleanOldRegistrationAsset(db, asset) {
    try {
      await deleteFile(asset);
    } catch (error) {
      const createdAt = now();
      db.fileCleanupJournal ||= [];
      db.fileCleanupJournal.push({
        id: makeId("CLN"), filePath: asset.filePath, category: "registration-asset-replaced",
        attempts: 1, lastError: String(error?.message || error).slice(0, 500), createdAt, lastAttemptAt: createdAt
      });
      try {
        await store.writeDb(db);
      } catch {
        try { logger?.error?.("Registration asset cleanup journal persistence failed", { assetId: asset.id }); } catch { /* response stays committed */ }
      }
    }
  }

  async function discardFailedReplacementSource(db, asset) {
    const cleanedAt = now();
    asset.cleanedAt = cleanedAt;
    asset.cleanupReason = "替换报名写入数据库失败，已撤销新作品材料";
    try {
      await store.writeDb(db);
    } catch {
      try { logger?.error?.("Replacement source cleanup state persistence failed", { assetId: asset.id }); } catch { /* preserve original database error */ }
      return;
    }
    try {
      await deleteFile(asset);
    } catch (error) {
      db.fileCleanupJournal ||= [];
      db.fileCleanupJournal.push({
        id: makeId("CLN"), filePath: asset.filePath, category: "registration-asset-replacement-rollback",
        attempts: 1, lastError: String(error?.message || error).slice(0, 500), createdAt: cleanedAt, lastAttemptAt: cleanedAt
      });
      try {
        await store.writeDb(db);
      } catch {
        try { logger?.error?.("Replacement source cleanup journal persistence failed", { assetId: asset.id }); } catch { /* preserve original database error */ }
      }
    }
  }

  function withEventSummary(db, row) {
    const event = db.events.find((item) => item.id === row.eventId);
    return {
      ...withRegistrationSubmission(db, row),
      eventId: row.eventId,
      eventName: event?.name || row.eventId,
      eventStatus: event?.status || ""
    };
  }

  function registrationResponse(db, row, actor) {
    return attachAuthorizedIdentity(db, withRegistrationSubmission(db, row), actor);
  }

  router.get("/me/registrations", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    const rows = db.registrations
      .filter((row) => row.personalUserId === req.user.id)
      .map((row) => attachAuthorizedIdentity(db, withEventSummary(db, row), req.user));
    sendPrivateJson(res, { rows });
  }));

  router.get("/me/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    if (!db.events.some((event) => event.id === req.params.eventId)) {
      return res.status(404).json({ error: "Event not found", code: "EVENT_NOT_AVAILABLE" });
    }
    sendPrivateJson(res, { rows: db.registrations.filter((row) => (
      row.eventId === req.params.eventId && row.personalUserId === req.user.id
    )).map((row) => registrationResponse(db, row, req.user)) });
  }));

  router.post("/me/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    const input = eventScopedInput(req);
    const result = createOrMergeRegistration(db, input, req.user, "personal", { makeId, now, clock });
    const project = db.projects.find((item) => item.id === result.row.projectId && item.eventId === result.row.eventId);
    if (project?.submissionMode === "image_video") {
      commitUploadSession({ db, sessionId: input.uploadSessionId, registration: result.row, actor: req.user, channel: "personal", now });
    }
    await store.writeDb(db);
    sendPrivateJson(res, { ...result, row: registrationResponse(db, result.row, req.user) }, { status: result.created ? 201 : 200 });
  }));

  router.get("/organization/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const { organization } = requireOrganizationEventParticipation(db, req.user, req.params.eventId);
    sendPrivateJson(res, { rows: db.registrations.filter((row) => (
      row.eventId === req.params.eventId && row.organizationId === organization.id
    )).map((row) => registrationResponse(db, row, req.user)) });
  }));

  router.get("/organization/events/:eventId/export.xlsx", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const { organization, event } = requireOrganizationEventParticipation(db, req.user, req.params.eventId);
    const rows = db.registrations
      .filter((row) => row.eventId === event.id && row.organizationId === organization.id)
      .map((row) => attachAuthorizedIdentity(db, row, req.user));
    const workbook = buildBoundRegistrationWorkbook(rows);
    setPrivateNoStore(res);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(`${event.name}_${organization.name}_报名名单.xlsx`));
    await workbook.xlsx.write(res);
    res.end();
  }));

  router.post("/organization/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const input = eventScopedInput(req);
    const result = createOrMergeRegistration(db, input, req.user, "organization", { makeId, now, clock });
    const project = db.projects.find((item) => item.id === result.row.projectId && item.eventId === result.row.eventId);
    if (project?.submissionMode === "image_video") {
      commitUploadSession({ db, sessionId: input.uploadSessionId, registration: result.row, actor: req.user, channel: "organization", now });
    }
    await store.writeDb(db);
    sendPrivateJson(res, { ...result, row: registrationResponse(db, result.row, req.user) }, { status: result.created ? 201 : 200 });
  }));

  function replaceAsset(channel, middleware) {
    return [...middleware, asyncRoute(async (req, res) => {
      const db = await store.readDb();
      const registration = db.registrations.find((row) => row.id === req.params.registrationId && row.eventId === req.params.eventId);
      if (!registration) return res.status(404).json({ error: "Registration not found" });
      const uploaded = replacementSessionAsset({
        db, sessionId: req.body?.uploadSessionId, registration, kind: req.params.kind,
        actor: req.user, channel, now
      });
      const replacement = replaceRegistrationAsset({
        db, registration, kind: req.params.kind, uploadedAsset: uploaded.asset, actor: req.user, channel, now
      });
      try {
        await store.writeDb(db);
      } catch (error) {
        replacement.rollback();
        await discardFailedReplacementSource(db, uploaded.asset);
        throw error;
      }
      await cleanOldRegistrationAsset(db, replacement.previous);
      sendPrivateJson(res, { row: submissionAssetSummary(replacement.asset), registration: registrationResponse(db, registration, req.user) });
    })];
  }

  router.put("/me/events/:eventId/registrations/:registrationId/assets/:kind", ...replaceAsset("personal", user));
  router.put("/organization/events/:eventId/registrations/:registrationId/assets/:kind", ...replaceAsset("organization", user));
  router.put("/admin/events/:eventId/registrations/:registrationId/assets/:kind", ...replaceAsset("admin", admin));

  function applyRegistrationUpdate(row, prepared, timestamp) {
    Object.assign(row, {
      source: prepared.source ?? row.source,
      organizationId: prepared.organizationId,
      organization: prepared.organization?.name || "",
      athlete: prepared.athlete,
      athleteKey: prepared.validation.athleteKey,
      group: prepared.group,
      projectId: prepared.project.id,
      projectName: prepared.project.name,
      projectType: prepared.validation.projectType,
      instructor: prepared.instructor,
      updatedAt: timestamp
    });
  }

  function replaceTeamRoster(db, row, prepared) {
    if (!prepared.teamRoster) return;
    const previousIds = new Set((db.registrationParticipants || [])
      .filter((participant) => participant.registrationId === row.id)
      .map((participant) => participant.id));
    db.registrationParticipants = (db.registrationParticipants || [])
      .filter((participant) => participant.registrationId !== row.id);
    db.registrationParticipantIdentities = (db.registrationParticipantIdentities || [])
      .filter((identity) => !previousIds.has(identity.participantId));
    db.registrationParticipants.push(...prepared.teamRoster.participants.map((participant) => ({
      ...participant,
      registrationId: row.id
    })));
    db.registrationParticipantIdentities.push(...prepared.teamRoster.identities);
  }

  router.patch("/me/events/:eventId/registrations/:registrationId", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    const prepared = prepareOrdinaryRegistrationUpdate(db, row, eventScopedInput(req), req.user.id);
    const timestamp = now();
    applyRegistrationUpdate(row, prepared, timestamp);
    updateExistingRegistrationIdentity(db, row.id, req.body, timestamp);
    await store.writeDb(db);
    sendPrivateJson(res, { row: registrationResponse(db, row, req.user) });
  }));

  router.patch("/organization/events/:eventId/registrations/:registrationId", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const { organization } = requireOrganizationEventParticipation(db, req.user, req.params.eventId, { writable: true });
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId && item.organizationId === organization.id);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    if (req.body?.organizationId && req.body.organizationId !== organization.id) {
      throw Object.assign(new Error("Organization id does not match owner"), { status: 403 });
    }
    const prepared = prepareAdminRegistrationUpdate(db, row, { ...eventScopedInput(req), organizationId: organization.id }, { makeId, now });
    const timestamp = now();
    applyRegistrationUpdate(row, prepared, timestamp);
    replaceTeamRoster(db, row, prepared);
    updateExistingRegistrationIdentity(db, row.id, req.body, timestamp);
    await store.writeDb(db);
    sendPrivateJson(res, { row: registrationResponse(db, row, req.user) });
  }));

  router.patch("/me/events/:eventId/registrations/:registrationId/status", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId && item.personalUserId === req.user.id);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    requireOrdinaryRegistrationEligibility(db, req.user.id, { requireApprovedLeader: false });
    updateRegistrationStatus(db, row, req.body, req.user);
    row.updatedAt = now();
    await store.writeDb(db);
    sendPrivateJson(res, { row: registrationResponse(db, row, req.user) });
  }));

  router.patch("/admin/events/:eventId/registrations/:registrationId/status", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    if (req.body?.status === "approved") {
      const submission = await registrationSubmissionAvailability(db, row);
      if (submission?.required && !submission.complete) {
        return res.status(422).json({ error: "必传作品材料不完整、已清理或文件缺失，不能直接通过报名", code: "SUBMISSION_ASSETS_INCOMPLETE" });
      }
    }
    updateRegistrationStatus(db, row, req.body, req.user);
    row.updatedAt = now();
    recordAudit(db, {
      actor: req.user,
      action: "registration.review",
      targetType: "registration",
      targetId: row.id,
      summary: `Update registration status: ${row.status}`,
      createdAt: row.updatedAt
    });
    await store.writeDb(db);
    sendPrivateJson(res, { row: registrationResponse(db, row, req.user) });
  }));

  router.patch("/admin/events/:eventId/registrations/:registrationId", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    const prepared = prepareAdminRegistrationUpdate(db, row, { ...eventScopedInput(req), eventId: req.params.eventId }, { makeId, now });
    const timestamp = now();
    applyRegistrationUpdate(row, prepared, timestamp);
    replaceTeamRoster(db, row, prepared);
    updateExistingRegistrationIdentity(db, row.id, req.body, timestamp);
    await store.writeDb(db);
    sendPrivateJson(res, { row: registrationResponse(db, row, req.user) });
  }));

  router.post("/admin/events/:eventId/registrations/:registrationId/result", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    row.awardName = String(req.body.awardName || "");
    row.rank = String(req.body.rank || "");
    row.score = String(req.body.score || "");
    row.resultRecordedAt = now();
    row.updatedAt = now();
    const certificates = db.certificates.filter((certificate) => certificate.registrationId === row.id);
    for (const certificate of certificates) {
      certificate.awardName = row.awardName;
      certificate.rank = row.rank;
      certificate.score = row.score;
      certificate.updatedAt = row.updatedAt;
    }
    await store.writeDb(db);
    sendPrivateJson(res, {
      row: registrationResponse(db, row, req.user),
      certificates: certificates.map(({ filePath, storedName, ...certificate }) => certificate)
    });
  }));

  router.get("/admin/events/:eventId/registrations", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireEventId(db, req.params.eventId);
    const payload = listAdminRegistrations(db, { ...req.query, eventId: req.params.eventId }, clock);
    await Promise.all(payload.rows.map(async (row) => {
      const submission = await registrationSubmissionAvailability(db, row);
      if (submission) row.submission = submission;
    }));
    sendPrivateJson(res, payload);
  }));

  router.get("/admin/events/:eventId/registrations/export.xlsx", ...admin, asyncRoute(async (req, res) => {
    const scope = req.query.scope || "filtered";
    if (!new Set(["filtered", "all"]).has(scope)) return res.status(422).json({ error: "导出范围不合法" });
    const db = await store.readDb();
    requireEventId(db, req.params.eventId);
    const query = { ...req.query, eventId: req.params.eventId };
    const workbook = buildBoundRegistrationWorkbook(filterAdminRegistrations(db, query).map((row) => attachAuthorizedIdentity(db, row, req.user)));
    const suffix = scope === "all" ? "全部名单" : "筛选名单";
    const fileName = `报名${suffix}.xlsx`;
    setPrivateNoStore(res);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(fileName));
    await workbook.xlsx.write(res);
    res.end();
  }));

  router.get("/admin/events/:eventId/certificate-template.xlsx", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const event = requireEventId(db, req.params.eventId);
    const rows = certificateTargets(filterAdminRegistrations(db, { eventId: event.id, status: "approved" })
      .map((row) => attachAuthorizedIdentity(db, row, req.user)));
    if (rows.length > MAX_CERTIFICATE_ROWS) {
      const error = new Error(`证书模板最多支持 ${MAX_CERTIFICATE_ROWS.toLocaleString("en-US")} 条已审核报名`);
      error.status = 413;
      throw error;
    }
    const workbook = await buildCertificateTemplate(rows);
    const fileName = `${event.name}_证书导入模板.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(fileName));
    await workbook.xlsx.write(res);
    res.end();
  }));

  router.post("/registrations/check", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(registrationDuplicateCheck(db, req.body, req.user, clock));
  }));

  return router;
}
