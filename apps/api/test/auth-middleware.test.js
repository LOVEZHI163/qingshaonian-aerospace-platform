import assert from "node:assert/strict";
import test from "node:test";

import * as sessionAuth from "../src/auth/session.js";
import * as passwordAuth from "../src/auth/passwords.js";

function responseDouble() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test("session middleware requires an explicit production secret", () => {
  assert.throws(
    () => sessionAuth.createSessionMiddleware({ env: { NODE_ENV: "production" }, dataStore: { kind: "file" } }),
    /SESSION_SECRET is required/
  );
  assert.throws(
    () => sessionAuth.createSessionMiddleware({ env: { NODE_ENV: "production", SESSION_SECRET: "x".repeat(31) }, dataStore: { kind: "file" } }),
    /at least 32 bytes/
  );
});

test("password policy requires 8 to 64 characters with letters and digits", () => {
  assert.equal(typeof passwordAuth.validatePassword, "function");
  assert.equal(passwordAuth.validatePassword("Strong123"), null);
  assert.match(passwordAuth.validatePassword("short1"), /8/);
  assert.match(passwordAuth.validatePassword("onlyletters"), /字母和数字/);
  assert.match(passwordAuth.validatePassword("12345678"), /字母和数字/);
  assert.match(passwordAuth.validatePassword(`Ab${"1".repeat(63)}`), /64/);
});

test("login password verification performs bcrypt work for unknown users", async () => {
  assert.equal(typeof passwordAuth.verifyLoginPassword, "function");
  assert.equal(await passwordAuth.verifyLoginPassword("Wrong123", null), false);
});

test("async route forwards rejected promises to Express", async () => {
  assert.equal(typeof sessionAuth.asyncRoute, "function");
  const expected = new Error("provider failed");
  let forwarded;
  await sessionAuth.asyncRoute(async () => { throw expected; })({}, {}, (error) => { forwarded = error; });
  assert.equal(forwarded, expected);
});

test("requireAdmin distinguishes unauthenticated, ordinary, and admin users", () => {
  assert.equal(typeof sessionAuth.requireAdmin, "function");

  const unauthenticated = responseDouble();
  sessionAuth.requireAdmin({}, unauthenticated, () => assert.fail("must not continue"));
  assert.equal(unauthenticated.statusCode, 401);

  const forbidden = responseDouble();
  sessionAuth.requireAdmin({ user: { type: "ordinary" } }, forbidden, () => assert.fail("must not continue"));
  assert.equal(forbidden.statusCode, 403);

  let continued = false;
  sessionAuth.requireAdmin({ user: { type: "admin" } }, responseDouble(), () => { continued = true; });
  assert.equal(continued, true);
});
