import DysmsPackage, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";

const DysmsClient = DysmsPackage.default;
const endpoint = "dysmsapi.aliyuncs.com";

export function createAliyunSmsProvider(env, { client: injectedClient } = {}) {
  const smsConfigured = [
    env.ALIYUN_SMS_LOGIN_TEMPLATE_CODE,
    env.ALIYUN_SMS_RESET_TEMPLATE_CODE
  ].some(Boolean);
  const base = [
    env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    env.ALIYUN_SMS_SIGN_NAME
  ];
  const baseConfigured = smsConfigured && base.every(Boolean);
  if (smsConfigured && !baseConfigured) throw new Error("Aliyun SMS configuration is incomplete");
  const templateByPurpose = {
    "sms-login": env.ALIYUN_SMS_LOGIN_TEMPLATE_CODE,
    "sms-password-reset": env.ALIYUN_SMS_RESET_TEMPLATE_CODE
  };

  let client = injectedClient;
  if (baseConfigured && !client) {
    const config = new $OpenApiUtil.Config({
      accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      endpoint
    });
    client = new DysmsClient(config);
  }

  return {
    endpoint,
    enabled(purpose) {
      return Boolean(baseConfigured && templateByPurpose[purpose]);
    },
    async sendCode({ purpose, phone, code }) {
      const templateCode = templateByPurpose[purpose];
      if (!baseConfigured || !templateCode) throw new Error("Aliyun SMS purpose is not configured");
      const response = await client.sendSms(new SendSmsRequest({
        phoneNumbers: phone,
        signName: env.ALIYUN_SMS_SIGN_NAME,
        templateCode,
        templateParam: JSON.stringify({ code })
      }));
      if (response?.body?.code !== "OK") throw new Error("Aliyun SMS delivery failed");
    }
  };
}
