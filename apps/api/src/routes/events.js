import express from "express";

import {
  archiveEvent,
  copyEvent,
  createEvent,
  createProject,
  deleteProject,
  publicEventPayload,
  setCurrentEvent,
  updateEvent,
  updateProject
} from "../services/events.js";

export function createEventsRouter({ store, requireAdmin, requirePasswordReady, asyncRoute, makeId, clock = () => new Date() }) {
  const router = express.Router();
  const admin = [requireAdmin, requirePasswordReady];

  router.get("/admin/events", ...admin, asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.json({ rows: db.events, projects: db.projects });
  }));

  router.post("/admin/events", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = createEvent(db, req.body, { makeId, clock });
    await store.writeDb(db);
    res.status(201).json({ row });
  }));

  router.patch("/admin/events/:id", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = updateEvent(db, req.params.id, req.body, { clock });
    await store.writeDb(db);
    res.json({ row });
  }));

  router.post("/admin/events/:id/copy", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const result = copyEvent(db, req.params.id, req.body, { makeId, clock });
    await store.writeDb(db);
    res.status(201).json(result);
  }));

  router.post("/admin/events/:id/current", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = setCurrentEvent(db, req.params.id, { clock });
    await store.writeDb(db);
    res.json({ row });
  }));

  router.post("/admin/events/:id/archive", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = archiveEvent(db, req.params.id, { clock });
    await store.writeDb(db);
    res.json({ row });
  }));

  router.post("/admin/events/:eventId/projects", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = createProject(db, req.params.eventId, req.body, { makeId });
    await store.writeDb(db);
    res.status(201).json({ row });
  }));

  router.patch("/admin/projects/:id", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = updateProject(db, req.params.id, req.body);
    await store.writeDb(db);
    res.json({ row });
  }));

  router.delete("/admin/projects/:id", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = deleteProject(db, req.params.id);
    await store.writeDb(db);
    res.json({ ok: true, row });
  }));

  router.get("/public/event", asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.json(publicEventPayload(db, clock));
  }));

  return router;
}
