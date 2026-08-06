import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DELETED_TABLES = [
  "certificate_import_errors",
  "certificate_import_batches",
  "certificates",
  "results",
  "registrations",
  "organization_event_participations",
  "memberships",
  "organization_documents",
  "organizations",
  "audit_logs",
  "password_reset_challenges",
  "auth_rate_buckets",
  "file_cleanup_journal",
  "session",
  "users"
];

const PRESERVED_TABLES = {
  events: "events",
  projects: "projects",
  projectGroups: "project_groups",
  siteSettings: "site_settings",
  eventPublicProfiles: "event_public_profiles",
  contentPosts: "content_posts",
  mediaAssets: "media_assets",
  contentAttachments: "content_attachments"
};

function isMissingToRegclass(error) {
  return /to_regclass|does not exist|pg-mem implements very few native functions/i.test(String(error?.message || error));
}

async function tableExists(client, tableName) {
  try {
    const result = await client.query("SELECT to_regclass($1) AS name", [tableName]);
    return Boolean(result.rows[0]?.name);
  } catch (error) {
    if (!isMissingToRegclass(error)) throw error;
    const result = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [tableName]
    );
    return result.rowCount > 0;
  }
}

async function presentTables(client, tableNames) {
  const availability = await Promise.all(tableNames.map(async (tableName) => [tableName, await tableExists(client, tableName)]));
  return new Set(availability.filter(([, exists]) => exists).map(([tableName]) => tableName));
}

async function countTable(client, tableName, exists) {
  if (!exists) return 0;
  return Number((await client.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`)).rows[0].count);
}

async function filePathsForCleanup(client, present) {
  const paths = [];
  if (present.has("certificates")) {
    const result = await client.query("SELECT file_path FROM certificates WHERE file_path <> ''");
    paths.push(...result.rows.map((row) => row.file_path));
  }
  if (present.has("organization_documents")) {
    const result = await client.query("SELECT file_path FROM organization_documents WHERE file_path <> ''");
    paths.push(...result.rows.map((row) => row.file_path));
  }
  return [...new Set(paths.filter(Boolean))];
}

function managedUploadPath(uploadRoot, filePath) {
  if (!uploadRoot || !filePath) return null;
  const root = path.resolve(uploadRoot);
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (relative.split(path.sep)[0] === "site-media") return null;
  return resolved;
}

function cleanupJournalRow({ filePath, error, now, makeId }) {
  const createdAt = now();
  return {
    id: makeId(),
    filePath,
    category: "test-business-cleanup",
    attempts: 1,
    lastError: String(error?.message || error).slice(0, 500),
    createdAt,
    lastAttemptAt: createdAt
  };
}

async function withTransaction(client, work) {
  const connection = typeof client.connect === "function" ? await client.connect() : client;
  try {
    await connection.query("BEGIN");
    const value = await work(connection);
    await connection.query("COMMIT");
    return value;
  } catch (error) {
    try { await connection.query("ROLLBACK"); } catch { /* original error is more useful */ }
    throw error;
  } finally {
    connection.release?.();
  }
}

export async function previewTestBusinessCleanup(client) {
  const allTables = [...DELETED_TABLES, ...Object.values(PRESERVED_TABLES)];
  const present = await presentTables(client, allTables);
  const [deletedEntries, preservedEntries, filePaths] = await Promise.all([
    Promise.all(DELETED_TABLES.filter((tableName) => present.has(tableName)).map(async (tableName) => [tableName, await countTable(client, tableName, true)])),
    Promise.all(Object.entries(PRESERVED_TABLES).map(async ([name, tableName]) => [name, await countTable(client, tableName, present.has(tableName))])),
    filePathsForCleanup(client, present)
  ]);
  return {
    preserved: Object.fromEntries(preservedEntries),
    deleted: Object.fromEntries(deletedEntries),
    files: filePaths.length
  };
}

export async function executeTestBusinessCleanup(client, uploadRoot, {
  fileSystem = fs,
  now = () => new Date().toISOString(),
  makeId = () => `FCJ-${crypto.randomUUID()}`
} = {}) {
  const result = await withTransaction(client, async (connection) => {
    const present = await presentTables(connection, DELETED_TABLES);
    const filePaths = await filePathsForCleanup(connection, present);
    const deleted = {};
    for (const tableName of DELETED_TABLES) {
      if (!present.has(tableName)) continue;
      deleted[tableName] = (await connection.query(`DELETE FROM ${tableName}`)).rowCount;
    }
    return { deleted, filePaths };
  });

  const managedFiles = result.filePaths.map((filePath) => managedUploadPath(uploadRoot, filePath)).filter(Boolean);
  const failedFiles = [];
  const journalAvailable = await tableExists(client, "file_cleanup_journal");
  for (const filePath of managedFiles) {
    try {
      await fileSystem.rm(filePath, { force: true });
    } catch (error) {
      failedFiles.push({ filePath, error: String(error?.message || error) });
      if (!journalAvailable) continue;
      const marker = cleanupJournalRow({ filePath, error, now, makeId });
      try {
        await client.query(
          `INSERT INTO file_cleanup_journal
            (id, file_path, category, attempts, last_error, created_at, last_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [marker.id, marker.filePath, marker.category, marker.attempts, marker.lastError, marker.createdAt, marker.lastAttemptAt]
        );
      } catch (journalError) {
        failedFiles.at(-1).journalError = String(journalError?.message || journalError);
      }
    }
  }

  return {
    deleted: result.deleted,
    deletedFiles: managedFiles.length - failedFiles.length,
    failedFiles
  };
}
