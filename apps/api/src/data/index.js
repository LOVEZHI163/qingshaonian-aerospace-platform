import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { createFileStore } from "./file-store.js";
import { createPostgresStore } from "./postgres-store.js";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");

export function createDataStore(env = process.env) {
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: Number(env.DATABASE_POOL_SIZE || 10)
    });
    return createPostgresStore(pool, {
      seedOnEmpty: env.NODE_ENV === "test" || env.SEED_DEMO_DATA === "true"
    });
  }
  const dbPath = env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, "db.json");
  return createFileStore(dbPath);
}
