import express from "express";

import { cleanupArchivedEventResources, summarizeEventStorage } from "../services/resource-cleanup.js";

export function createResourcesRouter({ store, requireAdmin, requirePasswordReady, asyncRoute, mutationAsyncRoute = asyncRoute, makeId, now }) {
  const router = express.Router();
  const admin = [requireAdmin, requirePasswordReady];
  router.get("/admin/events/:id/storage", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(await summarizeEventStorage(db, req.params.id));
  }));
  router.post("/admin/events/:id/cleanup", ...admin, mutationAsyncRoute(async (req, res) => {
    res.json(await cleanupArchivedEventResources({ store, eventId: req.params.id, categories: req.body?.categories, actor: req.user, makeId, now }));
  }));
  return router;
}
