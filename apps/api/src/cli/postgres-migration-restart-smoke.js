import pg from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createPostgresStore } from "../data/postgres-store.js";
import {
  assertEmptySmokeDatabase,
  parseIsolatedSmokeTarget
} from "./postgres-migration-smoke-safety.js";

const REQUIRED_TABLES = [
  "registration_identities",
  "organization_leaders",
  "organization_leader_documents",
  "organization_leader_reviews"
];
const MIGRATION_NAME = "015-registration-identities-and-organization-leaders.sql";
const TEAM_MIGRATION_NAME = "019-team-registration.sql";
const TEAM_REQUIRED_TABLES = [
  "registration_participants",
  "registration_participant_identities"
];
const TEAM_PROJECT_BOUND_COLUMNS = ["team_min_members", "team_max_members"];
const TEAM_COLUMN_TABLES = [
  "projects",
  "registrations",
  "registration_participants",
  "registration_participant_identities",
  "certificates"
];
const TEAM_COLUMN_CONTRACTS = [
  ["projects", "team_min_members", "smallint", true, "1"],
  ["projects", "team_max_members", "smallint", true, "8"],
  ["registrations", "team_code", "text", true, "''::text"],
  ["registration_participants", "id", "text", true, null],
  ["registration_participants", "registration_id", "text", true, null],
  ["registration_participants", "display_order", "smallint", true, null],
  ["registration_participants", "name", "text", true, null],
  ["registration_participants", "school", "text", true, null],
  ["registration_participants", "grade", "text", true, null],
  ["registration_participants", "phone", "text", true, null],
  ["registration_participants", "created_at", "timestamp with time zone", true, null],
  ["registration_participants", "updated_at", "timestamp with time zone", true, null],
  ["registration_participant_identities", "participant_id", "text", true, null],
  ["registration_participant_identities", "ciphertext", "text", true, null],
  ["registration_participant_identities", "iv", "text", true, null],
  ["registration_participant_identities", "auth_tag", "text", true, null],
  ["registration_participant_identities", "key_version", "integer", true, "1"],
  ["registration_participant_identities", "id_fingerprint", "text", true, null],
  ["registration_participant_identities", "created_at", "timestamp with time zone", true, null],
  ["registration_participant_identities", "updated_at", "timestamp with time zone", true, null],
  ["certificates", "participant_id", "text", false, null]
];
const TEAM_CONSTRAINT_TABLES = [
  "projects",
  "registration_participants",
  "registration_participant_identities",
  "certificates"
];
const TEAM_CONSTRAINT_CONTRACTS = [
  ["projects", "projects_team_member_bounds_check", "c", [
    "check", "team_min_members >= 1", "team_min_members <= 8",
    "team_max_members >= 1", "team_max_members <= 8", "team_min_members <= team_max_members"
  ]],
  ["registration_participants", "registration_participants_pkey", "p", ["primary key(id)"]],
  ["registration_participants", "registration_participants_registration_id_fkey", "f", [
    "foreign key(registration_id)", "references registrations(id)", "on delete cascade"
  ]],
  ["registration_participants", "registration_participants_display_order_check", "c", [
    "check", "display_order >= 1", "display_order <= 8"
  ]],
  ["registration_participants", "registration_participants_registration_id_display_order_key", "u", [
    "unique(registration_id,display_order)"
  ]],
  ["registration_participants", "registration_participants_id_registration_id_key", "u", [
    "unique(id,registration_id)"
  ]],
  ["registration_participant_identities", "registration_participant_identities_pkey", "p", [
    "primary key(participant_id)"
  ]],
  ["registration_participant_identities", "registration_participant_identities_participant_id_fkey", "f", [
    "foreign key(participant_id)", "references registration_participants(id)", "on delete cascade"
  ]],
  ["certificates", "certificates_participant_registration_fkey", "f", [
    "foreign key(participant_id,registration_id)",
    "references registration_participants(id,registration_id)",
    "on delete cascade"
  ]]
];
const TEAM_INDEX_TABLES = ["registration_participant_identities", "certificates"];
const TEAM_INDEX_CONTRACTS = [
  [
    "registration_participant_identities",
    "registration_participant_identity_fingerprint_idx",
    false,
    ["using btree(id_fingerprint)"],
    null
  ],
  [
    "certificates",
    "certificates_registration_slot_legacy_key",
    true,
    ["using btree(registration_id,slot)"],
    "participant_id is null"
  ],
  [
    "certificates",
    "certificates_participant_slot_key",
    true,
    ["using btree(registration_id,participant_id,slot)"],
    "participant_id is not null"
  ]
];

function normalizeCatalogExpression(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function normalizeCatalogPredicate(value) {
  const normalized = normalizeCatalogExpression(value);
  return normalized?.replace(/^\((.*)\)$/, "$1") ?? null;
}

function catalogDefaultMatches(actual, expected) {
  const normalized = normalizeCatalogExpression(actual);
  if (expected === null) return normalized === null;
  if (normalized === expected) return true;
  if (expected === "1") return normalized === "'1'::smallint" || normalized === "'1'::integer";
  if (expected === "8") return normalized === "'8'::smallint";
  return false;
}

async function openStore(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 2 });
  const store = createPostgresStore(pool, { seedOnEmpty: true });
  try {
    await store.initialize();
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

export async function assertTeamMigrationRestartState({
  restarted,
  legacyRegistrationBeforeRestart,
  legacyIdentityBeforeRestart
}) {
  const migration = await restarted.pool.query(
    "SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE name = $1",
    [TEAM_MIGRATION_NAME]
  );
  if (migration.rows[0]?.count !== 1) {
    throw new Error("migration 019 was not recorded exactly once");
  }

  const tables = await restarted.pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [TEAM_REQUIRED_TABLES]
  );
  if (new Set(tables.rows.map((row) => row.table_name)).size !== TEAM_REQUIRED_TABLES.length) {
    throw new Error("migration 019 did not create all required participant tables");
  }

  const projectColumns = await restarted.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'projects'
       AND column_name = ANY($1::text[])`,
    [TEAM_PROJECT_BOUND_COLUMNS]
  );
  if (new Set(projectColumns.rows.map((row) => row.column_name)).size !== TEAM_PROJECT_BOUND_COLUMNS.length) {
    throw new Error("migration 019 did not add both project bound columns");
  }

  const columnCatalog = await restarted.pool.query(
    `SELECT relation.relname AS table_name,
            attribute.attname AS column_name,
            format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
            attribute.attnotnull AS is_not_null,
            pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
       FROM pg_attribute AS attribute
       JOIN pg_class AS relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_attrdef AS default_value
         ON default_value.adrelid = attribute.attrelid
        AND default_value.adnum = attribute.attnum
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped`,
    [TEAM_COLUMN_TABLES]
  );
  const columnsByKey = new Map(columnCatalog.rows.map((row) => (
    [`${row.table_name}.${row.column_name}`, row]
  )));
  for (const [tableName, columnName, dataType, isNotNull, defaultExpression] of TEAM_COLUMN_CONTRACTS) {
    const row = columnsByKey.get(`${tableName}.${columnName}`);
    if (!row
      || row.data_type !== dataType
      || row.is_not_null !== isNotNull
      || !catalogDefaultMatches(row.default_expression, defaultExpression)) {
      throw new Error("migration 019 live column contract is incomplete or malformed");
    }
  }

  const constraintCatalog = await restarted.pool.query(
    `SELECT relation.relname AS table_name,
            constraint_row.conname AS constraint_name,
            constraint_row.contype AS constraint_type,
            constraint_row.convalidated AS is_validated,
            pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])`,
    [TEAM_CONSTRAINT_TABLES]
  );
  const constraintsByKey = new Map(constraintCatalog.rows.map((row) => (
    [`${row.table_name}.${row.constraint_name}`, row]
  )));
  for (const [tableName, constraintName, constraintType, definitionFragments] of TEAM_CONSTRAINT_CONTRACTS) {
    const row = constraintsByKey.get(`${tableName}.${constraintName}`);
    const definition = normalizeCatalogExpression(row?.definition) || "";
    if (!row
      || row.constraint_type !== constraintType
      || row.is_validated !== true
      || definitionFragments.some((fragment) => !definition.includes(fragment))) {
      throw new Error("migration 019 live constraint contract is incomplete or malformed");
    }
  }

  const indexCatalog = await restarted.pool.query(
    `SELECT table_relation.relname AS table_name,
            index_relation.relname AS index_name,
            index_row.indisunique AS is_unique,
            pg_get_indexdef(index_row.indexrelid, 0, true) AS definition,
            pg_get_expr(index_row.indpred, index_row.indrelid, true) AS predicate
       FROM pg_index AS index_row
       JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
       JOIN pg_class AS table_relation ON table_relation.oid = index_row.indrelid
       JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND table_relation.relname = ANY($1::text[])`,
    [TEAM_INDEX_TABLES]
  );
  const indexesByKey = new Map(indexCatalog.rows.map((row) => (
    [`${row.table_name}.${row.index_name}`, row]
  )));
  for (const [tableName, indexName, isUnique, definitionFragments, predicate] of TEAM_INDEX_CONTRACTS) {
    const row = indexesByKey.get(`${tableName}.${indexName}`);
    const definition = normalizeCatalogExpression(row?.definition) || "";
    if (!row
      || row.is_unique !== isUnique
      || definitionFragments.some((fragment) => !definition.includes(fragment))
      || normalizeCatalogPredicate(row.predicate) !== predicate) {
      throw new Error("migration 019 live index contract is incomplete or malformed");
    }
  }

  const afterRestart = await restarted.readDb();
  if (!afterRestart.projects.length || afterRestart.projects.some((project) => (
    !Number.isInteger(project.teamMinMembers)
    || !Number.isInteger(project.teamMaxMembers)
    || project.teamMinMembers < 1
    || project.teamMaxMembers > 8
    || project.teamMinMembers > project.teamMaxMembers
  ))) {
    throw new Error("project bounds did not survive PostgreSQL store restart");
  }

  const legacyRegistrationAfterRestart = afterRestart.registrations.find(
    (row) => row.id === legacyRegistrationBeforeRestart.id
  );
  if (!legacyRegistrationAfterRestart
    || !isDeepStrictEqual(legacyRegistrationAfterRestart, legacyRegistrationBeforeRestart)) {
    throw new Error("legacy personal registration changed during PostgreSQL store restart");
  }

  const legacyIdentityAfterRestart = afterRestart.registrationIdentities.find(
    (row) => row.registrationId === legacyIdentityBeforeRestart.registrationId
  );
  if (!legacyIdentityAfterRestart
    || !isDeepStrictEqual(legacyIdentityAfterRestart, legacyIdentityBeforeRestart)) {
    throw new Error("legacy personal registration identity changed during PostgreSQL store restart");
  }

  return afterRestart;
}

export async function runPostgresMigrationRestartSmoke(environment = process.env) {
  const { connectionString, databaseName } = parseIsolatedSmokeTarget(environment);

  const safetyPool = new pg.Pool({ connectionString, max: 1 });
  try {
    await assertEmptySmokeDatabase(safetyPool, databaseName);
  } finally {
    await safetyPool.end();
  }

  const marker = `migration-smoke-${Date.now()}-${process.pid}`;
  let first;
  let restarted;
  try {
    first = await openStore(connectionString);
    const initial = await first.readDb();
    const registration = initial.registrations.find(
      (row) => row.createdVia === "personal" && row.projectType === "individual"
    );
    if (!registration) throw new Error("migration smoke seed personal registration is missing");
    await first.pool.query(
      `INSERT INTO registration_identities
        (registration_id, ciphertext, iv, auth_tag, key_version, id_fingerprint, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, NOW(), NOW())`,
      [registration.id, marker, "migration-smoke-iv", "migration-smoke-auth-tag", "migration-smoke-fingerprint"]
    );
    const beforeRestart = await first.readDb();
    const legacyRegistrationBeforeRestart = beforeRestart.registrations.find(
      (row) => row.id === registration.id
    );
    const legacyIdentityBeforeRestart = beforeRestart.registrationIdentities.find(
      (row) => row.registrationId === registration.id
    );
    if (!legacyRegistrationBeforeRestart || !legacyIdentityBeforeRestart) {
      throw new Error("migration smoke legacy personal fixture is incomplete");
    }
    await first.close();
    first = null;

    restarted = await openStore(connectionString);
    await assertTeamMigrationRestartState({
      restarted,
      legacyRegistrationBeforeRestart,
      legacyIdentityBeforeRestart
    });

    const migration = await restarted.pool.query(
      "SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE name = $1",
      [MIGRATION_NAME]
    );
    if (migration.rows[0]?.count !== 1) throw new Error("migration 015 was not recorded exactly once");

    const tables = await restarted.pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES]
    );
    if (new Set(tables.rows.map((row) => row.table_name)).size !== REQUIRED_TABLES.length) {
      throw new Error("migration 015 did not create all required tables");
    }
  } finally {
    await first?.close();
    await restarted?.close();
  }
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  runPostgresMigrationRestartSmoke()
    .then(() => {
      process.stdout.write("team-registration-migration-019=applied-once\n");
      process.stdout.write("PostgreSQL migration/restart smoke passed.\n");
    })
    .catch((error) => {
      process.stderr.write(`PostgreSQL migration/restart smoke failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
