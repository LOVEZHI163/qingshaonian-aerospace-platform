import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ api: apiMock }));

import UserManagementPage from "../UserManagementPage.vue";

describe("UserManagementPage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path, options = {}) => {
      if (path === "/api/users") return { rows: [] };
      if (path === "/api/admin/organizations") return { rows: [] };
      if (path === "/api/admin/users" && options.method === "POST") {
        return {
          row: { id: "U-NEW", name: "新用户", phone: "13800009999", type: "ordinary", status: "active", mustChangePassword: true },
          organization: null,
          temporaryPassword: "GeneratedPass2"
        };
      }
      return { rows: [] };
    });
  });

  it("creates an ordinary user without an administrator-chosen password and displays the generated temporary password", async () => {
    const wrapper = mount(UserManagementPage);
    await flushPromises();

    const form = wrapper.get("form");
    expect(form.find('input[type="password"]').exists()).toBe(false);
    const inputs = form.findAll("input");
    await inputs[0].setValue("新用户");
    await inputs[1].setValue("13800009999");
    await form.trigger("submit");
    await flushPromises();

    expect(apiMock).toHaveBeenCalledWith("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        name: "新用户", phone: "13800009999", type: "ordinary", status: "active",
        organizationName: "", organizationCode: ""
      })
    });
    expect(wrapper.get('[data-testid="temporary-password-dialog"]').text()).toContain("GeneratedPass2");
  });
});
