import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import AuthPage from "../AuthPage.vue";

describe("AuthPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({ smsPasswordResetEnabled: false });
  });

  it("uses the official brand identity and separates the current event", () => {
    const wrapper = mount(AuthPage, { props: { eventName: "测试赛事" } });

    expect(wrapper.get(".auth-brand-mark img").attributes("src")).toBe("/brand/mark.svg");
    expect(wrapper.get(".auth-brand-kicker").text()).toBe("温州青少年航空");
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
