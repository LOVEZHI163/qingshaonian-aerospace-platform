import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
  api: apiMock,
  setUnauthorizedHandler: vi.fn()
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
});
