import express from "express";

import { MAX_CERTIFICATE_ROWS } from "../certificates/workbook-parser.js";
import { buildCertificateTemplate } from "../certificates/template.js";
import { buildBoundRegistrationWorkbook, contentDisposition } from "../exports/registration-workbook.js";

import {
  createOrMergeRegistration,
  findSchools,
  filterAdminRegistrations,
  listAdminRegistrations,
  prepareAdminRegistrationUpdate,
  prepareOrdinaryRegistrationUpdate,
  registrationDuplicateCheck,
  registrationContextPayload,
  updateRegistrationStatus
} from "../services/registrations.js";
import { requireOrganizationEventParticipation, requireOrdinaryUser, requireWritableEvent } from "../services/access-control.js";
import { recordAudit } from "../services/audit.js";

export function createRegistrationsRouter({ store, requireUser, requireAdmin, requirePasswordReady, asyncRoute, makeId, now, clock = () => new Date() }) {
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

  function eventScopedInput(req) {
    if (req.body?.eventId && req.body.eventId !== req.params.eventId) {
      throw Object.assign(new Error("Event id does not match URL"), { status: 422, code: "EVENT_ID_MISMATCH" });
    }
    return { ...(req.body || {}), eventId: req.params.eventId };
  }

  router.get("/me/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    if (!db.events.some((event) => event.id === req.params.eventId)) {
      return res.status(404).json({ error: "Event not found", code: "EVENT_NOT_AVAILABLE" });
    }
    res.json({ rows: db.registrations.filter((row) => (
      row.eventId === req.params.eventId && row.personalUserId === req.user.id
    )) });
  }));

  router.post("/me/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    const result = createOrMergeRegistration(db, eventScopedInput(req), req.user, "personal", { makeId, now, clock });
    await store.writeDb(db);
    res.status(result.created ? 201 : 200).json(result);
  }));

  router.get("/organization/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const { organization } = requireOrganizationEventParticipation(db, req.user, req.params.eventId);
    res.json({ rows: db.registrations.filter((row) => (
      row.eventId === req.params.eventId && row.organizationId === organization.id
    )) });
  }));

  router.post("/organization/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const result = createOrMergeRegistration(db, eventScopedInput(req), req.user, "organization", { makeId, now, clock });
    await store.writeDb(db);
    res.status(result.created ? 201 : 200).json(result);
  }));

  function applyRegistrationUpdate(row, prepared, timestamp) {
    Object.assign(row, {
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

  router.patch("/me/events/:eventId/registrations/:registrationId", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    const prepared = prepareOrdinaryRegistrationUpdate(db, row, eventScopedInput(req), req.user.id);
    if (prepared.organizationId && !db.organizationEventParticipations.some((item) => (
      item.organizationId === prepared.organizationId && item.eventId === req.params.eventId
    ))) {
      throw Object.assign(new Error("Organization has not joined this event"), { status: 403, code: "ORGANIZATION_NOT_JOINED" });
    }
    applyRegistrationUpdate(row, prepared, now());
    await store.writeDb(db);
    res.json({ row });
  }));

  router.patch("/organization/events/:eventId/registrations/:registrationId", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const { organization } = requireOrganizationEventParticipation(db, req.user, req.params.eventId, { writable: true });
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId && item.organizationId === organization.id);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    if (req.body?.organizationId && req.body.organizationId !== organization.id) {
      throw Object.assign(new Error("Organization id does not match owner"), { status: 403 });
    }
    const prepared = prepareAdminRegistrationUpdate(db, row, { ...eventScopedInput(req), organizationId: organization.id });
    applyRegistrationUpdate(row, prepared, now());
    await store.writeDb(db);
    res.json({ row });
  }));

  router.patch("/me/events/:eventId/registrations/:registrationId/status", ...user, asyncRoute(async (req, res) => {
    requireOrdinaryUser(req.user);
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId && item.personalUserId === req.user.id);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    updateRegistrationStatus(db, row, req.body, req.user);
    row.updatedAt = now();
    await store.writeDb(db);
    res.json({ row });
  }));

  router.patch("/admin/events/:eventId/registrations/:registrationId/status", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId);
    if (!row) return res.status(404).json({ error: "Registration not found" });
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
    res.json({ row });
  }));

  router.patch("/admin/events/:eventId/registrations/:registrationId", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId, clock);
    const row = db.registrations.find((item) => item.id === req.params.registrationId && item.eventId === req.params.eventId);
    if (!row) return res.status(404).json({ error: "Registration not found" });
    const prepared = prepareAdminRegistrationUpdate(db, row, { ...eventScopedInput(req), eventId: req.params.eventId });
    applyRegistrationUpdate(row, prepared, now());
    await store.writeDb(db);
    res.json({ row });
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
    res.json({
      row,
      certificates: certificates.map(({ filePath, storedName, ...certificate }) => certificate)
    });
  }));

  router.get("/admin/events/:eventId/registrations", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    if (!db.events.some((event) => event.id === req.params.eventId)) return res.status(404).json({ error: "Event not found" });
    res.json(listAdminRegistrations(db, { ...req.query, eventId: req.params.eventId }, clock));
  }));

  router.get("/admin/events/:eventId/registrations/export.xlsx", ...admin, asyncRoute(async (req, res) => {
    const scope = req.query.scope || "filtered";
    if (!new Set(["filtered", "all"]).has(scope)) return res.status(422).json({ error: "导出范围不合法" });
    const db = await store.readDb();
    if (!db.events.some((event) => event.id === req.params.eventId)) return res.status(404).json({ error: "赛事不存在" });
    const query = { ...req.query, eventId: req.params.eventId };
    const workbook = buildBoundRegistrationWorkbook(filterAdminRegistrations(db, query));
    const suffix = scope === "all" ? "全部名单" : "筛选名单";
    const fileName = `报名${suffix}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(fileName));
    await workbook.xlsx.write(res);
    res.end();
  }));

  router.get("/admin/events/:eventId/certificate-template.xlsx", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const event = db.events.find((item) => item.id === req.params.eventId);
    if (!event) return res.status(404).json({ error: "赛事不存在" });
    const rows = filterAdminRegistrations(db, { eventId: event.id, status: "approved" });
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
    res.json(registrationDuplicateCheck(db, req.body, clock));
  }));

  return router;
}
