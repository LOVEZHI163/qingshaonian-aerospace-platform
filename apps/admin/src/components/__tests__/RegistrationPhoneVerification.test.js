import { defineComponent, nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, captchaExecute } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  captchaExecute: vi.fn()
}));

vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import RegistrationPhoneVerification from "../RegistrationPhoneVerification.vue";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("does not start a request when the phone changes while captcha is pending", async () => {
    const captchaPending = deferred();
    captchaExecute.mockReturnValue(captchaPending.promise);
    apiMock.mockResolvedValue({ message: "accepted" });
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
    await wrapper.get('[data-testid="registration-phone"]').setValue("13900000002");

    captchaPending.resolve("captcha-for-phone-a");
    await flushPromises();

    expect(apiMock).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="registration-sms-request"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.text()).not.toContain("accepted");
    wrapper.unmount();
  });

  it("keeps a late request response from overwriting a newer phone request", async () => {
    const phoneARequest = deferred();
    const phoneBRequest = deferred();
    apiMock
      .mockImplementationOnce(() => phoneARequest.promise)
      .mockImplementationOnce(() => phoneBRequest.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
    await wrapper.get('[data-testid="registration-phone"]').setValue("13900000002");
    await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(apiMock.mock.calls[0][1].body).phone).toBe("13800000001");
    expect(JSON.parse(apiMock.mock.calls[1][1].body).phone).toBe("13900000002");

    phoneBRequest.resolve({ message: "phone-b-accepted" });
    await flushPromises();
    expect(wrapper.text()).toContain("phone-b-accepted");
    expect(wrapper.get('[data-testid="registration-sms-request"]').text()).toContain("60");

    phoneARequest.resolve({ message: "phone-a-stale" });
    await flushPromises();
    expect(wrapper.text()).toContain("phone-b-accepted");
    expect(wrapper.text()).not.toContain("phone-a-stale");
    wrapper.unmount();
  });

  it("clears a completed request countdown when the phone changes", async () => {
    apiMock.mockResolvedValue({ message: "accepted" });
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="registration-sms-request"]').text()).toContain("60");

    await wrapper.get('[data-testid="registration-phone"]').setValue("13900000002");
    const requestButton = wrapper.get('[data-testid="registration-sms-request"]');
    expect(requestButton.attributes("disabled")).toBeUndefined();
    expect(requestButton.text()).toBe("获取验证码");
    wrapper.unmount();
  });

  it("does not bind a pending confirmation for phone A to a later phone B", async () => {
    const confirmation = deferred();
    apiMock.mockReturnValue(confirmation.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");

    expect(wrapper.get('[data-testid="registration-phone"]').attributes("disabled")).toBeDefined();
    expect(JSON.parse(apiMock.mock.calls[0][1].body)).toEqual({ phone: "13800000001", code: "123456" });
    await wrapper.setProps({ phone: "13900000002" });
    confirmation.resolve({
      phoneVerificationToken: "token-for-phone-a",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();

    expect(wrapper.emitted("verified")).toBeUndefined();
    expect(wrapper.emitted("update:phoneVerificationToken")).toBeUndefined();
    expect(wrapper.text()).not.toContain("手机号已验证");
    expect(wrapper.get('[data-testid="registration-phone"]').element.value).toBe("13900000002");
    wrapper.unmount();
  });

  it("allows only the newest confirmation response to write a credential", async () => {
    const phoneAConfirmation = deferred();
    const phoneBConfirmation = deferred();
    apiMock
      .mockImplementationOnce(() => phoneAConfirmation.promise)
      .mockImplementationOnce(() => phoneBConfirmation.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("111111");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
    await wrapper.setProps({ phone: "13900000002" });
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("222222");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");

    expect(apiMock).toHaveBeenCalledTimes(2);
    phoneBConfirmation.resolve({
      phoneVerificationToken: "token-for-phone-b",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();
    phoneAConfirmation.resolve({
      phoneVerificationToken: "token-for-phone-a",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();

    expect(wrapper.emitted("update:phoneVerificationToken")).toEqual([["token-for-phone-b"]]);
    expect(wrapper.emitted("verified")).toEqual([[{ phone: "13900000002" }]]);
    expect(wrapper.text()).toContain("手机号已验证");
    expect(wrapper.text()).not.toContain("token-for-phone-a");
    wrapper.unmount();
  });

  it("does not revive a pending confirmation after the feature is disabled", async () => {
    const confirmation = deferred();
    apiMock.mockReturnValue(confirmation.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
    await wrapper.setProps({ enabled: false });

    confirmation.resolve({
      phoneVerificationToken: "disabled-feature-token",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();

    expect(wrapper.emitted("verified")).toBeUndefined();
    expect(wrapper.emitted("update:phoneVerificationToken")).toBeUndefined();
    expect(wrapper.text()).toContain("注册暂不可用");
    wrapper.unmount();
  });

  it("does not emit from a pending confirmation after unmount", async () => {
    const confirmation = deferred();
    apiMock.mockReturnValue(confirmation.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
    wrapper.unmount();

    confirmation.resolve({
      phoneVerificationToken: "post-unmount-token",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();

    expect(wrapper.emitted("verified")).toBeUndefined();
    expect(wrapper.emitted("update:phoneVerificationToken")).toBeUndefined();
    expect(wrapper.emitted("error")).toBeUndefined();
  });

  it("does not start duplicate confirmations while one is pending", async () => {
    const confirmation = deferred();
    apiMock.mockReturnValue(confirmation.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");

    expect(apiMock).toHaveBeenCalledTimes(1);
    confirmation.resolve({
      phoneVerificationToken: "single-token",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();
    wrapper.unmount();
  });

  it("locks the code input while a confirmation is pending", async () => {
    const confirmation = deferred();
    apiMock.mockReturnValue(confirmation.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("111111");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");

    expect(wrapper.get('[data-testid="registration-sms-code"]').attributes("disabled")).toBeDefined();
    confirmation.reject(new Error("confirmation finished"));
    await flushPromises();
    wrapper.unmount();
  });

  it("invalidates a pending confirmation when its captured code changes", async () => {
    const oldConfirmation = deferred();
    const newConfirmation = deferred();
    apiMock
      .mockImplementationOnce(() => oldConfirmation.promise)
      .mockImplementationOnce(() => newConfirmation.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    const codeInput = wrapper.get('[data-testid="registration-sms-code"]');
    await codeInput.setValue("111111");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");

    expect(wrapper.get('[data-testid="registration-sms-confirm"]').attributes("aria-busy")).toBe("true");
    codeInput.element.disabled = false;
    codeInput.element.value = "222222";
    await codeInput.trigger("input");
    oldConfirmation.resolve({
      phoneVerificationToken: "stale-code-token",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();

    expect(wrapper.emitted("update:phoneVerificationToken")).toBeUndefined();
    expect(wrapper.emitted("verified")).toBeUndefined();
    expect(wrapper.text()).not.toContain("手机号已验证");
    expect(wrapper.text()).not.toContain("stale-code-token");
    expect(wrapper.get('[data-testid="registration-sms-confirm"]').attributes("disabled")).toBeUndefined();

    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(apiMock.mock.calls[1][1].body)).toEqual({ phone: "13800000001", code: "222222" });
    newConfirmation.resolve({
      phoneVerificationToken: "new-code-token",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();
    expect(wrapper.emitted("update:phoneVerificationToken")?.at(-1)).toEqual(["new-code-token"]);
    wrapper.unmount();
  });

  it("blocks confirmation while a request is pending", async () => {
    const request = deferred();
    apiMock.mockReturnValue(request.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
    await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");

    const confirmButton = wrapper.get('[data-testid="registration-sms-confirm"]');
    expect(confirmButton.attributes("disabled")).toBeDefined();
    await confirmButton.trigger("click");
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0][0]).toBe("/api/auth/register/sms/request");
    expect(wrapper.get('[data-testid="registration-sms-request"]').attributes("aria-busy")).toBe("true");

    request.resolve({ message: "request-complete" });
    await flushPromises();
    expect(confirmButton.attributes("disabled")).toBeUndefined();
    expect(wrapper.text()).toContain("request-complete");
    wrapper.unmount();
  });

  it("blocks requests while a confirmation is pending", async () => {
    const confirmation = deferred();
    apiMock.mockReturnValue(confirmation.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");

    const requestButton = wrapper.get('[data-testid="registration-sms-request"]');
    expect(requestButton.attributes("disabled")).toBeDefined();
    await requestButton.trigger("click");
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0][0]).toBe("/api/auth/register/sms/confirm");

    confirmation.reject(new Error("current confirmation failed"));
    await flushPromises();
    expect(wrapper.text()).toContain("current confirmation failed");
    expect(requestButton.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("keeps a newer request busy when an older request rejects", async () => {
    const phoneARequest = deferred();
    const phoneBRequest = deferred();
    apiMock
      .mockImplementationOnce(() => phoneARequest.promise)
      .mockImplementationOnce(() => phoneBRequest.promise);
    const wrapper = await mountVerification();
    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
    await wrapper.get('[data-testid="registration-phone"]').setValue("13900000002");
    await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");

    phoneARequest.reject(new Error("stale phone A request error"));
    await flushPromises();
    const requestButton = wrapper.get('[data-testid="registration-sms-request"]');
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(requestButton.attributes("aria-busy")).toBe("true");
    expect(requestButton.text()).toBe("发送中…");
    expect(wrapper.text()).not.toContain("stale phone A request error");
    expect(wrapper.text()).not.toContain("重新发送");

    phoneBRequest.resolve({ message: "phone B request accepted" });
    await flushPromises();
    expect(requestButton.attributes("aria-busy")).toBe("false");
    expect(requestButton.text()).toContain("60");
    expect(wrapper.text()).toContain("phone B request accepted");
    wrapper.unmount();
  });

  it("ignores late success and rejection across an A to B to A confirmation sequence", async () => {
    const firstPhoneAConfirmation = deferred();
    const phoneBConfirmation = deferred();
    const newestPhoneAConfirmation = deferred();
    apiMock
      .mockImplementationOnce(() => firstPhoneAConfirmation.promise)
      .mockImplementationOnce(() => phoneBConfirmation.promise)
      .mockImplementationOnce(() => newestPhoneAConfirmation.promise);
    const wrapper = await mountVerification();

    await wrapper.get('[data-testid="registration-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("111111");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
    await wrapper.setProps({ phone: "13900000002" });
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("222222");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
    await wrapper.setProps({ phone: "13800000001" });
    await wrapper.get('[data-testid="registration-sms-code"]').setValue("111111");
    await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");

    expect(apiMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(apiMock.mock.calls[0][1].body)).toEqual({ phone: "13800000001", code: "111111" });
    expect(JSON.parse(apiMock.mock.calls[1][1].body)).toEqual({ phone: "13900000002", code: "222222" });
    expect(JSON.parse(apiMock.mock.calls[2][1].body)).toEqual({ phone: "13800000001", code: "111111" });

    firstPhoneAConfirmation.resolve({
      phoneVerificationToken: "first-phone-a-stale-token",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    phoneBConfirmation.reject(new Error("stale phone B confirmation error"));
    await flushPromises();

    const confirmButton = wrapper.get('[data-testid="registration-sms-confirm"]');
    expect(confirmButton.attributes("aria-busy")).toBe("true");
    expect(confirmButton.text()).toBe("验证中…");
    expect(wrapper.get('[data-testid="registration-sms-code"]').attributes("disabled")).toBeDefined();
    expect(wrapper.emitted("update:phoneVerificationToken")).toBeUndefined();
    expect(wrapper.emitted("verified")).toBeUndefined();
    expect(wrapper.emitted("error")).toBeUndefined();
    expect(wrapper.text()).not.toContain("手机号已验证");
    expect(wrapper.text()).not.toContain("stale phone B confirmation error");

    newestPhoneAConfirmation.resolve({
      phoneVerificationToken: "newest-phone-a-token",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="registration-sms-confirm"]').exists()).toBe(false);
    expect(wrapper.emitted("update:phoneVerificationToken")?.at(-1)).toEqual(["newest-phone-a-token"]);
    expect(wrapper.emitted("verified")?.at(-1)).toEqual([{ phone: "13800000001" }]);
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
    expect(editing.get('[data-testid="registration-sms-request"]').attributes("disabled")).toBeUndefined();
    expect(editing.get('[data-testid="registration-sms-request"]').text()).toBe("获取验证码");
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

  it("does not expose dangling ARIA references and gives each instance unique ids", async () => {
    const disabled = await mountVerification({ enabled: false });
    expect(disabled.get(".registration-phone-verification").attributes("aria-labelledby")).toBeUndefined();
    disabled.unmount();

    const first = await mountVerification();
    const second = await mountVerification();
    const firstSection = first.get(".registration-phone-verification");
    const secondSection = second.get(".registration-phone-verification");
    const firstTitleId = firstSection.attributes("aria-labelledby");
    const secondTitleId = secondSection.attributes("aria-labelledby");
    expect(firstTitleId).toBeTruthy();
    expect(first.get(`#${firstTitleId}`).exists()).toBe(true);
    expect(second.get(`#${secondTitleId}`).exists()).toBe(true);
    expect(firstTitleId).not.toBe(secondTitleId);
    expect(first.get('[data-testid="registration-phone"]').attributes("aria-describedby")).toBeUndefined();
    first.unmount();
    second.unmount();
  });
});
