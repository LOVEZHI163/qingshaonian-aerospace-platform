import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const FALLBACK_DIRECTORY = ".cleanup-journal";
const LEADER_FALLBACK_FILE = "organization-leader-orphans.jsonl";

function uploadRoot() {
  return path.resolve(process.env.UPLOAD_ROOT || "/data/uploads");
}

function assertManagedFile(filePath) {
  const root = uploadRoot();
  const resolved = path.resolve(String(filePath || ""));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Cleanup fallback target escapes upload root");
  }
  return resolved;
}

function journalPath() {
  return path.join(uploadRoot(), FALLBACK_DIRECTORY, LEADER_FALLBACK_FILE);
}

function fallbackMarker(marker) {
  return {
    id: String(marker.id),
    filePath: assertManagedFile(marker.filePath),
    category: "organization-leader-documents",
    attempts: Number(marker.attempts || 0),
    lastError: String(marker.lastError || "cleanup failed"),
    createdAt: String(marker.createdAt),
    lastAttemptAt: String(marker.lastAttemptAt)
  };
}

export async function appendLeaderCleanupFallback(marker, { fileSystem = fs } = {}) {
  const entry = fallbackMarker(marker);
  const filePath = journalPath();
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await fileSystem.open(filePath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { filePath };
}

async function readFallbackEntries(fileSystem) {
  const filePath = journalPath();
  let contents;
  try {
    contents = await fileSystem.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { filePath, entries: [], corrupt: [] };
    throw error;
  }
  const entries = [];
  const corrupt = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(fallbackMarker(JSON.parse(line)));
    } catch (error) {
      corrupt.push({ line, lineNumber: index + 1, error: String(error?.message || error) });
    }
  }
  return { filePath, entries, corrupt };
}

async function quarantineCorruptEntries(fileSystem, filePath, corrupt) {
  const evidence = `${corrupt.map((entry) => entry.line).join("\n")}\n`;
  const digest = createHash("sha256").update(evidence).digest("hex").slice(0, 16);
  const quarantinePath = `${filePath}.corrupt-${digest}.jsonl`;
  let handle;
  let created = false;
  let writeError = null;
  try {
    handle = await fileSystem.open(quarantinePath, "wx", 0o600);
    created = true;
    await handle.writeFile(evidence, "utf8");
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally {
    await handle?.close();
  }
  if (writeError?.code === "EEXIST") {
    const existing = await fileSystem.readFile(quarantinePath, "utf8");
    if (existing !== evidence) throw new Error("Cleanup fallback quarantine evidence mismatch");
  } else if (writeError) {
    if (created) await fileSystem.rm(quarantinePath, { force: true }).catch(() => {});
    throw writeError;
  }
  return quarantinePath;
}

export async function importLeaderCleanupFallbackJournal({ store, fileSystem = fs, logger = console }) {
  const importEntries = async () => {
    const { filePath, entries, corrupt } = await readFallbackEntries(fileSystem);
    if (!entries.length && !corrupt.length) return { imported: 0, duplicates: 0 };
    let quarantinePath = "";
    if (corrupt.length) {
      quarantinePath = await quarantineCorruptEntries(fileSystem, filePath, corrupt);
      try {
        logger?.warn?.("Corrupt cleanup fallback records quarantined; inspect the quarantine file before deleting it", {
          journalPath: filePath,
          quarantinePath,
          corruptLineNumbers: corrupt.map((entry) => entry.lineNumber)
        });
      } catch { /* logging must not block recovery after evidence is durable */ }
    }
    const db = await store.readDb();
    db.fileCleanupJournal ||= [];
    const knownIds = new Set(db.fileCleanupJournal.map((row) => row.id));
    const knownPaths = new Set(db.fileCleanupJournal.map((row) => row.filePath));
    let imported = 0;
    let duplicates = 0;
    for (const marker of entries) {
      if (knownIds.has(marker.id) || knownPaths.has(marker.filePath)) {
        duplicates += 1;
        continue;
      }
      db.fileCleanupJournal.push(marker);
      knownIds.add(marker.id);
      knownPaths.add(marker.filePath);
      imported += 1;
    }
    if (imported) await store.writeDb(db);
    await fileSystem.rm(filePath, { force: true });
    return {
      imported,
      duplicates,
      ...(corrupt.length ? { quarantined: corrupt.length } : {})
    };
  };
  return store.withMutationLock ? store.withMutationLock(importEntries) : importEntries();
}
