import assert from "node:assert/strict";
import test from "node:test";

import * as sessionAuth from "../src/auth/session.js";

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
