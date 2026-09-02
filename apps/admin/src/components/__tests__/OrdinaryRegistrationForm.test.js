import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import OrdinaryRegistrationForm from "../OrdinaryRegistrationForm.vue";

async function completePhoneVerification(wrapper) {
  await wrapper.get('[data-testid="ordinary-phone"]').setValue("13800000001");
  await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
  await flushPromises();
  await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
  await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
  await flushPromises();
}

function enabledProps() {
  return {
    smsRegistrationEnabled: true,
    captcha: { enabled: false, region: "cn", prefix: "", sceneId: "" }
  };
}

describe("OrdinaryRegistrationForm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.mockReset();
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/auth/register/sms/request") return { message: "accepted" };
      if (path === "/api/auth/register/sms/confirm") {
        return {
          phoneVerificationToken: "signed-registration-token",
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
        };
      }
      if (path === "/api/auth/register/ordinary") return { user: { id: "U2", phone: "13800000001" } };
      return {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("submits the verified-phone credential in the ordinary JSON body", async () => {
    const wrapper = mount(OrdinaryRegistrationForm, { props: enabledProps() });
    await wrapper.get('[data-testid="ordinary-name"]').setValue("张三家长");
    await wrapper.get('[data-testid="ordinary-password"]').setValue("Secret123");
    await completePhoneVerification(wrapper);
    await wrapper.get('[data-register="ordinary"]').trigger("submit");
    await flushPromises();

    const registrationCall = apiMock.mock.calls.find(([path]) => path === "/api/auth/register/ordinary");
    expect(registrationCall).toBeTruthy();
    expect(JSON.parse(registrationCall[1].body)).toEqual({
      name: "张三家长",
      phone: "13800000001",
      password: "Secret123",
      phoneVerificationToken: "signed-registration-token"
    });
    expect(wrapper.emitted("registered")).toEqual([[{ id: "U2", phone: "13800000001" }]]);
    wrapper.unmount();
  });

  it("does not send the final registration when the in-memory credential is missing or registration is disabled", async () => {
    const wrapper = mount(OrdinaryRegistrationForm, { props: enabledProps() });
    await wrapper.get('[data-register="ordinary"]').trigger("submit");
    await flushPromises();
    expect(apiMock.mock.calls.some(([path]) => path === "/api/auth/register/ordinary")).toBe(false);
    expect(wrapper.emitted("error")?.at(-1)).toEqual(["请先完成手机号验证"]);
    wrapper.unmount();

    const disabled = mount(OrdinaryRegistrationForm, { props: { smsRegistrationEnabled: false } });
    expect(disabled.text()).toContain("注册暂不可用");
    expect(disabled.get('[data-testid="ordinary-submit"]').attributes("disabled")).toBeDefined();
    expect(disabled.find('[data-testid="registration-sms-request"]').exists()).toBe(false);
    disabled.unmount();
  });

  it("clears the credential and requires re-verification when the server reports credential expiry", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/auth/register/sms/request") return { message: "accepted" };
      if (path === "/api/auth/register/sms/confirm") {
        return {
          phoneVerificationToken: "signed-registration-token",
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
        };
      }
      if (path === "/api/auth/register/ordinary") throw new Error("手机号验证已过期，请重新验证");
      return {};
    });
    const wrapper = mount(OrdinaryRegistrationForm, { props: enabledProps() });
    await wrapper.get('[data-testid="ordinary-name"]').setValue("张三家长");
    await wrapper.get('[data-testid="ordinary-password"]').setValue("Secret123");
    await completePhoneVerification(wrapper);
    await wrapper.get('[data-register="ordinary"]').trigger("submit");
    await flushPromises();

    expect(wrapper.emitted("error")?.at(-1)).toEqual(["手机号验证已过期，请重新验证"]);
    expect(wrapper.text()).not.toContain("手机号已验证");
    expect(wrapper.get('[data-testid="ordinary-submit"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
