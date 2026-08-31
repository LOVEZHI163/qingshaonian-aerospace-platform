import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import * as migrationRestartSmoke from "../src/cli/postgres-migration-restart-smoke.js";
import {
  assertEmptySmokeDatabase,
  parseIsolatedSmokeTarget
} from "../src/cli/postgres-migration-smoke-safety.js";

const root = path.resolve(import.meta.dirname, "../../..");

const LEGACY_PERSONAL_REGISTRATION = {
  id: "R-legacy-personal",
  eventId: "E-legacy",
  source: "普通用户",
  createdByUserId: "U-legacy",
  personalUserId: "U-legacy",
  organizationId: null,
  createdVia: "personal",
  organization: "",
  organizationDeleted: false,
  athlete: { name: "旧报名选手", school: "旧学校", grade: "五年级", phone: "13800000001" },
  athleteKey: "旧报名选手|旧学校|五年级|13800000001",
  group: "小学高段",
  projectId: "P-individual",
  projectName: "个人赛",
  projectType: "individual",
  instructor: "",
  teamCode: "",
  status: "pending",
  rejectReason: "",
  awardName: "",
  rank: "",
  score: "",
  resultRecordedAt: "",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z"
};

const LEGACY_PERSONAL_IDENTITY = {
  registrationId: LEGACY_PERSONAL_REGISTRATION.id,
  ciphertext: "legacy-ciphertext",
  iv: "legacy-iv",
  authTag: "legacy-auth-tag",
  keyVersion: 1,
  idFingerprint: "legacy-fingerprint",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z"
};

function migrationRestartState(overrides = {}) {
  const migrationCount = overrides.migrationCount ?? 1;
  const tableNames = overrides.tableNames ?? [
    "registration_participants",
    "registration_participant_identities"
  ];
  const boundColumns = overrides.boundColumns ?? ["team_min_members", "team_max_members"];
  const afterRestart = overrides.afterRestart ?? {
    projects: [{ id: "P-individual", teamMinMembers: 1, teamMaxMembers: 8 }],
    registrations: [structuredClone(LEGACY_PERSONAL_REGISTRATION)],
    registrationIdentities: [structuredClone(LEGACY_PERSONAL_IDENTITY)]
  };
  const pool = {
    async query(sql, params) {
      if (sql.includes("schema_migrations")) {
        assert.deepEqual(params, ["019-team-registration.sql"]);
        return { rows: [{ count: migrationCount }] };
      }
      if (sql.includes("information_schema.tables")) {
        assert.deepEqual(new Set(params[0]), new Set([
          "registration_participants",
          "registration_participant_identities"
        ]));
        return { rows: tableNames.map((table_name) => ({ table_name })) };
      }
      if (sql.includes("information_schema.columns")) {
        assert.deepEqual(new Set(params[0]), new Set(["team_min_members", "team_max_members"]));
        return { rows: boundColumns.map((column_name) => ({ column_name })) };
      }
      throw new Error(`unexpected restart-smoke query: ${sql}`);
    }
  };
  return {
    restarted: { pool, readDb: async () => afterRestart },
    legacyRegistrationBeforeRestart: structuredClone(LEGACY_PERSONAL_REGISTRATION),
    legacyIdentityBeforeRestart: structuredClone(LEGACY_PERSONAL_IDENTITY)
  };
}

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

test("migration restart smoke accepts migration 019 team schema after a second initialization", async () => {
  assert.equal(
    typeof migrationRestartSmoke.assertTeamMigrationRestartState,
    "function",
    "restart smoke must expose the team-migration state assertion"
  );

  await assert.doesNotReject(
    migrationRestartSmoke.assertTeamMigrationRestartState(migrationRestartState())
  );
});

test("migration restart smoke rejects duplicate 019 history and incomplete team schema", async (t) => {
  const assertRestartState = migrationRestartSmoke.assertTeamMigrationRestartState;
  assert.equal(typeof assertRestartState, "function");

  await t.test("migration 019 must be recorded exactly once", async () => {
    await assert.rejects(
      assertRestartState(migrationRestartState({ migrationCount: 2 })),
      /migration 019 was not recorded exactly once/i
    );
  });
  await t.test("both participant tables must survive restart", async () => {
    await assert.rejects(
      assertRestartState(migrationRestartState({ tableNames: ["registration_participants"] })),
      /migration 019 did not create all required participant tables/i
    );
  });
  await t.test("both persisted project bounds must be present", async () => {
    await assert.rejects(
      assertRestartState(migrationRestartState({ boundColumns: ["team_min_members"] })),
      /migration 019 did not add both project bound columns/i
    );
    await assert.rejects(
      assertRestartState(migrationRestartState({
        afterRestart: {
          projects: [{ id: "P-individual", teamMinMembers: 1 }],
          registrations: [structuredClone(LEGACY_PERSONAL_REGISTRATION)],
          registrationIdentities: [structuredClone(LEGACY_PERSONAL_IDENTITY)]
        }
      })),
      /project bounds did not survive PostgreSQL store restart/i
    );
  });
});

test("migration restart smoke rejects changes to legacy personal registration data", async (t) => {
  const assertRestartState = migrationRestartSmoke.assertTeamMigrationRestartState;
  assert.equal(typeof assertRestartState, "function");

  await t.test("registration aggregate is unchanged", async () => {
    const changed = structuredClone(LEGACY_PERSONAL_REGISTRATION);
    changed.status = "approved";
    await assert.rejects(
      assertRestartState(migrationRestartState({
        afterRestart: {
          projects: [{ id: "P-individual", teamMinMembers: 1, teamMaxMembers: 8 }],
          registrations: [changed],
          registrationIdentities: [structuredClone(LEGACY_PERSONAL_IDENTITY)]
        }
      })),
      /legacy personal registration changed during PostgreSQL store restart/i
    );
  });
  await t.test("encrypted identity row is unchanged", async () => {
    const changed = structuredClone(LEGACY_PERSONAL_IDENTITY);
    changed.keyVersion = 2;
    await assert.rejects(
      assertRestartState(migrationRestartState({
        afterRestart: {
          projects: [{ id: "P-individual", teamMinMembers: 1, teamMaxMembers: 8 }],
          registrations: [structuredClone(LEGACY_PERSONAL_REGISTRATION)],
          registrationIdentities: [changed]
        }
      })),
      /legacy personal registration identity changed during PostgreSQL store restart/i
    );
  });
});
