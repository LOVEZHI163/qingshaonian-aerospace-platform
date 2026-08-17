import CaptchaPackage, { VerifyIntelligentCaptchaRequest } from "@alicloud/captcha20230305";
import { $OpenApiUtil } from "@alicloud/openapi-core";

const CaptchaClient = CaptchaPackage.default;
const endpoints = {
  cn: "captcha.cn-shanghai.aliyuncs.com",
  sgp: "captcha.ap-southeast-1.aliyuncs.com"
};

class HumanVerificationError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function createHumanVerification(env, { client: injectedClient, logger = console } = {}) {
  const enabled = env.ALIYUN_CAPTCHA_ENABLED === "true";
  const region = env.ALIYUN_CAPTCHA_REGION || "cn";
  const sceneIds = {
    "sms-login": env.ALIYUN_CAPTCHA_LOGIN_SCENE_ID,
    "sms-password-reset": env.ALIYUN_CAPTCHA_SMS_RESET_SCENE_ID,
    "email-password-reset": env.ALIYUN_CAPTCHA_EMAIL_RESET_SCENE_ID
  };

  if (!enabled) {
    return {
      enabled: false,
      ready: true,
      publicConfig: { enabled: false, region, prefix: "", scenes: {} },
      async verify() { return true; }
    };
  }

  const endpoint = endpoints[region];
  const prefix = env.ALIYUN_CAPTCHA_PREFIX;
  const ready = Boolean(
    endpoint
      && prefix
      && env.ALIBABA_CLOUD_ACCESS_KEY_ID
      && env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
      && Object.values(sceneIds).every(Boolean)
  );
  let client = injectedClient;
  if (ready && !client) {
    const config = new $OpenApiUtil.Config({
      accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      endpoint
    });
    client = new CaptchaClient(config);
  }

  return {
    enabled: true,
    ready,
    publicConfig: ready
      ? { enabled: true, region, prefix, scenes: { ...sceneIds } }
      : { enabled: false, region, prefix: "", scenes: {} },
    async verify({ scene, captchaVerifyParam }) {
      if (!ready) throw new HumanVerificationError(503, "人机验证暂不可用");
      const sceneId = sceneIds[scene];
      if (!sceneId || !String(captchaVerifyParam || "").trim()) {
        throw new HumanVerificationError(422, "人机验证未通过，请重试");
      }
      try {
        const response = await client.verifyIntelligentCaptcha(
          new VerifyIntelligentCaptchaRequest({ captchaVerifyParam, sceneId })
        );
        if (response?.body?.result?.verifyResult !== true) {
          throw new HumanVerificationError(422, "人机验证未通过，请重试");
        }
        return true;
      } catch (error) {
        if (error instanceof HumanVerificationError) throw error;
        try {
          logger.warn?.("Aliyun captcha verification failed");
        } catch {}
        throw new HumanVerificationError(422, "人机验证未通过，请重试");
      }
    }
  };
}
