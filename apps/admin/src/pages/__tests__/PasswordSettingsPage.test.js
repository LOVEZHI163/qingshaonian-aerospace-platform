import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import PasswordSettingsPage from "../PasswordSettingsPage.vue";

describe("PasswordSettingsPage", () => {
  beforeEach(() => apiMock.mockReset());

  it("requires matching confirmation before changing the password", async () => {
    const wrapper = mount(PasswordSettingsPage);
    await wrapper.get('[name="currentPassword"]').setValue("OldPass1");
    await wrapper.get('[name="newPassword"]').setValue("NextPass2");
    await wrapper.get('[name="confirmPassword"]').setValue("Different3");
    await wrapper.get("form").trigger("submit");

    expect(apiMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("两次输入的新密码不一致");
  });

  it.each([
    ["Short1", "密码至少 8 位"],
    ["12345678", "密码必须同时包含字母和数字"],
    ["OnlyLetters", "密码必须同时包含字母和数字"],
    [`A1${"x".repeat(63)}`, "密码最多 64 位"]
  ])("rejects an invalid new password before calling the API: %s", async (newPassword, expectedMessage) => {
    const wrapper = mount(PasswordSettingsPage);
    await wrapper.get('[name="currentPassword"]').setValue("OldPass1");
    await wrapper.get('[name="newPassword"]').setValue(newPassword);
    await wrapper.get('[name="confirmPassword"]').setValue(newPassword);
    await wrapper.get("form").trigger("submit");

    expect(apiMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(expectedMessage);
  });

  it("submits only current and new passwords, clears fields, and reports the changed user", async () => {
    const user = { id: "U1", type: "ordinary", mustChangePassword: false };
    apiMock.mockResolvedValue({ user });
    const wrapper = mount(PasswordSettingsPage);
    await wrapper.get('[name="currentPassword"]').setValue("OldPass1");
    await wrapper.get('[name="newPassword"]').setValue("NextPass2");
    await wrapper.get('[name="confirmPassword"]').setValue("NextPass2");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: "OldPass1", newPassword: "NextPass2" })
    });
    expect(wrapper.findAll("input").every((input) => input.element.value === "")).toBe(true);
    expect(wrapper.emitted("changed")?.[0]).toEqual([user]);
    expect(wrapper.text()).toContain("密码修改成功");
  });

  it("keeps forced users on a dedicated password page with an explicit logout action", async () => {
    const wrapper = mount(PasswordSettingsPage, { props: { forced: true } });
    expect(wrapper.text()).toContain("首次登录请修改密码");
    await wrapper.get('[data-action="password-logout"]').trigger("click");
    expect(wrapper.emitted("logout")).toHaveLength(1);
  });

  it("shows account security and sends an email verification request", async () => {
    apiMock.mockResolvedValue({ ok: true });
    const wrapper = mount(PasswordSettingsPage, { props: { user: { phone: "13800000001", email: null, emailVerified: false } } });
    expect(wrapper.text()).toContain("账号安全");
    expect(wrapper.get('[name="phone"]').element.value).toBe("13800000001");
    expect(wrapper.text()).toContain("尚未绑定邮箱");
    await wrapper.get('[name="email"]').setValue("user@example.com");
    await wrapper.get('[name="emailCurrentPassword"]').setValue("OldPass1");
    await wrapper.get('[data-action="bind-email"]').trigger("submit");
    await flushPromises();
    expect(apiMock).toHaveBeenCalledWith("/api/auth/email/verification/request", {
      method: "POST",
      body: JSON.stringify({ email: "user@example.com", currentPassword: "OldPass1" })
    });
    expect(wrapper.text()).toContain("验证邮件已发送");
  });
});
