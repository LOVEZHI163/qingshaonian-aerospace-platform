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

  it("does not expose HTML error documents to users", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<!DOCTYPE html><html><body><pre>Cannot GET /api/admin/registrations</pre></body></html>",
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
    )));

    await expect(api("/api/admin/registrations")).rejects.toMatchObject({
      status: 404,
      message: "服务暂时不可用，请刷新后重试 (404)"
    });
  });

  it("keeps JSON business errors but normalizes proxy text errors", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "赛事不存在" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response("Bad Gateway", {
        status: 502,
        headers: { "Content-Type": "text/plain" }
      })));

    await expect(api("/api/events/E404")).rejects.toMatchObject({ message: "赛事不存在" });
    await expect(api("/api/events/E1")).rejects.toMatchObject({
      message: "服务暂时不可用，请刷新后重试 (502)"
    });
  });

  it("normalizes non-JSON apiBlob errors without changing JSON error details", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "无法导出", code: "EXPORT_FAILED" }), {
        status: 422,
        headers: { "Content-Type": "application/json" }
      })));

    await expect(apiBlob("/api/export")).rejects.toMatchObject({
      status: 503,
      code: "",
      payload: {},
      message: "服务暂时不可用，请刷新后重试 (503)"
    });
    await expect(apiBlob("/api/export")).rejects.toMatchObject({
      status: 422,
      code: "EXPORT_FAILED",
      payload: { error: "无法导出", code: "EXPORT_FAILED" },
      message: "无法导出"
    });
  });

  it("fetches credential blobs with the session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("file", { status: 200, headers: { "Content-Type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiBlob("/api/credential")).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith("/api/credential", expect.objectContaining({ credentials: "include" }));
  });

  it("reads an RFC5987 UTF-8 filename from blob responses and ignores unsafe filename headers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("file", {
        status: 200,
        headers: { "Content-Disposition": "attachment; filename=certificate.pdf; filename*=UTF-8''%E5%BC%A0%E4%B8%89_%E7%BA%B8%E9%A3%9E%E6%9C%BA_%E4%B8%80%E7%AD%89%E5%A5%96.pdf" }
      }))
      .mockResolvedValueOnce(new Response("file", {
        status: 200,
        headers: { "Content-Disposition": "attachment; filename=../../unsafe.pdf" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const named = await apiBlob("/api/certificate");
    const unsafe = await apiBlob("/api/certificate");

    expect(named.fileName).toBe("张三_纸飞机_一等奖.pdf");
    expect(unsafe.fileName).toBeUndefined();
  });

  it("routes 401 to logout and 428 to forced password change", async () => {
    const unauthorized = vi.fn();
    const passwordChangeRequired = vi.fn();
    setUnauthorizedHandler(unauthorized);
    setPasswordChangeRequiredHandler(passwordChangeRequired);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "请登录", code: "AUTH_REQUIRED" }), { status: 401, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "请先修改密码", code: "PASSWORD_CHANGE_REQUIRED" }), { status: 428, headers: { "Content-Type": "application/json" } })));

    const first = await api("/api/private").catch((error) => error);
    const second = await api("/api/private").catch((error) => error);

    expect(first).toBeInstanceOf(ApiError);
    expect(first).toMatchObject({ status: 401, code: "AUTH_REQUIRED", message: "请登录" });
    expect(second).toMatchObject({ status: 428, code: "PASSWORD_CHANGE_REQUIRED" });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(passwordChangeRequired).toHaveBeenCalledTimes(1);
  });

  it("routes apiBlob 401 and 428 through the same session handlers", async () => {
    const unauthorized = vi.fn();
    const passwordChangeRequired = vi.fn();
    setUnauthorizedHandler(unauthorized);
    setPasswordChangeRequiredHandler(passwordChangeRequired);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "请登录", code: "AUTH_REQUIRED" }), { status: 401, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "请先修改密码", code: "PASSWORD_CHANGE_REQUIRED" }), { status: 428, headers: { "Content-Type": "application/json" } })));

    await expect(apiBlob("/api/credential")).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    await expect(apiBlob("/api/credential")).rejects.toMatchObject({ status: 428, code: "PASSWORD_CHANGE_REQUIRED" });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(passwordChangeRequired).toHaveBeenCalledTimes(1);
  });
});
