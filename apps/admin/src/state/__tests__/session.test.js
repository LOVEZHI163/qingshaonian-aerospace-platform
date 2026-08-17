import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, passwordChangeHook } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  passwordChangeHook: { handler: null }
}));
vi.mock("../../lib/api.js", () => ({
  api: apiMock,
  setUnauthorizedHandler: vi.fn(),
  setPasswordChangeRequiredHandler: vi.fn((handler) => { passwordChangeHook.handler = handler; })
}));

import { useSession } from "../session.js";

describe("session state", () => {
  beforeEach(() => {
    apiMock.mockReset();
    useSession().clear();
  });

  it("restores the user and organizations before leaving loading state", async () => {
    apiMock.mockResolvedValue({ user: { id: "U1", type: "admin" }, organizations: [{ id: "O1" }] });

    await useSession().restore();

    expect(useSession().user.value.id).toBe("U1");
    expect(useSession().organizations.value).toHaveLength(1);
    expect(useSession().restoring.value).toBe(false);
  });

  it.each([
    Object.assign(new Error("server failure"), { status: 500 }),
    new TypeError("Failed to fetch")
  ])("fails closed for organization access when restore fails: %s", async (failure) => {
    useSession().setUser({ id: "OU1", type: "organization" }, [{ id: "O1", reviewStatus: "approved", status: "active" }]);
    apiMock.mockRejectedValue(failure);

    await useSession().restore();

    expect(useSession().user.value).toEqual(expect.objectContaining({ id: "OU1", type: "organization" }));
    expect(useSession().organizations.value).toEqual([]);
    expect(useSession().organizationAccess.value).toMatchObject({ operational: false, code: "ORGANIZATION_OWNER_REQUIRED" });
  });

  it("clears local session even if logout fails", async () => {
    useSession().setUser({ id: "U1" }, []);
    apiMock.mockRejectedValue(new Error("network"));

    await useSession().logout();

    expect(useSession().user.value).toBeNull();
  });

  it("keeps the user and marks the session for forced password change on 428", () => {
    useSession().setUser({ id: "U1", type: "admin", mustChangePassword: false }, []);

    passwordChangeHook.handler();

    expect(useSession().user.value).toEqual(expect.objectContaining({ id: "U1", mustChangePassword: true }));
  });

  it("loads the account-visible event rows for URL authorization", async () => {
    apiMock.mockResolvedValue({ rows: [{ event: { id: "E2", slug: "spring-cup" } }] });

    await useSession().loadAccountEvents();

    expect(useSession().accountEvents.value).toEqual([{ event: { id: "E2", slug: "spring-cup" } }]);
  });

  it("establishes the same local session after an SMS login", async () => {
    apiMock.mockResolvedValue({
      user: { id: "U2", type: "ordinary", name: "短信用户" },
      organizations: [{ id: "O2", name: "测试学校" }]
    });

    const loggedIn = await useSession().loginWithSms({ phone: "13800000001", code: "123456" });

    expect(apiMock).toHaveBeenCalledWith("/api/auth/sms-login/confirm", {
      method: "POST",
      body: JSON.stringify({ phone: "13800000001", code: "123456" })
    });
    expect(loggedIn).toEqual(expect.objectContaining({ id: "U2" }));
    expect(useSession().user.value).toEqual(expect.objectContaining({ id: "U2" }));
    expect(useSession().organizations.value).toEqual([{ id: "O2", name: "测试学校" }]);
  });
});
