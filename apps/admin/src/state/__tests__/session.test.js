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
});
