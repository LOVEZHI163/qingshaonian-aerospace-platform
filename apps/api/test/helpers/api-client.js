import assert from "node:assert/strict";

export async function loginAs(baseUrl, phone, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, payload.error || "登录失败");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.match(cookie || "", /^aerogp\.sid=/);
  return { cookie, user: payload.user };
}

export const withSession = (cookie, options = {}) => ({
  ...options,
  headers: { ...(options.headers || {}), Cookie: cookie }
});
