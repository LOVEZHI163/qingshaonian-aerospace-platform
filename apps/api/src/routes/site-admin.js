import express from "express";

import { recordAudit } from "../services/audit.js";
import { recordEventProfilePublication } from "../services/event-profile-publication.js";
import { buildSitePreview } from "../services/site-preview.js";
import {
  contentDetail,
  createContent,
  deleteContent,
  listEventPublicProfiles,
  offlineContent,
  publishContent,
  updateContent,
  updateSiteSettings,
  upsertEventPublicProfile
} from "../services/site-admin.js";

export function createSiteAdminRouter({
  store,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute,
  makeId,
  now
}) {
  const router = express.Router();
  const admin = [requireAdmin, requirePasswordReady];
  const incrementsVersionsInSnapshot = store.kind !== "postgres";

  const mutate = async (operation) => {
    const db = structuredClone(await store.readDb());
    const result = await operation(db);
    await store.writeDb(db);
    return { result, persisted: await store.readDb() };
  };

  router.get("/admin/site-settings", ...admin, asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.json({ row: db.siteSettings });
  }));

  router.patch("/admin/site-settings", ...admin, mutationAsyncRoute(async (req, res) => {
    const { persisted } = await mutate((db) => {
      updateSiteSettings(db, req.body, { incrementVersion: incrementsVersionsInSnapshot });
      recordAudit(db, {
        actor: req.user,
        action: "site.settings.update",
        targetType: "siteSettings",
        targetId: "default",
        summary: "更新官网设置",
        createdAt: now()
      });
    });
    res.json({ row: persisted.siteSettings });
  }));

  router.get("/admin/event-public-profiles", ...admin, asyncRoute(async (_req, res) => {
    res.json({ rows: listEventPublicProfiles(await store.readDb()) });
  }));

  router.put("/admin/event-public-profiles/:eventId", ...admin, mutationAsyncRoute(async (req, res) => {
    const { result, persisted } = await mutate((db) => {
      const createdAt = now();
      recordEventProfilePublication(db, req.params.eventId, { actor: req.user, createdAt });
      const outcome = upsertEventPublicProfile(db, req.params.eventId, req.body, {
        now: createdAt,
        incrementVersion: incrementsVersionsInSnapshot
      });
      recordEventProfilePublication(db, req.params.eventId, { actor: req.user, createdAt });
      return outcome;
    });
    const row = persisted.eventPublicProfiles.find((profile) => profile.eventId === req.params.eventId);
    res.status(result.created ? 201 : 200).json({ row });
  }));

  router.get("/admin/content", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const rows = (db.contentPosts || []).filter((row) =>
      (!req.query.status || row.status === req.query.status)
      && (!req.query.eventId || row.eventId === req.query.eventId)
      && (!req.query.type || row.type === req.query.type)
    );
    res.json({ rows });
  }));

  router.post("/admin/content", ...admin, mutationAsyncRoute(async (req, res) => {
    const contentId = makeId("POST");
    const { persisted } = await mutate((db) => createContent(db, req.body, {
      id: contentId,
      actor: req.user,
      now: now()
    }));
    res.status(201).json({ row: contentDetail(persisted, contentId) });
  }));

  router.get("/admin/content/:id", ...admin, asyncRoute(async (req, res) => {
    res.json({ row: contentDetail(await store.readDb(), req.params.id) });
  }));

  router.patch("/admin/content/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    const { persisted } = await mutate((db) => updateContent(db, req.params.id, req.body, {
      now: now(),
      incrementVersion: incrementsVersionsInSnapshot
    }));
    res.json({ row: contentDetail(persisted, req.params.id) });
  }));

  router.delete("/admin/content/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    await mutate((db) => {
      const row = deleteContent(db, req.params.id, req.body);
      recordAudit(db, {
        actor: req.user,
        action: "content.delete",
        targetType: "content",
        targetId: row.id,
        summary: `删除内容：${row.title}`,
        createdAt: now()
      });
    });
    res.status(204).end();
  }));

  router.post("/admin/content/:id/publish", ...admin, mutationAsyncRoute(async (req, res) => {
    const { persisted } = await mutate((db) => {
      const row = publishContent(db, req.params.id, req.body, {
        now: now(),
        incrementVersion: incrementsVersionsInSnapshot
      });
      if (row.eventId && !db.auditLogs.some((audit) => audit.action === "event.content-published" && audit.targetId === row.eventId)) {
        recordAudit(db, {
          actor: req.user,
          action: "event.content-published",
          targetType: "event",
          targetId: row.eventId,
          summary: `赛事已有内容发布：${row.title}`,
          createdAt: now()
        });
      }
      recordAudit(db, {
        actor: req.user,
        action: "content.publish",
        targetType: "content",
        targetId: row.id,
        summary: `发布内容：${row.title}`,
        createdAt: now()
      });
    });
    res.json({ row: contentDetail(persisted, req.params.id) });
  }));

  router.post("/admin/content/:id/offline", ...admin, mutationAsyncRoute(async (req, res) => {
    const { persisted } = await mutate((db) => {
      const row = offlineContent(db, req.params.id, req.body, {
        now: now(),
        incrementVersion: incrementsVersionsInSnapshot
      });
      recordAudit(db, {
        actor: req.user,
        action: "content.offline",
        targetType: "content",
        targetId: row.id,
        summary: `下线内容：${row.title}`,
        createdAt: now()
      });
    });
    res.json({ row: contentDetail(persisted, req.params.id) });
  }));

  router.post("/admin/site-preview/:kind", ...admin, asyncRoute(async (req, res) => {
    const preview = buildSitePreview(await store.readDb(), req.params.kind, req.body, { now: now() });
    res.set("Cache-Control", "private, no-store");
    res.json({ preview });
  }));

  return router;
}
