import DysmsPackage, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";

const DysmsClient = DysmsPackage.default;
const endpoint = "dysmsapi.aliyuncs.com";

export function createAliyunSmsProvider(env, { client: injectedClient } = {}) {
  const required = [
    env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    env.ALIYUN_SMS_SIGN_NAME,
    env.ALIYUN_SMS_TEMPLATE_CODE
  ];
  if (required.every((value) => !value)) return null;
  if (required.some((value) => !value)) throw new Error("Aliyun SMS configuration is incomplete");

  const config = new $OpenApiUtil.Config({
    accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    endpoint
  });
  const client = injectedClient || new DysmsClient(config);

  return {
    endpoint,
    async sendCode({ phone, code }) {
      const response = await client.sendSms(new SendSmsRequest({
        phoneNumbers: phone,
        signName: env.ALIYUN_SMS_SIGN_NAME,
        templateCode: env.ALIYUN_SMS_TEMPLATE_CODE,
        templateParam: JSON.stringify({ code })
      }));
      if (response?.body?.code && response.body.code !== "OK") throw new Error("Aliyun SMS delivery failed");
    }
  };
}
