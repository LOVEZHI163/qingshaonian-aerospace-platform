import assert from "node:assert/strict";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";

const smsLoginModule = await import("../src/auth/sms-login.js").catch(() => ({}));

function makeDb() {
  return {
    users: [
      { id: "U1", phone: "13800000001", type: "ordinary", status: "active", sessionVersion: 3, mustChangePassword: true },
      { id: "U2", phone: "13800000002", type: "admin", status: "active", sessionVersion: 1, mustChangePassword: false },
      { id: "U3", phone: "13800000003", type: "organization", status: "active", sessionVersion: 2, mustChangePassword: false },
      { id: "U4", phone: "13800000004", type: "organization", status: "active", sessionVersion: 2, mustChangePassword: false },
      { id: "U5", phone: "13800000005", type: "organization", status: "active", sessionVersion: 2, mustChangePassword: false },
      { id: "U6", phone: "13800000006", type: "ordinary", status: "disabled", sessionVersion: 0, mustChangePassword: false },
      { id: "U7", phone: "13800000007", type: "admin", status: "disabled", sessionVersion: 0, mustChangePassword: false },
      { id: "U8", phone: "13800000008", type: "organization", status: "active", sessionVersion: 0, mustChangePassword: false }
    ],
    organizations: [
      { id: "O3", ownerUserId: "U3", reviewStatus: "approved", status: "active" },
      { id: "O4", ownerUserId: "U4", reviewStatus: "pending", status: "active" },
      { id: "O5", ownerUserId: "U5", reviewStatus: "approved", status: "disabled" },
      { id: "O8", ownerUserId: "U8", reviewStatus: "rejected", status: "active" }
    ]
  };
}

function harness() {
  let db = makeDb();
  let valid = true;
  const requests = [];
  const challengeService = {
    enabled: true,
    async request(input) { requests.push(input); return { ok: true, input }; },
    async consume() { return valid; }
  };
  const service = smsLoginModule.createSmsLoginService?.({
    challengeService,
    readDb: async () => structuredClone(db),
    isEligible: smsLoginModule.isSmsLoginEligible
  });
  return {
    service,
    requests,
    setDb(next) { db = structuredClone(next); },
    setValid(next) { valid = next; }
  };
}

test("SMS login accepts only active existing accounts and operational organization owners", async () => {
  assert.equal(typeof smsLoginModule.createSmsLoginService, "function");
  assert.equal(typeof smsLoginModule.isSmsLoginEligible, "function");
  const db = makeDb();
  for (const phone of ["13800000001", "13800000002", "13800000003"]) {
    const user = db.users.find((row) => row.phone === phone);
    assert.equal(smsLoginModule.isSmsLoginEligible(db, user), true, phone);
  }
  for (const phone of ["13800000004", "13800000005", "13800000006", "13800000007", "13800000008"]) {
    const user = db.users.find((row) => row.phone === phone);
    assert.equal(smsLoginModule.isSmsLoginEligible(db, user), false, phone);
  }
  assert.equal(smsLoginModule.isSmsLoginEligible(db, undefined), false);
});

test("ordinary users, approved organization owners, and administrators request and confirm SMS login", async () => {
  for (const [phone, type] of [
    ["13800000001", "ordinary"],
    ["13800000002", "admin"],
    ["13800000003", "organization"]
  ]) {
    const active = harness();
    await active.service.request({ phone, ip: "127.0.0.1" });
    const result = await active.service.confirm({ phone, code: "123456" });
    assert.deepEqual(active.requests, [{ phone, ip: "127.0.0.1" }]);
    assert.equal(result.user.type, type);
  }
});

test("SMS login confirmation rejects account or organization changes made after request", async () => {
  const cases = [
    ["disabled ordinary user", "13800000001", (db) => { db.users.find((row) => row.id === "U1").status = "disabled"; }],
    ["disabled administrator", "13800000002", (db) => { db.users.find((row) => row.id === "U2").status = "disabled"; }],
    ["pending organization", "13800000003", (db) => { db.organizations.find((row) => row.id === "O3").reviewStatus = "pending"; }],
    ["rejected organization", "13800000003", (db) => { db.organizations.find((row) => row.id === "O3").reviewStatus = "rejected"; }],
    ["disabled organization", "13800000003", (db) => { db.organizations.find((row) => row.id === "O3").status = "disabled"; }]
  ];

  for (const [label, phone, mutate] of cases) {
    const changed = harness();
    await changed.service.request({ phone, ip: "127.0.0.1" });
    const db = makeDb();
    mutate(db);
    changed.setDb(db);
    await assert.rejects(
      changed.service.confirm({ phone, code: "123456" }),
      (error) => error.statusCode === 422 && error.message === "验证码无效或已过期",
      label
    );
  }
});

test("SMS login confirms once, rechecks current account state, and preserves mustChangePassword", async () => {
  const active = harness();
  const result = await active.service.confirm({ phone: "138 0000 0001", code: "123456" });
  assert.equal(result.user.id, "U1");
  assert.equal(result.user.mustChangePassword, true);

  const invalid = harness();
  invalid.setValid(false);
  await assert.rejects(
    invalid.service.confirm({ phone: "13800000001", code: "000000" }),
    (error) => error.statusCode === 422 && error.message === "验证码无效或已过期"
  );

  const changed = harness();
  const db = makeDb();
  db.users[0].status = "disabled";
  changed.setDb(db);
  await assert.rejects(
    changed.service.confirm({ phone: "13800000001", code: "123456" }),
    (error) => error.statusCode === 422 && error.message === "验证码无效或已过期"
  );
});

test("public auth features have a stable full shape and disabled SMS login fails closed", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const features = await fetch(`${baseUrl}/api/public/features`);
    assert.equal(features.status, 200);
    assert.deepEqual(await features.json(), {
      smsRegistrationEnabled: false,
      smsLoginEnabled: false,
      smsPasswordResetEnabled: false,
      emailPasswordResetEnabled: false,
      captcha: {
        enabled: false,
        region: "cn",
        prefix: "",
        scenes: { smsRegistration: "", smsLogin: "", smsPasswordReset: "", emailPasswordReset: "" }
      }
    });

    const response = await fetch(`${baseUrl}/api/auth/sms-login/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800000001" })
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "短信验证暂未启用" });
  }, { prefix: "aerogp-sms-login-", smsRegistrationEnabled: false });
});
