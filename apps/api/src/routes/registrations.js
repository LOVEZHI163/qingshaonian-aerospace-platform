import express from "express";

import {
  findSchools,
  listAdminRegistrations,
  prepareAdminRegistrationUpdate,
  prepareOrdinaryRegistrationUpdate,
  prepareRegistrationCreate,
  registrationDuplicateCheck,
  registrationContextPayload,
  updateRegistrationStatus
} from "../services/registrations.js";

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
    res.json(registrationContextPayload(db, req.user.id));
  }));

  router.get("/admin/registrations", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(listAdminRegistrations(db, req.query, clock));
  }));

  router.get("/registrations", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(listAdminRegistrations(db, req.query, clock));
  }));

  router.post("/registrations/check", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(registrationDuplicateCheck(db, req.body));
  }));

  router.post("/registrations", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const prepared = prepareRegistrationCreate(db, req.body, req.user.id);
    const row = {
      id: makeId("R"), eventId: prepared.event.id, source: "普通用户", userId: req.user.id,
      organizationId: prepared.organization?.id || null, organization: prepared.organization?.name || "",
      athlete: prepared.athlete, athleteKey: prepared.validation.athleteKey, group: prepared.group,
      projectId: prepared.project.id, projectName: prepared.project.name, projectType: prepared.validation.projectType,
      instructor: String(req.body.instructor || "").trim(), status: "pending", rejectReason: "", createdAt: now(), updatedAt: now()
    };
    db.registrations.unshift(row);
    await store.writeDb(db);
    res.status(201).json({ row, duplicateCount: prepared.validation.duplicateCount });
  }));

  router.patch("/admin/registrations/:id", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = db.registrations.find((item) => item.id === req.params.id);
    if (!row) return res.status(404).json({ error: "报名记录不存在" });
    const prepared = prepareAdminRegistrationUpdate(db, row, req.body);
    Object.assign(row, {
      organizationId: prepared.organizationId, organization: prepared.organization?.name || "", athlete: prepared.athlete,
      athleteKey: prepared.validation.athleteKey, group: prepared.group, projectId: prepared.project.id,
      projectName: prepared.project.name, projectType: prepared.validation.projectType, instructor: prepared.instructor, updatedAt: now()
    });
    const certificate = db.certificates.find((item) => item.registrationId === row.id);
    if (certificate) {
      certificate.userId = row.userId || null;
      certificate.organizationId = row.organizationId || null;
    }
    await store.writeDb(db);
    res.json({ row });
  }));

  router.patch("/registrations/:id", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = db.registrations.find((item) => item.id === req.params.id);
    if (!row) return res.status(404).json({ error: "报名记录不存在" });
    const prepared = prepareOrdinaryRegistrationUpdate(db, row, req.body, req.user.id);
    Object.assign(row, {
      organizationId: prepared.organizationId, organization: prepared.organization?.name || "", athlete: prepared.athlete,
      athleteKey: prepared.validation.athleteKey, group: prepared.group, projectId: prepared.project.id,
      projectName: prepared.project.name, projectType: prepared.validation.projectType, instructor: prepared.instructor, updatedAt: now()
    });
    const certificate = db.certificates.find((item) => item.registrationId === row.id);
    if (certificate) certificate.organizationId = row.organizationId || null;
    await store.writeDb(db);
    res.json({ row });
  }));

  router.patch("/registrations/:id/status", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = db.registrations.find((item) => item.id === req.params.id);
    if (!row) return res.status(404).json({ error: "报名记录不存在" });
    updateRegistrationStatus(db, row, req.body, req.user);
    row.updatedAt = now();
    await store.writeDb(db);
    res.json({ row });
  }));

  return router;
}
