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

const TEAM_COLUMN_CATALOG = [
  { table_name: "projects", column_name: "team_min_members", data_type: "smallint", is_not_null: true, default_expression: "1" },
  { table_name: "projects", column_name: "team_max_members", data_type: "smallint", is_not_null: true, default_expression: "8" },
  { table_name: "registrations", column_name: "team_code", data_type: "text", is_not_null: true, default_expression: "''::text" },
  { table_name: "registration_participants", column_name: "id", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participants", column_name: "registration_id", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participants", column_name: "display_order", data_type: "smallint", is_not_null: true, default_expression: null },
  { table_name: "registration_participants", column_name: "name", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participants", column_name: "school", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participants", column_name: "grade", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participants", column_name: "phone", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participants", column_name: "created_at", data_type: "timestamp with time zone", is_not_null: true, default_expression: null },
  { table_name: "registration_participants", column_name: "updated_at", data_type: "timestamp with time zone", is_not_null: true, default_expression: null },
  { table_name: "registration_participant_identities", column_name: "participant_id", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participant_identities", column_name: "ciphertext", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participant_identities", column_name: "iv", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participant_identities", column_name: "auth_tag", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participant_identities", column_name: "key_version", data_type: "integer", is_not_null: true, default_expression: "1" },
  { table_name: "registration_participant_identities", column_name: "id_fingerprint", data_type: "text", is_not_null: true, default_expression: null },
  { table_name: "registration_participant_identities", column_name: "created_at", data_type: "timestamp with time zone", is_not_null: true, default_expression: null },
  { table_name: "registration_participant_identities", column_name: "updated_at", data_type: "timestamp with time zone", is_not_null: true, default_expression: null },
  { table_name: "certificates", column_name: "participant_id", data_type: "text", is_not_null: false, default_expression: null }
];

const TEAM_CONSTRAINT_CATALOG = [
  {
    table_name: "projects",
    constraint_name: "projects_team_member_bounds_check",
    constraint_type: "c",
    is_validated: true,
    definition: "CHECK (team_min_members >= 1 AND team_min_members <= 8 AND team_max_members >= 1 AND team_max_members <= 8 AND team_min_members <= team_max_members)"
  },
  {
    table_name: "registration_participants",
    constraint_name: "registration_participants_pkey",
    constraint_type: "p",
    is_validated: true,
    definition: "PRIMARY KEY (id)"
  },
  {
    table_name: "registration_participants",
    constraint_name: "registration_participants_registration_id_fkey",
    constraint_type: "f",
    is_validated: true,
    definition: "FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE"
  },
  {
    table_name: "registration_participants",
    constraint_name: "registration_participants_display_order_check",
    constraint_type: "c",
    is_validated: true,
    definition: "CHECK (display_order >= 1 AND display_order <= 8)"
  },
  {
    table_name: "registration_participants",
    constraint_name: "registration_participants_registration_id_display_order_key",
    constraint_type: "u",
    is_validated: true,
    definition: "UNIQUE (registration_id, display_order)"
  },
  {
    table_name: "registration_participants",
    constraint_name: "registration_participants_id_registration_id_key",
    constraint_type: "u",
    is_validated: true,
    definition: "UNIQUE (id, registration_id)"
  },
  {
    table_name: "registration_participant_identities",
    constraint_name: "registration_participant_identities_pkey",
    constraint_type: "p",
    is_validated: true,
    definition: "PRIMARY KEY (participant_id)"
  },
  {
    table_name: "registration_participant_identities",
    constraint_name: "registration_participant_identities_participant_id_fkey",
    constraint_type: "f",
    is_validated: true,
    definition: "FOREIGN KEY (participant_id) REFERENCES registration_participants(id) ON DELETE CASCADE"
  },
  {
    table_name: "certificates",
    constraint_name: "certificates_participant_registration_fkey",
    constraint_type: "f",
    is_validated: true,
    definition: "FOREIGN KEY (participant_id, registration_id) REFERENCES registration_participants(id, registration_id) ON DELETE CASCADE"
  }
];

const TEAM_INDEX_CATALOG = [
  {
    table_name: "registration_participant_identities",
    index_name: "registration_participant_identity_fingerprint_idx",
    is_unique: false,
    is_valid: true,
    is_ready: true,
    is_live: true,
    definition: "CREATE INDEX registration_participant_identity_fingerprint_idx ON public.registration_participant_identities USING btree (id_fingerprint)",
    predicate: null
  },
  {
    table_name: "certificates",
    index_name: "certificates_registration_slot_legacy_key",
    is_unique: true,
    is_valid: true,
    is_ready: true,
    is_live: true,
    definition: "CREATE UNIQUE INDEX certificates_registration_slot_legacy_key ON public.certificates USING btree (registration_id, slot) WHERE (participant_id IS NULL)",
    predicate: "participant_id IS NULL"
  },
  {
    table_name: "certificates",
    index_name: "certificates_participant_slot_key",
    is_unique: true,
    is_valid: true,
    is_ready: true,
    is_live: true,
    definition: "CREATE UNIQUE INDEX certificates_participant_slot_key ON public.certificates USING btree (registration_id, participant_id, slot) WHERE (participant_id IS NOT NULL)",
    predicate: "participant_id IS NOT NULL"
  }
];

function checkViolation(constraint) {
  return Object.assign(new Error(`check constraint ${constraint} failed`), {
    code: "23514",
    constraint
  });
}

function uniqueViolation(constraint) {
  return Object.assign(new Error(`unique constraint ${constraint} failed`), {
    code: "23505",
    constraint
  });
}

const FORMER_HARDCODED_PROBE_IDS = [
  "migration-check-participant-order-zero",
  "migration-check-participant-order-nine",
  "migration-check-participant-order-one",
  "migration-check-participant-order-eight"
];

function migrationRestartState(overrides = {}) {
  const migrationCount = overrides.migrationCount ?? 1;
  const tableNames = overrides.tableNames ?? [
    "registration_participants",
    "registration_participant_identities"
  ];
  const boundColumns = overrides.boundColumns ?? ["team_min_members", "team_max_members"];
  const columnCatalog = overrides.columnCatalog ?? structuredClone(TEAM_COLUMN_CATALOG);
  const constraintCatalog = overrides.constraintCatalog ?? structuredClone(TEAM_CONSTRAINT_CATALOG);
  const indexCatalog = overrides.indexCatalog ?? structuredClone(TEAM_INDEX_CATALOG);
  const probeBehavior = overrides.probeBehavior ?? {};
  const initialParticipantIds = overrides.initialParticipantIds ?? [];
  const afterRestart = overrides.afterRestart ?? {
    projects: [{ id: "P-individual", teamMinMembers: 1, teamMaxMembers: 8 }],
    registrations: [structuredClone(LEGACY_PERSONAL_REGISTRATION)],
    registrationIdentities: [structuredClone(LEGACY_PERSONAL_IDENTITY)]
  };
  const probeState = {
    projectBounds: { min: 1, max: 8 },
    participantIds: new Set(initialParticipantIds),
    observedParticipantProbeIds: new Set(),
    cleanupParticipantProbeIds: [],
    transactions: 0,
    outerRollbacks: 0,
    savepointRollbacks: 0,
    transactionActive: false,
    releases: 0,
    releasedInactive: false,
    releaseAttemptsWithActiveTransaction: 0
  };
  let transaction = null;
  let savepoint = null;
  let transactionAborted = false;
  const matchesPair = (pairs, min, max) => (pairs ?? []).some((pair) => (
    pair[0] === min && pair[1] === max
  ));
  const client = {
    async query(sql, params = []) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      if (normalizedSql === "BEGIN") {
        assert.equal(transaction, null);
        transaction = {
          projectBounds: { ...probeState.projectBounds },
          participantIds: new Set(probeState.participantIds)
        };
        probeState.transactions += 1;
        probeState.transactionActive = true;
        return { rows: [], rowCount: null };
      }
      if (normalizedSql === "SAVEPOINT migration_check_probe") {
        assert.ok(transaction);
        assert.equal(transactionAborted, false);
        savepoint = {
          projectBounds: { ...transaction.projectBounds },
          participantIds: new Set(transaction.participantIds)
        };
        return { rows: [], rowCount: null };
      }
      if (normalizedSql === "ROLLBACK TO SAVEPOINT migration_check_probe") {
        assert.ok(transaction);
        assert.ok(savepoint);
        transaction.projectBounds = { ...savepoint.projectBounds };
        transaction.participantIds = new Set(savepoint.participantIds);
        transactionAborted = false;
        probeState.savepointRollbacks += 1;
        return { rows: [], rowCount: null };
      }
      if (normalizedSql === "RELEASE SAVEPOINT migration_check_probe") {
        assert.ok(transaction);
        assert.equal(transactionAborted, false);
        savepoint = null;
        return { rows: [], rowCount: null };
      }
      if (normalizedSql === "ROLLBACK") {
        assert.ok(transaction);
        probeState.outerRollbacks += 1;
        transaction = null;
        savepoint = null;
        transactionAborted = false;
        probeState.transactionActive = false;
        return { rows: [], rowCount: null };
      }
      if (normalizedSql === "COMMIT") {
        assert.ok(transaction);
        probeState.projectBounds = { ...transaction.projectBounds };
        probeState.participantIds = new Set(transaction.participantIds);
        transaction = null;
        savepoint = null;
        probeState.transactionActive = false;
        return { rows: [], rowCount: null };
      }
      if (transactionAborted) {
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      }
      if (normalizedSql.includes("SELECT team_min_members") && normalizedSql.includes("FROM projects")) {
        assert.deepEqual(params, [LEGACY_PERSONAL_REGISTRATION.projectId]);
        const bounds = transaction?.projectBounds ?? probeState.projectBounds;
        return {
          rows: [{ team_min_members: bounds.min, team_max_members: bounds.max }],
          rowCount: 1
        };
      }
      if (normalizedSql.startsWith("UPDATE projects")) {
        assert.ok(transaction);
        const [min, max, projectId] = params;
        assert.equal(projectId, LEGACY_PERSONAL_REGISTRATION.projectId);
        const valid = min >= 1 && min <= 8 && max >= 1 && max <= 8 && min <= max;
        const allowedInvalid = matchesPair(probeBehavior.allowInvalidProjectBounds, min, max);
        const rejectedValid = matchesPair(probeBehavior.rejectValidProjectBounds, min, max);
        if ((!valid && !allowedInvalid) || (valid && rejectedValid)) {
          transactionAborted = true;
          throw checkViolation("projects_team_member_bounds_check");
        }
        transaction.projectBounds = { min, max };
        return { rows: [{ id: projectId }], rowCount: 1 };
      }
      if (normalizedSql.startsWith("INSERT INTO registration_participants")) {
        assert.ok(transaction);
        const [id, registrationId, displayOrder] = params;
        assert.equal(registrationId, LEGACY_PERSONAL_REGISTRATION.id);
        probeState.observedParticipantProbeIds.add(id);
        const valid = displayOrder >= 1 && displayOrder <= 8;
        const allowedInvalid = (probeBehavior.allowInvalidDisplayOrders ?? []).includes(displayOrder);
        const rejectedValid = (probeBehavior.rejectValidDisplayOrders ?? []).includes(displayOrder);
        if ((!valid && !allowedInvalid) || (valid && rejectedValid)) {
          transactionAborted = true;
          throw checkViolation("registration_participants_display_order_check");
        }
        if (transaction.participantIds.has(id)) {
          transactionAborted = true;
          throw uniqueViolation("registration_participants_pkey");
        }
        transaction.participantIds.add(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (normalizedSql.includes("COUNT(*)::integer AS count")
        && normalizedSql.includes("FROM registration_participants")) {
        probeState.cleanupParticipantProbeIds = [...params[0]];
        const participantIds = transaction?.participantIds ?? probeState.participantIds;
        return { rows: [{ count: params[0].filter((id) => participantIds.has(id)).length }] };
      }
      throw new Error(`unexpected restart-smoke client query: ${sql}`);
    },
    release() {
      if (transaction) {
        probeState.releaseAttemptsWithActiveTransaction += 1;
        throw new Error("fake PostgreSQL client released with an active transaction");
      }
      probeState.releases += 1;
      probeState.releasedInactive = true;
    }
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
      if (sql.includes("FROM pg_attribute")) {
        assert.deepEqual(new Set(params[0]), new Set([
          "projects",
          "registrations",
          "registration_participants",
          "registration_participant_identities",
          "certificates"
        ]));
        return { rows: columnCatalog };
      }
      if (sql.includes("FROM pg_constraint")) {
        assert.deepEqual(new Set(params[0]), new Set([
          "projects",
          "registrations",
          "registration_participants",
          "registration_participant_identities",
          "certificates"
        ]));
        return { rows: constraintCatalog };
      }
      if (sql.includes("FROM pg_index")) {
        assert.deepEqual(new Set(params[0]), new Set([
          "registration_participant_identities",
          "certificates"
        ]));
        return { rows: indexCatalog };
      }
      throw new Error(`unexpected restart-smoke query: ${sql}`);
    },
    async connect() {
      return client;
    }
  };
  return {
    restarted: { pool, readDb: async () => afterRestart },
    legacyRegistrationBeforeRestart: structuredClone(LEGACY_PERSONAL_REGISTRATION),
    legacyIdentityBeforeRestart: structuredClone(LEGACY_PERSONAL_IDENTITY),
    probeState
  };
}

function assertCompletedProbeLifecycle(probeState, { savepointRollbacks } = {}) {
  assert.equal(probeState.transactions, 1);
  assert.equal(probeState.outerRollbacks, 1);
  if (savepointRollbacks !== undefined) {
    assert.equal(probeState.savepointRollbacks, savepointRollbacks);
  }
  assert.equal(probeState.transactionActive, false);
  assert.equal(probeState.releaseAttemptsWithActiveTransaction, 0);
  assert.equal(probeState.releases, 1);
  assert.equal(probeState.releasedInactive, true);
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

test("migration restart smoke rejects missing or malformed live migration 019 catalog contracts", async (t) => {
  const assertRestartState = migrationRestartSmoke.assertTeamMigrationRestartState;

  await t.test("every required column keeps its type, nullability, and default", async () => {
    for (const expected of TEAM_COLUMN_CATALOG) {
      const catalog = structuredClone(TEAM_COLUMN_CATALOG).filter((row) => (
        row.table_name !== expected.table_name || row.column_name !== expected.column_name
      ));
      await assert.rejects(
        assertRestartState(migrationRestartState({ columnCatalog: catalog })),
        /migration 019 live column contract is incomplete or malformed/i,
        `${expected.table_name}.${expected.column_name}`
      );
    }

    for (const [tableName, columnName, change] of [
      ["projects", "team_min_members", { is_not_null: false }],
      ["projects", "team_max_members", { default_expression: "9" }],
      ["registrations", "team_code", { default_expression: null }],
      ["registration_participants", "display_order", { data_type: "integer" }],
      ["registration_participant_identities", "key_version", { default_expression: "2" }],
      ["certificates", "participant_id", { is_not_null: true }]
    ]) {
      const catalog = structuredClone(TEAM_COLUMN_CATALOG);
      Object.assign(catalog.find((row) => (
        row.table_name === tableName && row.column_name === columnName
      )), change);
      await assert.rejects(
        assertRestartState(migrationRestartState({ columnCatalog: catalog })),
        /migration 019 live column contract is incomplete or malformed/i,
        `${tableName}.${columnName}`
      );
    }
  });

  await t.test("every required check, foreign key, primary key, and unique constraint is validated", async () => {
    for (const expected of TEAM_CONSTRAINT_CATALOG) {
      const missing = structuredClone(TEAM_CONSTRAINT_CATALOG).filter((row) => (
        row.constraint_name !== expected.constraint_name
      ));
      await assert.rejects(
        assertRestartState(migrationRestartState({ constraintCatalog: missing })),
        /migration 019 live constraint contract is incomplete or malformed/i,
        `${expected.table_name}.${expected.constraint_name} missing`
      );

      const wrongType = structuredClone(TEAM_CONSTRAINT_CATALOG);
      wrongType.find((row) => row.constraint_name === expected.constraint_name).constraint_type = "x";
      await assert.rejects(
        assertRestartState(migrationRestartState({ constraintCatalog: wrongType })),
        /migration 019 live constraint contract is incomplete or malformed/i,
        `${expected.table_name}.${expected.constraint_name} type`
      );

      const notValidated = structuredClone(TEAM_CONSTRAINT_CATALOG);
      notValidated.find((row) => row.constraint_name === expected.constraint_name).is_validated = false;
      await assert.rejects(
        assertRestartState(migrationRestartState({ constraintCatalog: notValidated })),
        /migration 019 live constraint contract is incomplete or malformed/i,
        `${expected.table_name}.${expected.constraint_name} validation`
      );

      if (expected.constraint_type !== "c") {
        const malformedDefinition = structuredClone(TEAM_CONSTRAINT_CATALOG);
        malformedDefinition.find((row) => row.constraint_name === expected.constraint_name).definition =
          expected.constraint_type === "f"
            ? expected.definition.replace(" ON DELETE CASCADE", "")
            : "CHECK (TRUE)";
        await assert.rejects(
          assertRestartState(migrationRestartState({ constraintCatalog: malformedDefinition })),
          /migration 019 live constraint contract is incomplete or malformed/i,
          `${expected.table_name}.${expected.constraint_name} definition`
        );
      }
    }
  });

  await t.test("fingerprint and certificate indexes keep keys, uniqueness, and predicates", async () => {
    for (const expected of TEAM_INDEX_CATALOG) {
      const missing = structuredClone(TEAM_INDEX_CATALOG).filter((row) => (
        row.index_name !== expected.index_name
      ));
      await assert.rejects(
        assertRestartState(migrationRestartState({ indexCatalog: missing })),
        /migration 019 live index contract is incomplete or malformed/i,
        `${expected.table_name}.${expected.index_name} missing`
      );

      const wrongUniqueness = structuredClone(TEAM_INDEX_CATALOG);
      wrongUniqueness.find((row) => row.index_name === expected.index_name).is_unique = !expected.is_unique;
      await assert.rejects(
        assertRestartState(migrationRestartState({ indexCatalog: wrongUniqueness })),
        /migration 019 live index contract is incomplete or malformed/i,
        `${expected.table_name}.${expected.index_name} uniqueness`
      );

      const wrongKeys = structuredClone(TEAM_INDEX_CATALOG);
      const wrongKeyRow = wrongKeys.find((row) => row.index_name === expected.index_name);
      wrongKeyRow.definition = expected.index_name === "registration_participant_identity_fingerprint_idx"
        ? wrongKeyRow.definition.replace("(id_fingerprint)", "(participant_id)")
        : expected.index_name === "certificates_registration_slot_legacy_key"
          ? wrongKeyRow.definition.replace("(registration_id, slot)", "(slot, registration_id)")
          : wrongKeyRow.definition.replace(
            "(registration_id, participant_id, slot)",
            "(registration_id, slot, participant_id)"
          );
      await assert.rejects(
        assertRestartState(migrationRestartState({ indexCatalog: wrongKeys })),
        /migration 019 live index contract is incomplete or malformed/i,
        `${expected.table_name}.${expected.index_name} keys`
      );

      const wrongPredicate = structuredClone(TEAM_INDEX_CATALOG);
      wrongPredicate.find((row) => row.index_name === expected.index_name).predicate =
        expected.predicate === "participant_id IS NULL"
          ? "participant_id IS NOT NULL"
          : "participant_id IS NULL";
      await assert.rejects(
        assertRestartState(migrationRestartState({ indexCatalog: wrongPredicate })),
        /migration 019 live index contract is incomplete or malformed/i,
        `${expected.table_name}.${expected.index_name} predicate`
      );
    }
  });

  await t.test("every required index is valid, ready, and live", async () => {
    for (const expected of TEAM_INDEX_CATALOG) {
      for (const stateField of ["is_valid", "is_ready", "is_live"]) {
        const catalog = structuredClone(TEAM_INDEX_CATALOG);
        catalog.find((row) => row.index_name === expected.index_name)[stateField] = false;
        await assert.rejects(
          assertRestartState(migrationRestartState({ indexCatalog: catalog })),
          /migration 019 live index contract is incomplete or malformed/i,
          `${expected.table_name}.${expected.index_name}.${stateField}`
        );
      }
    }
  });
});

test("migration restart smoke rejects every forbidden legacy uniqueness constraint", async (t) => {
  const forbiddenConstraints = [
    ["registrations", "registrations_event_project_athlete_key"],
    ["registrations", "registrations_event_id_project_id_athlete_key_key"],
    ["certificates", "certificates_registration_id_slot_key"]
  ];

  for (const [tableName, constraintName] of forbiddenConstraints) {
    await t.test(constraintName, async () => {
      const catalog = structuredClone(TEAM_CONSTRAINT_CATALOG);
      catalog.push({
        table_name: tableName,
        constraint_name: constraintName,
        constraint_type: "u",
        is_validated: true,
        definition: "UNIQUE (legacy_column)"
      });
      await assert.rejects(
        migrationRestartSmoke.assertTeamMigrationRestartState(
          migrationRestartState({ constraintCatalog: catalog })
        ),
        /migration 019 retained a forbidden legacy uniqueness constraint/i
      );
    });
  }
});

test("migration restart smoke probes project and participant CHECK behavior without persistence", async (t) => {
  await t.test("valid edge probes roll back every project change and participant row", async () => {
    const state = migrationRestartState();
    await assert.doesNotReject(
      migrationRestartSmoke.assertTeamMigrationRestartState(state)
    );
    assertCompletedProbeLifecycle(state.probeState, { savepointRollbacks: 9 });
    assert.deepEqual(state.probeState.projectBounds, { min: 1, max: 8 });
    assert.equal(state.probeState.participantIds.size, 0);
  });

  for (const bounds of [[0, 1], [1, 9], [2, 1]]) {
    await t.test(`project bounds ${bounds.join("..")}`, async () => {
      const state = migrationRestartState({
        probeBehavior: { allowInvalidProjectBounds: [bounds] }
      });
      await assert.rejects(
        migrationRestartSmoke.assertTeamMigrationRestartState(state),
        /migration 019 project bounds check behavior is malformed/i
      );
      assertCompletedProbeLifecycle(state.probeState);
      assert.deepEqual(state.probeState.projectBounds, { min: 1, max: 8 });
      assert.equal(state.probeState.participantIds.size, 0);
    });
  }

  for (const bounds of [[1, 1], [8, 8]]) {
    await t.test(`valid project edge ${bounds.join("..")}`, async () => {
      const state = migrationRestartState({
        probeBehavior: { rejectValidProjectBounds: [bounds] }
      });
      await assert.rejects(
        migrationRestartSmoke.assertTeamMigrationRestartState(state),
        /migration 019 project bounds check behavior is malformed/i
      );
      assertCompletedProbeLifecycle(state.probeState);
      assert.deepEqual(state.probeState.projectBounds, { min: 1, max: 8 });
      assert.equal(state.probeState.participantIds.size, 0);
    });
  }

  for (const displayOrder of [0, 9]) {
    await t.test(`participant display order ${displayOrder}`, async () => {
      const state = migrationRestartState({
        probeBehavior: { allowInvalidDisplayOrders: [displayOrder] }
      });
      await assert.rejects(
        migrationRestartSmoke.assertTeamMigrationRestartState(state),
        /migration 019 participant display_order check behavior is malformed/i
      );
      assertCompletedProbeLifecycle(state.probeState);
      assert.deepEqual(state.probeState.projectBounds, { min: 1, max: 8 });
      assert.equal(state.probeState.participantIds.size, 0);
    });
  }

  for (const displayOrder of [1, 8]) {
    await t.test(`valid participant display edge ${displayOrder}`, async () => {
      const state = migrationRestartState({
        probeBehavior: { rejectValidDisplayOrders: [displayOrder] }
      });
      await assert.rejects(
        migrationRestartSmoke.assertTeamMigrationRestartState(state),
        /migration 019 participant display_order check behavior is malformed/i
      );
      assertCompletedProbeLifecycle(state.probeState);
      assert.deepEqual(state.probeState.projectBounds, { min: 1, max: 8 });
      assert.equal(state.probeState.participantIds.size, 0);
    });
  }

  await t.test("OR TRUE cannot weaken project bounds", async () => {
    const catalog = structuredClone(TEAM_CONSTRAINT_CATALOG);
    catalog.find((row) => row.constraint_name === "projects_team_member_bounds_check").definition += " OR TRUE";
    const state = migrationRestartState({
      constraintCatalog: catalog,
      probeBehavior: { allowInvalidProjectBounds: [[0, 1]] }
    });
    await assert.rejects(
      migrationRestartSmoke.assertTeamMigrationRestartState(state),
      /migration 019 project bounds check behavior is malformed/i
    );
    assertCompletedProbeLifecycle(state.probeState);
  });

  await t.test("OR TRUE cannot weaken participant display order", async () => {
    const catalog = structuredClone(TEAM_CONSTRAINT_CATALOG);
    catalog.find((row) => (
      row.constraint_name === "registration_participants_display_order_check"
    )).definition += " OR TRUE";
    const state = migrationRestartState({
      constraintCatalog: catalog,
      probeBehavior: { allowInvalidDisplayOrders: [0] }
    });
    await assert.rejects(
      migrationRestartSmoke.assertTeamMigrationRestartState(state),
      /migration 019 participant display_order check behavior is malformed/i
    );
    assertCompletedProbeLifecycle(state.probeState);
  });
});

test("migration restart smoke generates an isolated participant probe namespace per run", async (t) => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  await t.test("two runs use disjoint UUID probe IDs and clean up only those IDs", async () => {
    const first = migrationRestartState();
    const second = migrationRestartState();
    await assert.doesNotReject(migrationRestartSmoke.assertTeamMigrationRestartState(first));
    await assert.doesNotReject(migrationRestartSmoke.assertTeamMigrationRestartState(second));

    const firstIds = [...first.probeState.observedParticipantProbeIds];
    const secondIds = [...second.probeState.observedParticipantProbeIds];
    assert.equal(firstIds.length, 4);
    assert.equal(secondIds.length, 4);
    assert.ok(firstIds.every((id) => uuidV4.test(id)));
    assert.ok(secondIds.every((id) => uuidV4.test(id)));
    assert.equal(firstIds.some((id) => second.probeState.observedParticipantProbeIds.has(id)), false);
    assert.deepEqual(new Set(first.probeState.cleanupParticipantProbeIds), new Set(firstIds));
    assert.deepEqual(new Set(second.probeState.cleanupParticipantProbeIds), new Set(secondIds));
    assertCompletedProbeLifecycle(first.probeState, { savepointRollbacks: 9 });
    assertCompletedProbeLifecycle(second.probeState, { savepointRollbacks: 9 });
  });

  await t.test("former hardcoded probe IDs may pre-exist without collision or cleanup misclassification", async () => {
    const state = migrationRestartState({
      initialParticipantIds: FORMER_HARDCODED_PROBE_IDS
    });
    await assert.doesNotReject(migrationRestartSmoke.assertTeamMigrationRestartState(state));

    const generatedIds = [...state.probeState.observedParticipantProbeIds];
    assert.equal(generatedIds.length, 4);
    assert.ok(generatedIds.every((id) => uuidV4.test(id)));
    assert.equal(generatedIds.some((id) => FORMER_HARDCODED_PROBE_IDS.includes(id)), false);
    assert.deepEqual(
      new Set(state.probeState.cleanupParticipantProbeIds),
      new Set(generatedIds)
    );
    assert.deepEqual(state.probeState.participantIds, new Set(FORMER_HARDCODED_PROBE_IDS));
    assertCompletedProbeLifecycle(state.probeState, { savepointRollbacks: 9 });
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
