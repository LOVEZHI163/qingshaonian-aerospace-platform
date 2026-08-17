import express from "express";

function sendError(error, res) {
  if (!error?.statusCode) throw error;
  return res.status(error.statusCode).json({ error: error.message, code: error.code });
}

export function createAccountSecurityRouter({ service, requireUser, asyncRoute }) {
  const router = express.Router();
  router.post("/auth/email/verification/request", requireUser, asyncRoute(async (req, res) => {
    try {
      res.json(await service.requestVerification({ userId: req.user.id, currentPassword: req.body.currentPassword, email: req.body.email, ip: req.ip }));
    } catch (error) { return sendError(error, res); }
  }));
  router.post("/auth/email/verification/resend", requireUser, asyncRoute(async (req, res) => {
    try {
      res.json(await service.requestVerification({ userId: req.user.id, currentPassword: req.body.currentPassword, email: req.body.email || req.user.email, ip: req.ip }));
    } catch (error) { return sendError(error, res); }
  }));
  router.get("/auth/email/verification/confirm", asyncRoute(async (req, res) => {
    try { res.json(await service.confirmVerification({ token: req.query.token })); } catch (error) { return sendError(error, res); }
  }));
  router.post("/auth/password-reset/email/request", asyncRoute(async (req, res) => {
    try { res.json(await service.requestPasswordReset({ email: req.body.email, ip: req.ip })); } catch (error) { return sendError(error, res); }
  }));
  router.get("/auth/password-reset/email/verify", asyncRoute(async (req, res) => {
    const result = await service.inspectPasswordReset({ token: req.query.token });
    if (!result) return res.status(422).json({ error: "链接无效或已过期，请重新申请", code: "INVALID_OR_EXPIRED_TOKEN" });
    res.json({ ok: true, ...result });
  }));
  router.post("/auth/password-reset/email/confirm", asyncRoute(async (req, res) => {
    try { res.json(await service.confirmPasswordReset({ token: req.body.token, password: req.body.password })); } catch (error) { return sendError(error, res); }
  }));
  return router;
}
