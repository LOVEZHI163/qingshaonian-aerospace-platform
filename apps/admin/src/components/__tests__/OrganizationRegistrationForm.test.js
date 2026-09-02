import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import OrganizationRegistrationForm from "../OrganizationRegistrationForm.vue";

const credential = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "credential.png", { type: "image/png" });

function attachCredential(wrapper) {
  const input = wrapper.get('[data-testid="organization-credential"]');
  Object.defineProperty(input.element, "files", { configurable: true, value: [credential] });
  return input.trigger("change");
}

async function fillPublicForm(wrapper) {
  await wrapper.get('[data-testid="organization-owner-name"]').setValue("领队老师");
  await wrapper.get('[data-testid="organization-phone"]').setValue("13800000011");
  await wrapper.get('[data-testid="organization-password"]').setValue("Secret123");
  await wrapper.get('[data-testid="organization-name"]').setValue("测试学校");
  await wrapper.get('[data-testid="organization-credit-code"]').setValue("91330300TEST000001");
  await attachCredential(wrapper);
}

async function completePhoneVerification(wrapper) {
  await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
  await flushPromises();
  await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
  await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
  await flushPromises();
}

describe("OrganizationRegistrationForm", () => {
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
      if (path === "/api/auth/register/organization") return { user: { id: "U-ORG" } };
      if (path === "/api/me/organization") return { user: { id: "U-ORG" } };
      return {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("submits the verified-phone credential in organization FormData", async () => {
    const wrapper = mount(OrganizationRegistrationForm, {
      props: { smsRegistrationEnabled: true, captcha: { enabled: false, region: "cn", prefix: "", sceneId: "" } }
    });
    await fillPublicForm(wrapper);
    await completePhoneVerification(wrapper);
    await wrapper.get('[data-register="organization"]').trigger("submit");
    await flushPromises();

    const registrationCall = apiMock.mock.calls.find(([path]) => path === "/api/auth/register/organization");
    expect(registrationCall).toBeTruthy();
    const formData = registrationCall[1].body;
    expect(formData.get("phoneVerificationToken")).toBe("signed-registration-token");
    expect(formData.get("phone")).toBe("13800000011");
    expect(formData.get("credential")).toBe(credential);
    wrapper.unmount();
  });

  it("does not send a public organization registration without an in-memory credential", async () => {
    const wrapper = mount(OrganizationRegistrationForm, { props: { smsRegistrationEnabled: true } });
    await fillPublicForm(wrapper);
    await wrapper.get('[data-register="organization"]').trigger("submit");
    await flushPromises();

    expect(apiMock.mock.calls.some(([path]) => path === "/api/auth/register/organization")).toBe(false);
    expect(wrapper.emitted("error")?.at(-1)).toEqual(["请先完成手机号验证"]);
    wrapper.unmount();
  });

  it("clears the public organization credential when the server reports credential expiry", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/auth/register/sms/request") return { message: "accepted" };
      if (path === "/api/auth/register/sms/confirm") {
        return {
          phoneVerificationToken: "signed-registration-token",
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString()
        };
      }
      if (path === "/api/auth/register/organization") throw new Error("手机号验证已过期，请重新验证");
      return {};
    });
    const wrapper = mount(OrganizationRegistrationForm, { props: { smsRegistrationEnabled: true } });
    await fillPublicForm(wrapper);
    await completePhoneVerification(wrapper);
    await wrapper.get('[data-register="organization"]').trigger("submit");
    await flushPromises();

    expect(wrapper.emitted("error")?.at(-1)).toEqual(["手机号验证已过期，请重新验证"]);
    expect(wrapper.text()).not.toContain("手机号已验证");
    expect(wrapper.get('[data-testid="organization-submit"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("keeps the authenticated organization resubmission path independent from SMS registration", async () => {
    const wrapper = mount(OrganizationRegistrationForm, {
      props: {
        endpoint: "/api/me/organization",
        method: "PATCH",
        submitLabel: "重新提交组织资料",
        resubmission: true,
        smsRegistrationEnabled: false,
        initialForm: { organizationName: "修改后的学校", creditCode: "91330300TEST000001" }
      }
    });
    await attachCredential(wrapper);
    await wrapper.get('[data-register="organization"]').trigger("submit");
    await flushPromises();

    const resubmissionCall = apiMock.mock.calls.find(([path]) => path === "/api/me/organization");
    expect(resubmissionCall).toBeTruthy();
    expect(resubmissionCall[1].method).toBe("PATCH");
    expect(resubmissionCall[1].body.has("phoneVerificationToken")).toBe(false);
    expect(wrapper.find('[data-testid="registration-sms-request"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
