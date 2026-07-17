import express from "express";
import multer from "multer";

import { buildCertificateErrorReport } from "../certificates/error-report.js";
import {
  cancelCertificateImport,
  listActiveCertificateImportPreviews,
  commitCertificateImport,
  loadCertificateImportErrors,
  loadCertificateImportPreview,
  previewCertificateImport
} from "../services/certificate-imports.js";

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

  router.post("/admin/certificate-imports/preview", ...admin, uploadWorkbook, mutationAsyncRoute(async (req, res) => {
    const eventId = String(req.body?.eventId || "").trim();
    if (!eventId) throw new CertificateImportError(422, "请选择赛事后再导入证书");
    const preview = await previewCertificateImport({ ...deps, file: req.file, eventId, userId: req.user.id });
    res.status(201).json(preview);
  }));

  router.get("/admin/certificate-imports", ...admin, mutationAsyncRoute(async (req, res) => {
    const rows = await listActiveCertificateImportPreviews({ ...deps, eventId: req.query.eventId });
    res.json({ rows });
  }));

  router.post("/admin/certificate-imports/:id/commit", ...admin, mutationAsyncRoute(async (req, res) => {
    res.json(await commitCertificateImport({ ...deps, batchId: req.params.id }));
  }));

  router.delete("/admin/certificate-imports/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    await cancelCertificateImport({ ...deps, batchId: req.params.id });
    res.status(204).end();
  }));

  router.get("/admin/certificate-imports/:id/previews/:rowNumber/:slot", ...admin, asyncRoute(async (req, res) => {
    const preview = await loadCertificateImportPreview({
      store,
      batchId: req.params.id,
      rowNumber: req.params.rowNumber,
      slot: req.params.slot
    });
    res.set("Cache-Control", "no-store").type(preview.mimeType).send(preview.buffer);
  }));

  router.get("/admin/certificate-imports/:id/errors.xlsx", ...admin, asyncRoute(async (req, res) => {
    const { batch, errors } = await loadCertificateImportErrors({ store, batchId: req.params.id });
    const report = await buildCertificateErrorReport(batch, errors);
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment(`certificate-import-${batch.id}-errors.xlsx`)
      .send(report);
  }));

  return router;
}
