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

  it("keeps ordinary and organization registration values independent", async () => {
    const wrapper = mount(AuthPage);
    await wrapper.get('[data-auth-tab="register"]').trigger("click");
    const ordinaryName = wrapper.get('[data-testid="ordinary-name"]');
    const organizationName = wrapper.get('[data-testid="organization-owner-name"]');

    await ordinaryName.setValue("张三家长");
    expect(organizationName.element.value).toBe("");
    await organizationName.setValue("李老师");
    expect(ordinaryName.element.value).toBe("张三家长");
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
    await wrapper.get('[data-testid="organization-credit-code"]').setValue("91330300test000001");
    expect(wrapper.get('[data-testid="organization-credit-code"]').element.value).toBe("91330300TEST000001");
  });
});
