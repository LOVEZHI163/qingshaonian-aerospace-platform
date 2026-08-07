import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertEmptySmokeDatabase,
  parseIsolatedSmokeTarget
} from "../src/cli/postgres-migration-smoke-safety.js";

const root = path.resolve(import.meta.dirname, "../../..");

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("remote smoke covers organization membership authentication boundaries", async () => {
  const script = await fs.readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8");

  assert.match(script, /\/api\/me\/organization-relations/);
  assert.match(script, /\/api\/organization\/memberships/);
  assert.match(script, /organization-relations-unauthenticated=401/);
  assert.match(script, /admin-users/);
  assert.match(script, /admin-organization-credential/);
  assert.match(script, /012-membership-data-normalization\.sql/);
  assert.match(script, /013-organization-account-lifecycle\.sql/);
  assert.match(script, /organization-account-lifecycle-migration-013=applied/);
  assert.match(script, /014-organization-deletion-history\.sql/);
  assert.match(script, /organization-deletion-history-migration-014=applied/);
  assert.match(script, /docker compose exec -T postgres sh -c/);
  assert.match(script, /psql -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"/);
  assert.doesNotMatch(script, /docker compose exec -T db psql/);
});

test("PostgreSQL migration restart smoke refuses a prefix lookalike before connecting", async () => {
  const result = await runNode([
    "apps/api/src/cli/postgres-migration-restart-smoke.js"
  ], {
    env: {
      DATABASE_URL: "postgresql://aerogp:do-not-log@127.0.0.1:1/aerogp_migration_smoke_business",
      MIGRATION_SMOKE_DATABASE: "aerogp_migration_smoke_business"
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated migration smoke database/i);
  assert.equal(result.stdout, "");
  assert.equal(`${result.stdout}${result.stderr}`.includes("do-not-log"), false);
});

test("migration smoke target requires the complete random database name format", () => {
  const databaseName = "aerogp_migration_smoke_0123456789abcdef0123456789abcdef";
  assert.equal(parseIsolatedSmokeTarget({
    DATABASE_URL: `postgresql://aerogp:secret@postgres:5432/${databaseName}`,
    MIGRATION_SMOKE_DATABASE: databaseName
  }).databaseName, databaseName);

  for (const invalidName of [
    "aerogp_migration_smoke_business",
    "aerogp_migration_smoke_0123456789abcdef",
    "aerogp_migration_smoke_0123456789abcdef0123456789abcdeg",
    "aerogp_migration_smoke_0123456789ABCDEF0123456789ABCDEF"
  ]) {
    assert.throws(() => parseIsolatedSmokeTarget({
      DATABASE_URL: `postgresql://aerogp:secret@postgres:5432/${invalidName}`,
      MIGRATION_SMOKE_DATABASE: invalidName
    }), /isolated migration smoke database/i, invalidName);
  }
});

test("migration smoke rejects a non-empty target before schema initialization", async () => {
  const databaseName = "aerogp_migration_smoke_0123456789abcdef0123456789abcdef";
  const result = (overrides = {}) => ({
    rows: [{
      database_name: databaseName,
      user_table_count: 0,
      has_schema_migrations: false,
      ...overrides
    }]
  });

  await assert.doesNotReject(assertEmptySmokeDatabase({ query: async () => result() }, databaseName));
  await assert.rejects(
    assertEmptySmokeDatabase({ query: async () => result({ user_table_count: 1 }) }, databaseName),
    /must be empty/i
  );
  await assert.rejects(
    assertEmptySmokeDatabase({ query: async () => result({ has_schema_migrations: true }) }, databaseName),
    /must be empty/i
  );
  await assert.rejects(
    assertEmptySmokeDatabase({ query: async () => result({ database_name: "aerogp" }) }, databaseName),
    /unexpected database/i
  );
});
