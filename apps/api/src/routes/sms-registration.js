import express from "express";

const REQUEST_ACCEPTED = Object.freeze({
  ok: true,
  message: "如果该手机号可用于注册，验证码将发送到该号码"
});

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function sendError(error, res, next) {
  if (!Number.isInteger(error?.statusCode)) return next(error);
  return res.status(error.statusCode).json({ error: error.message });
}

export function createSmsRegistrationRouter({ smsRegistration }) {
  if (!smsRegistration) throw new Error("smsRegistration is required");
  const router = express.Router();

  router.post("/auth/register/sms/request", asyncRoute(async (req, res, next) => {
    try {
      await smsRegistration.request({
        phone: req.body?.phone,
        captchaVerifyParam: req.body?.captchaVerifyParam,
        ip: req.ip
      });
      res.json(REQUEST_ACCEPTED);
    } catch (error) {
      return sendError(error, res, next);
    }
  }));

  router.post("/auth/register/sms/confirm", asyncRoute(async (req, res, next) => {
    try {
      const { phoneVerificationToken, expiresAt } = await smsRegistration.confirm({
        phone: req.body?.phone,
        code: req.body?.code
      });
      res.json({ phoneVerificationToken, expiresAt });
    } catch (error) {
      return sendError(error, res, next);
    }
  }));

  return router;
}
