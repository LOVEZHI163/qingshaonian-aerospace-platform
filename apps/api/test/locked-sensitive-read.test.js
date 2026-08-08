import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashPassword } from "../src/auth/passwords.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const withTimeout = (promise, milliseconds = 5_000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("operation timed out")), milliseconds))
]);

const SENSITIVE_ENVIRONMENT_ALLOWLIST = [
  "NODE_ENV",
  "PORT",
  "DB_PATH",
  "UPLOAD_ROOT",
  "TEMP_PASSWORD_ENCRYPTION_KEY",
  "REGISTRATION_ID_ENCRYPTION_KEY",
  "SESSION_SECRET"
];

test("a queued temporary-password read revalidates the administrator session inside the shared store lock", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-locked-secret-read-"));
  const previousEnv = Object.fromEntries(
    SENSITIVE_ENVIRONMENT_ALLOWLIST.map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, {
    NODE_ENV: "test",
    PORT: "0",
    DB_PATH: path.join(tempDir, "db.json"),
    UPLOAD_ROOT: path.join(tempDir, "uploads"),
    TEMP_PASSWORD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    REGISTRATION_ID_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
    SESSION_SECRET: "locked-secret-read-session-secret"
  });

  let server;
  let dataStore;
  let originalWithMutationLock;
  let releaseOldRead;
  try {
    ({ server, dataStore } = await import(`../src/server.js?locked-sensitive-read=${Date.now()}`));
    if (!server.listening) await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    originalWithMutationLock = dataStore.withMutationLock.bind(dataStore);

    await originalWithMutationLock(async () => {
      const db = await dataStore.readDb();
      db.users.push({
        id: "U9002", name: "复核管理员", phone: "13900000002",
        password: await hashPassword("AdminTwo123"), type: "admin", status: "active",
        sessionVersion: 0, mustChangePassword: false, createdAt: "2026-08-06T00:00:00.000Z"
      });
      await dataStore.writeDb(db);
    });

    const staleAdmin = await loginAs(baseUrl, "13900000000", "admin123");
    const resettingAdmin = await loginAs(baseUrl, "13900000002", "AdminTwo123");
    const targetReset = await fetch(`${baseUrl}/api/admin/users/U1001/reset-password`, withSession(resettingAdmin.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    }));
    assert.equal(targetReset.status, 200);
    const targetTemporaryPassword = (await targetReset.json()).temporaryPassword;
    const before = await dataStore.readDb();
    const viewAuditCount = before.auditLogs.filter((row) => row.action === "user.temporary-password-view").length;

    let signalOldReadEntered;
    const oldReadEntered = new Promise((resolve) => { signalOldReadEntered = resolve; });
    const oldReadReleased = new Promise((resolve) => { releaseOldRead = resolve; });
    let interceptFirstLock = true;
    dataStore.withMutationLock = async (handler) => {
      if (interceptFirstLock) {
        interceptFirstLock = false;
        signalOldReadEntered();
        await oldReadReleased;
      }
      return originalWithMutationLock(handler);
    };

    const staleReadPromise = fetch(
      `${baseUrl}/api/admin/users/U1001/temporary-password`,
      withSession(staleAdmin.cookie)
    );
    await withTimeout(oldReadEntered);

    const invalidateResponse = await withTimeout(fetch(
      `${baseUrl}/api/admin/users/U9001/reset-password`,
      withSession(resettingAdmin.cookie, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      })
    ));
    assert.equal(invalidateResponse.status, 200);
    releaseOldRead();

    const staleRead = await withTimeout(staleReadPromise);
    const stalePayload = await staleRead.json();
    assert.equal(staleRead.status, 401);
    assert.equal(stalePayload.code, "SESSION_INVALIDATED");
    assert.equal(Object.hasOwn(stalePayload, "temporaryPassword"), false);
    assert.equal(JSON.stringify(stalePayload).includes(targetTemporaryPassword), false);

    const persisted = await dataStore.readDb();
    const invalidatedAdmin = persisted.users.find((row) => row.id === "U9001");
    assert.equal(invalidatedAdmin.sessionVersion, 1);
    assert.equal(invalidatedAdmin.mustChangePassword, true);
    assert.equal(
      persisted.auditLogs.filter((row) => row.action === "user.temporary-password-view").length,
      viewAuditCount
    );
  } finally {
    releaseOldRead?.();
    if (dataStore && originalWithMutationLock) dataStore.withMutationLock = originalWithMutationLock;
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await dataStore?.close?.();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
