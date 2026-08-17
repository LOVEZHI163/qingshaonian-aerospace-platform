import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import AuthPage from "../AuthPage.vue";

describe("AuthPage", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/admin/");
    apiMock.mockReset();
    apiMock.mockResolvedValue({ smsPasswordResetEnabled: false });
  });

  it("requests an email password-reset link without revealing account existence", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/features") return { emailPasswordResetEnabled: true, smsPasswordResetEnabled: true };
      if (path === "/api/auth/password-reset/email/request") return { message: "如果邮箱已绑定，重置邮件将很快发出" };
      return {};
    });
    const wrapper = mount(AuthPage);
    await flushPromises();
    await wrapper.get('[data-auth-view="forgot"]').trigger("click");
    await wrapper.get('[data-reset-method="email"]').trigger("click");
    await wrapper.get('[data-testid="reset-email"]').setValue("user@example.com");
    await wrapper.get('[data-testid="email-reset-request"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/auth/password-reset/email/request", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "user@example.com", captchaVerifyParam: "" })
    }));
    expect(wrapper.text()).toContain("如果邮箱已绑定");
  });

  it("shows SMS login only when enabled and emits a successful existing-account login", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/features") return {
        smsLoginEnabled: true,
        smsPasswordResetEnabled: true,
        emailPasswordResetEnabled: true,
        captcha: { enabled: false, region: "cn", prefix: "", scenes: {} }
      };
      if (path === "/api/auth/sms-login/request") return { message: "如果该手机号已注册，验证码将发送到该号码" };
      return {};
    });
    const wrapper = mount(AuthPage);
    await flushPromises();
    await wrapper.get('[data-login-method="sms"]').trigger("click");
    await wrapper.get('[data-testid="sms-login-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="sms-login-send"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/auth/sms-login/request", expect.objectContaining({
      body: JSON.stringify({ phone: "13800000001", captchaVerifyParam: "" })
    }));
    expect(wrapper.text()).toContain("重新发送（60s）");
    await wrapper.get('[data-testid="sms-login-code"]').setValue("123456");
    await wrapper.get('[data-auth-form="sms-login"]').trigger("submit");
    expect(wrapper.emitted("sms-login")).toEqual([[{ phone: "13800000001", code: "123456" }]]);
  });

  it("keeps SMS login hidden when its feature gate is disabled", async () => {
    const wrapper = mount(AuthPage);
    await flushPromises();
    expect(wrapper.find('[data-login-method="sms"]').exists()).toBe(false);
  });

  it("opens a valid email reset link and submits the new password", async () => {
    window.history.replaceState({}, "", "/admin/?view=resetPassword&token=reset-token");
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/features") return { emailPasswordResetEnabled: true };
      if (path.startsWith("/api/auth/password-reset/email/verify")) return { ok: true };
      if (path === "/api/auth/password-reset/email/confirm") return { message: "密码已重置，请登录" };
      return {};
    });
    const wrapper = mount(AuthPage);
    await flushPromises();

    expect(wrapper.get('[data-auth-form="email-reset-confirm"]').exists()).toBe(true);
    await wrapper.get('[data-testid="reset-new-password"]').setValue("NewPassword123!");
    await wrapper.get('[data-testid="reset-confirm-password"]').setValue("NewPassword123!");
    await wrapper.get('[data-auth-form="email-reset-confirm"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/auth/password-reset/email/confirm", expect.objectContaining({ method: "POST" }));
    expect(wrapper.emitted("account-email-action-complete")).toHaveLength(1);
    expect(wrapper.get('[data-auth-form="login"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("密码已重置，请登录");
  });

  it("checks a verification link before explicit confirmation", async () => {
    window.history.replaceState({}, "", "/admin/?view=verifyEmail&token=verify-token");
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/public/features") return { emailPasswordResetEnabled: true };
      if (path.startsWith("/api/auth/email/verification/verify")) return { ok: true, email: "user@example.com" };
      if (path === "/api/auth/email/verification/confirm") return { message: "邮箱验证成功" };
      return {};
    });
    const wrapper = mount(AuthPage);
    await flushPromises();

    expect(apiMock).not.toHaveBeenCalledWith("/api/auth/email/verification/confirm", expect.anything());
    await wrapper.get('[data-testid="confirm-email-verification"]').trigger("click");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/auth/email/verification/confirm", expect.objectContaining({ method: "POST" }));
    expect(wrapper.text()).toContain("邮箱验证成功");
  });

  it("uses the official brand identity and separates the current event", () => {
    const wrapper = mount(AuthPage, { props: { eventName: "测试赛事" } });

    expect(wrapper.get(".auth-brand-mark img").attributes("src")).toBe("/brand/mark.svg");
    expect(wrapper.find(".auth-brand-kicker").exists()).toBe(false);
    expect(wrapper.get(".auth-brand-copy").text()).toBe("赛事报名系统");
    expect(wrapper.get("h1").text()).toBe("赛事报名系统");
    expect(wrapper.get(".auth-event-context").text()).toContain("测试赛事");
  });

  it("shows only the selected registration path", async () => {
    const wrapper = mount(AuthPage);
    await wrapper.get('[data-auth-tab="register"]').trigger("click");

    expect(wrapper.find('[data-register="ordinary"]').exists()).toBe(true);
    expect(wrapper.find('[data-register="organization"]').exists()).toBe(false);
    await wrapper.get('[data-register-type="organization"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-register-type="organization"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.find('[data-register="ordinary"]').exists()).toBe(false);
    expect(wrapper.find('[data-register="organization"]').exists()).toBe(true);
    await wrapper.get('[data-register-type="ordinary"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-register="ordinary"]').exists()).toBe(true);
    expect(wrapper.find('[data-register="organization"]').exists()).toBe(false);
  });

  it("renders a login error next to the password and clears it while editing", async () => {
    const wrapper = mount(AuthPage, { props: { loginError: "手机号或密码错误" } });

    expect(wrapper.get('[data-testid="login-error"]').text()).toContain("手机号或密码错误");
    expect(wrapper.get('input[type="password"]').attributes("aria-invalid")).toBe("true");

    await wrapper.get('input[type="password"]').setValue("new-password");
    expect(wrapper.emitted("clear-message")).toHaveLength(1);
  });

  it("returns to login after ordinary registration without creating a session", async () => {
    apiMock.mockResolvedValueOnce({ user: { id: "U2" } });
    const wrapper = mount(AuthPage);
    await wrapper.get('[data-auth-tab="register"]').trigger("click");
    await wrapper.get('[data-testid="ordinary-name"]').setValue("张三家长");
    await wrapper.get('[data-testid="ordinary-phone"]').setValue("13800000001");
    await wrapper.get('[data-testid="ordinary-password"]').setValue("Secret123");
    await wrapper.get('[data-register="ordinary"]').trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/auth/register/ordinary", expect.objectContaining({ method: "POST" }));
    expect(wrapper.get('[data-auth-form="login"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("注册成功，请登录");
  });

  it("normalizes the organization credit code to uppercase", async () => {
    const wrapper = mount(AuthPage);
    await wrapper.get('[data-auth-tab="register"]').trigger("click");
    await wrapper.get('[data-register-type="organization"]').trigger("click");
    await wrapper.get('[data-testid="organization-credit-code"]').setValue("91330300test000001");
    expect(wrapper.get('[data-testid="organization-credit-code"]').element.value).toBe("91330300TEST000001");
  });
});
