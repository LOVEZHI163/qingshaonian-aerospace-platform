const SMOKE_DATABASE_PATTERN = /^aerogp_migration_smoke_[0-9a-f]{32}$/;

export function parseIsolatedSmokeTarget(environment = process.env) {
  const connectionString = environment.DATABASE_URL || "";
  const databaseName = environment.MIGRATION_SMOKE_DATABASE || "";
  let urlDatabase = "";
  try {
    urlDatabase = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL must identify an isolated migration smoke database");
  }
  if (!SMOKE_DATABASE_PATTERN.test(databaseName) || urlDatabase !== databaseName) {
    throw new Error("DATABASE_URL must identify an isolated migration smoke database");
  }
  return { connectionString, databaseName };
}

export async function assertEmptySmokeDatabase(pool, expectedDatabase) {
  const result = await pool.query(`
    SELECT
      current_database() AS database_name,
      (
        SELECT COUNT(*)::integer
        FROM pg_catalog.pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ) AS user_table_count,
      to_regclass('public.schema_migrations') IS NOT NULL AS has_schema_migrations
  `);
  const state = result.rows[0];
  if (state?.database_name !== expectedDatabase) {
    throw new Error("migration smoke connected to an unexpected database");
  }
  if (Number(state.user_table_count) !== 0 || state.has_schema_migrations === true) {
    throw new Error("isolated migration smoke database must be empty before initialization");
  }
}
