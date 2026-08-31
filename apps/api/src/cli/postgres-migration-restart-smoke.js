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
