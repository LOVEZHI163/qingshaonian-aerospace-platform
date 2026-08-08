import pg from "pg";

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
    const registration = initial.registrations[0];
    if (!registration) throw new Error("migration smoke seed registration is missing");
    await first.pool.query(
      `INSERT INTO registration_identities
        (registration_id, ciphertext, iv, auth_tag, key_version, id_fingerprint, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, NOW(), NOW())`,
      [registration.id, marker, "migration-smoke-iv", "migration-smoke-auth-tag", "migration-smoke-fingerprint"]
    );
    await first.close();
    first = null;

    restarted = await openStore(connectionString);
    const afterRestart = await restarted.readDb();
    const persisted = afterRestart.registrationIdentities.find((row) => row.registrationId === registration.id);
    if (persisted?.ciphertext !== marker) {
      throw new Error("registration identity did not survive PostgreSQL store restart");
    }

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

runPostgresMigrationRestartSmoke()
  .then(() => {
    process.stdout.write("PostgreSQL migration/restart smoke passed.\n");
  })
  .catch((error) => {
    process.stderr.write(`PostgreSQL migration/restart smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  });
