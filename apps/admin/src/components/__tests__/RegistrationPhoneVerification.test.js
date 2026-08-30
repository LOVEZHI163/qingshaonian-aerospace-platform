import { defineComponent, nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, captchaExecute } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  captchaExecute: vi.fn()
}));

vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import RegistrationPhoneVerification from "../RegistrationPhoneVerification.vue";

const CaptchaGateStub = defineComponent({
  name: "AliyunCaptchaGate",
  inheritAttrs: false,
  props: {
    enabled: Boolean,
    region: String,
    prefix: String,
    sceneId: String
  },
  setup(_, { expose }) {
    expose({ execute: captchaExecute });
    return {};
  },
  template: '<div data-testid="registration-captcha-gate"></div>'
});

async function mountVerification(overrides = {}) {
  let wrapper;
  wrapper = mount(RegistrationPhoneVerification, {
    props: {
      enabled: true,
      phone: "",
      phoneVerificationToken: "",
      captcha: {
        enabled: true,
        region: "cn",
        prefix: "captcha-prefix",
        sceneId: "registration-scene"
      },
      "onUpdate:phone": (phone) => wrapper.setProps({ phone }),
      "onUpdate:phoneVerificationToken": (phoneVerificationToken) => wrapper.setProps({ phoneVerificationToken }),
      ...overrides
    },
    global: { stubs: { AliyunCaptchaGate: CaptchaGateStub } }
  });
  await nextTick();
  return wrapper;
}

async function verifyPhone(wrapper, token = "signed-registration-token", expiresInMs = 15 * 60 * 1_000) {
  apiMock.mockImplementation(async (path) => {
    if (path === "/api/auth/register/sms/request") {
      return { message: "如果该手机号可用于注册，验证码将发送到该号码" };
    }
    if (path === "/api/auth/register/sms/confirm") {
      return {
        phoneVerificationToken: token,
        expiresAt: new Date(Date.now() + expiresInMs).toISOString()
      };
    }
    return {};
  });
  await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
  await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
  await flushPromises();
  await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
  await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
  await flushPromises();
}

describe("RegistrationPhoneVerification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.mockReset();
    captchaExecute.mockReset().mockResolvedValue("signed-captcha-param");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("requests through the captcha gate, confirms the code, locks the phone, and enforces the resend countdown", async () => {
    const wrapper = await mountVerification();
    await verifyPhone(wrapper);

    expect(captchaExecute).toHaveBeenCalledOnce();
    expect(apiMock).toHaveBeenNthCalledWith(1, "/api/auth/register/sms/request", {
      method: "POST",
      body: JSON.stringify({ phone: "13800000001", captchaVerifyParam: "signed-captcha-param" })
    });
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/auth/register/sms/confirm", {
      method: "POST",
      body: JSON.stringify({ phone: "13800000001", code: "123456" })
    });
    expect(wrapper.text()).toContain("手机号已验证");
    expect(wrapper.get('[data-testid="registration-phone"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="registration-sms-request"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="registration-sms-request"]').text()).toContain("60");
    expect(wrapper.emitted("verified")?.at(-1)).toEqual([{ phone: "13800000001" }]);
    expect(wrapper.emitted("update:phoneVerificationToken")?.at(-1)).toEqual(["signed-registration-token"]);
    expect(wrapper.text()).not.toContain("signed-registration-token");

    wrapper.unmount();
  });

  it("exposes disabled and busy state while a request is pending", async () => {
    let resolveRequest;
    apiMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
    await nextTick();

    const button = wrapper.get('[data-testid="registration-sms-request"]');
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("aria-busy")).toBe("true");
    expect(button.text()).toContain("发送中");

    resolveRequest({ message: "accepted" });
    await flushPromises();
    expect(button.attributes("aria-busy")).toBe("false");
    wrapper.unmount();
  });

  it("invalidates the in-memory credential when it expires", async () => {
    const wrapper = await mountVerification();
    await verifyPhone(wrapper, "short-lived-token", 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(wrapper.emitted("invalidated")?.at(-1)).toEqual([{ reason: "expired" }]);
    expect(wrapper.emitted("update:phoneVerificationToken")?.at(-1)).toEqual([""]);
    expect(wrapper.text()).not.toContain("手机号已验证");
    wrapper.unmount();
  });

  it("invalidates the in-memory credential when editing or changing the parent phone", async () => {
    const editing = await mountVerification();
    await verifyPhone(editing, "edit-token");
    await editing.get('[data-testid="registration-change-phone"]').trigger("click");
    expect(editing.emitted("invalidated")?.at(-1)).toEqual([{ reason: "edit" }]);
    expect(editing.get('[data-testid="registration-phone"]').attributes("disabled")).toBeUndefined();
    editing.unmount();

    const parentChange = await mountVerification();
    await verifyPhone(parentChange, "parent-change-token");
    await parentChange.setProps({ phone: "13900000002" });
    await nextTick();
    expect(parentChange.emitted("invalidated")?.at(-1)).toEqual([{ reason: "phone-changed" }]);
    expect(parentChange.emitted("update:phoneVerificationToken")?.at(-1)).toEqual([""]);
    parentChange.unmount();
  });

  it("clears the parent credential when the component unmounts", async () => {
    const wrapper = await mountVerification();
    await verifyPhone(wrapper, "unmount-token");
    wrapper.unmount();
    expect(wrapper.emitted("invalidated")?.at(-1)).toEqual([{ reason: "unmounted" }]);
    expect(wrapper.emitted("update:phoneVerificationToken")?.at(-1)).toEqual([""]);
  });

  it("never persists or logs credentials, and a remount starts without a credential", async () => {
    const localStorageWrite = vi.spyOn(window.localStorage, "setItem");
    const sessionStorageWrite = vi.spyOn(window.sessionStorage, "setItem");
    const cookieWrite = vi.spyOn(Document.prototype, "cookie", "set");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapper = await mountVerification();

    await verifyPhone(wrapper, "memory-only-registration-token");
    expect(localStorageWrite).not.toHaveBeenCalled();
    expect(sessionStorageWrite).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    wrapper.unmount();

    const remounted = await mountVerification();
    expect(remounted.text()).not.toContain("手机号已验证");
    expect(remounted.props("phoneVerificationToken")).toBe("");
    remounted.unmount();
  });

  it("hides unavailable SMS controls and explains that registration is unavailable", async () => {
    const wrapper = await mountVerification({ enabled: false });

    expect(wrapper.find('[data-testid="registration-sms-request"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="registration-sms-code"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("注册暂不可用");
    wrapper.unmount();
  });
});
