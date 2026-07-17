import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, api, apiBlob, setPasswordChangeRequiredHandler, setUnauthorizedHandler } from "../api.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
  setPasswordChangeRequiredHandler(null);
});

describe("api", () => {
  it("sends JSON with the session cookie and parses the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/api/example", { method: "POST", body: JSON.stringify({ name: "赛事" }) })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/example", expect.objectContaining({
      credentials: "include",
      headers: expect.objectContaining({ "Content-Type": "application/json" })
    }));
  });

  it("does not set a content type for FormData", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = new FormData();

    await api("/api/upload", { method: "POST", body });

    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
  });

  it("fetches credential blobs with the session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("file", { status: 200, headers: { "Content-Type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiBlob("/api/credential")).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith("/api/credential", expect.objectContaining({ credentials: "include" }));
  });

  it("routes 401 to logout and 428 to forced password change", async () => {
    const unauthorized = vi.fn();
    const passwordChangeRequired = vi.fn();
    setUnauthorizedHandler(unauthorized);
    setPasswordChangeRequiredHandler(passwordChangeRequired);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "请登录", code: "AUTH_REQUIRED" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "请先修改密码", code: "PASSWORD_CHANGE_REQUIRED" }), { status: 428 })));

    const first = await api("/api/private").catch((error) => error);
    const second = await api("/api/private").catch((error) => error);

    expect(first).toBeInstanceOf(ApiError);
    expect(first).toMatchObject({ status: 401, code: "AUTH_REQUIRED", message: "请登录" });
    expect(second).toMatchObject({ status: 428, code: "PASSWORD_CHANGE_REQUIRED" });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(passwordChangeRequired).toHaveBeenCalledTimes(1);
  });
});
