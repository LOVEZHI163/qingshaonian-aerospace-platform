import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { createFileStore } from "../src/data/file-store.js";
import { createSmsRegistrationRouter } from "../src/routes/sms-registration.js";

const runtimeModule = await import("../src/auth/sms-registration-runtime.js").catch(() => ({}));

async function withHttpRouter(smsRegistration, run) {
  const app = express();
  app.use(express.json());
  app.use("/api", createSmsRegistrationRouter({ smsRegistration }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function requestCode(baseUrl, phone) {
  return fetch(`${baseUrl}/api/auth/register/sms/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, captchaVerifyParam: "captcha-proof" })
  });
}

test("server SMS registration runtime uses latest real store state without enumerating registered roles", async () => {
  assert.equal(typeof runtimeModule.createSmsRegistrationRuntime, "function");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-sms-registration-runtime-"));
  const store = createFileStore(path.join(tempDir, "db.json"));
  const scheduled = [];
  const sent = [];
  let humanChecks = 0;
  try {
    const db = await store.readDb();
    db.users = [
      { id: "U1", phone: "13700000001", type: "ordinary", status: "active" },
      { id: "U2", phone: "13700000002", type: "admin", status: "disabled" },
      { id: "U3", phone: "13700000003", type: "organization", status: "active" }
    ];
    db.organizations = [{ id: "O3", ownerUserId: "U3", reviewStatus: "rejected", status: "disabled" }];
    await store.writeDb(db);

    const { smsRegistration } = runtimeModule.createSmsRegistrationRuntime({
      sessionSecret: "runtime-registration-secret-32-chars",
      readDb: () => store.readDb(),
      smsProvider: {
        enabled: (purpose) => purpose === "sms-registration",
        async sendCode(input) { sent.push(input); }
      },
      authState: store.authState,
      verifyHuman: async ({ scene, captchaVerifyParam }) => {
        humanChecks += 1;
        assert.equal(scene, "sms-registration");
        assert.equal(captchaVerifyParam, "captcha-proof");
        return true;
      },
      clock: () => Date.parse("2026-08-30T00:00:00.000Z"),
      generateCode: () => "123456",
      schedule: (task) => scheduled.push(task)
    });

    const responses = [];
    await withHttpRouter(smsRegistration, async (baseUrl) => {
      const unregistered = await requestCode(baseUrl, "13700000009");
      assert.equal(unregistered.status, 200);
      responses.push(await unregistered.json());
      await scheduled.shift()();
      assert.deepEqual(sent, [{ purpose: "sms-registration", phone: "13700000009", code: "123456" }]);

      for (const phone of ["13700000001", "13700000002", "13700000003"]) {
        const registered = await requestCode(baseUrl, phone);
        assert.equal(registered.status, 200);
        responses.push(await registered.json());
        await scheduled.shift()();
      }
      assert.equal(sent.length, 1);

      const changedAfterRequest = await requestCode(baseUrl, "13700000008");
      assert.equal(changedAfterRequest.status, 200);
      responses.push(await changedAfterRequest.json());
      const latest = await store.readDb();
      latest.users.push({ id: "U8", phone: "13700000008", type: "admin", status: "active" });
      await store.writeDb(latest);
      await scheduled.shift()();
      assert.equal(sent.length, 1);
    });

    assert.equal(humanChecks, 5);
    for (const response of responses) {
      assert.deepEqual(response, {
        ok: true,
        message: "如果该手机号可用于注册，验证码将发送到该号码"
      });
    }
  } finally {
    await store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
