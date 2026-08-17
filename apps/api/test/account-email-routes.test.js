import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { asyncRoute } from "../src/auth/session.js";
import { createAccountSecurityRouter } from "../src/routes/account-security.js";

async function withRouter(service, run) {
  const app = express();
  app.use(express.json());
  const requireUser = (req, res, next) => {
    if (req.headers.authorization !== "test") return res.status(401).json({ error: "请先登录" });
    req.user = { id: "U1", email: null };
    next();
  };
  app.use("/api", createAccountSecurityRouter({ service, requireUser, asyncRoute }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("account email routes protect binding and expose public reset flow", async () => {
  const calls = [];
  const service = {
    requestVerification: async (input) => { calls.push(input); return { ok: true }; },
    confirmVerification: async () => ({ ok: true }),
    requestPasswordReset: async () => ({ ok: true, message: "uniform" }),
    inspectPasswordReset: async ({ token }) => token === "good" ? { email: "u@example.com" } : null,
    confirmPasswordReset: async () => ({ ok: true })
  };
  await withRouter(service, async (base) => {
    assert.equal((await fetch(`${base}/api/auth/email/verification/request`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    const bound = await fetch(`${base}/api/auth/email/verification/request`, { method: "POST", headers: { "content-type": "application/json", authorization: "test" }, body: JSON.stringify({ email: "u@example.com", currentPassword: "OldPass1" }) });
    assert.equal(bound.status, 200);
    assert.equal(calls[0].userId, "U1");
    assert.equal((await fetch(`${base}/api/auth/password-reset/email/verify?token=bad`)).status, 422);
    assert.equal((await fetch(`${base}/api/auth/password-reset/email/verify?token=good`)).status, 200);
  });
});
