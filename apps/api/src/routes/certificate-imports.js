import express from "express";
import multer from "multer";

import { buildCertificateErrorReport } from "../certificates/error-report.js";
import {
  CertificateImportError,
  cancelCertificateImport,
  listActiveCertificateImportPreviews,
  commitCertificateImport,
  loadCertificateImportErrors,
  loadCertificateImportPreview,
  previewCertificateImport
} from "../services/certificate-imports.js";
import { requireWritableEvent } from "../services/access-control.js";

export function createCertificateImportsRouter({
  store,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute = asyncRoute,
  makeId,
  now
}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const admin = [requireAdmin, requirePasswordReady];
  const uploadWorkbook = (req, res, next) => upload.single("workbook")(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 422).json({
      error: tooLarge ? "证书 Excel 工作簿不能超过 25 MB" : "证书 Excel 工作簿上传无效"
    });
  });
  const deps = { store, makeId, now };

  function eventForRead(db, eventId) {
    const event = db.events.find((row) => row.id === eventId);
    if (!event) throw new CertificateImportError(404, "Event not found");
    return event;
  }

  function batchForEvent(db, eventId, batchId) {
    const batch = db.certificateImportBatches.find((row) => row.id === batchId && row.eventId === eventId);
    if (!batch) throw new CertificateImportError(404, "Certificate import batch not found");
    return batch;
  }

  router.post("/admin/events/:eventId/certificate-imports/preview", ...admin, uploadWorkbook, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId);
    const bodyEventId = String(req.body?.eventId || "").trim();
    if (bodyEventId && bodyEventId !== req.params.eventId) throw new CertificateImportError(422, "Event id does not match URL");
    const preview = await previewCertificateImport({ ...deps, file: req.file, eventId: req.params.eventId, userId: req.user.id });
    res.status(201).json(preview);
  }));

  router.get("/admin/events/:eventId/certificate-imports", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    eventForRead(db, req.params.eventId);
    const rows = await listActiveCertificateImportPreviews({ ...deps, eventId: req.params.eventId });
    res.json({ rows });
  }));

  router.post("/admin/events/:eventId/certificate-imports/:id/commit", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId);
    batchForEvent(db, req.params.eventId, req.params.id);
    res.json(await commitCertificateImport({ ...deps, batchId: req.params.id, actor: req.user }));
  }));

  router.delete("/admin/events/:eventId/certificate-imports/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    requireWritableEvent(db, req.params.eventId);
    batchForEvent(db, req.params.eventId, req.params.id);
    await cancelCertificateImport({ ...deps, batchId: req.params.id });
    res.status(204).end();
  }));

  router.get("/admin/events/:eventId/certificate-imports/:id/previews/:rowNumber/:slot", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    eventForRead(db, req.params.eventId);
    batchForEvent(db, req.params.eventId, req.params.id);
    const preview = await loadCertificateImportPreview({
      store,
      batchId: req.params.id,
      rowNumber: req.params.rowNumber,
      slot: req.params.slot
    });
    res.set("Cache-Control", "no-store").type(preview.mimeType).send(preview.buffer);
  }));

  router.get("/admin/events/:eventId/certificate-imports/:id/errors.xlsx", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    eventForRead(db, req.params.eventId);
    batchForEvent(db, req.params.eventId, req.params.id);
    const { batch, errors } = await loadCertificateImportErrors({ store, batchId: req.params.id });
    const report = await buildCertificateErrorReport(batch, errors);
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment(`certificate-import-${batch.id}-errors.xlsx`)
      .send(report);
  }));

  return router;
}
