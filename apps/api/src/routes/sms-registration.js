import express from "express";

const REQUEST_ACCEPTED = Object.freeze({
  ok: true,
  message: "如果该手机号可用于注册，验证码将发送到该号码"
});

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const SAFE_STATUS_BY_MESSAGE = new Map([
  ["短信验证暂未启用", 503],
  ["手机号格式无效", 422],
  ["请求过于频繁，请稍后再试", 429],
  ["人机验证未通过，请重试", 422],
  ["验证码无效或已过期", 422],
  ["手机号验证已过期，请重新验证", 422]
]);

function internalError() {
  return Object.assign(new Error("SMS registration failed"), {
    code: "SMS_REGISTRATION_FAILED"
  });
}

function sendError(error, res, next) {
  const safeStatus = SAFE_STATUS_BY_MESSAGE.get(error?.message);
  if (safeStatus !== undefined && safeStatus === error?.statusCode) {
    return res.status(safeStatus).json({ error: error.message });
  }
  return next(internalError());
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
