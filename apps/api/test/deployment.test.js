import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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

test("PostgreSQL migration restart smoke refuses any non-isolated database before connecting", async () => {
  const result = await runNode([
    "apps/api/src/cli/postgres-migration-restart-smoke.js"
  ], {
    env: {
      DATABASE_URL: "postgresql://aerogp:do-not-log@postgres:5432/aerogp",
      MIGRATION_SMOKE_DATABASE: "aerogp"
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated migration smoke database/i);
  assert.equal(result.stdout, "");
  assert.equal(`${result.stdout}${result.stderr}`.includes("do-not-log"), false);
});
