import express from "express";

export function normalizeReleaseSha(value) {
  const releaseSha = String(value || "").trim();
  return releaseSha || "development";
}

export function createSystemRouter({ releaseSha = process.env.RELEASE_SHA } = {}) {
  const router = express.Router();
  router.get("/system/version", (_req, res) => {
    res.set("Cache-Control", "no-store").json({
      releaseSha: normalizeReleaseSha(releaseSha),
      apiVersion: 1
    });
  });
  return router;
}
