import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importLeaderCleanupFallbackJournal } from "../src/files/cleanup-fallback-journal.js";

function marker(root, id, fileName) {
  return {
    id,
    filePath: path.join(root, "organization-leader-documents", id, fileName),
    category: "organization-leader-documents",
    attempts: 3,
    lastError: "cleanup failed",
    createdAt: "2026-08-07T10:00:00.000Z",
    lastAttemptAt: "2026-08-07T10:00:00.000Z"
  };
}

async function withFallbackJournal(lines, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "leader-fallback-corrupt-"));
  const previous = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = root;
  const journalDirectory = path.join(root, ".cleanup-journal");
  const journalPath = path.join(journalDirectory, "organization-leader-orphans.jsonl");
  await fs.mkdir(journalDirectory, { recursive: true });
  await fs.writeFile(journalPath, lines.join("\n"), "utf8");
  try {
    await run({ root, journalDirectory, journalPath });
  } finally {
    if (previous === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function memoryStore() {
  let db = { fileCleanupJournal: [] };
  return {
    readDb: async () => structuredClone(db),
    writeDb: async (next) => { db = structuredClone(next); },
    snapshot: () => structuredClone(db)
  };
}

test("fallback import quarantines a corrupt middle line while importing every valid marker once", async () => {
  const warnings = [];
  const store = memoryStore();
  await withFallbackJournal([], async ({ root, journalDirectory, journalPath }) => {
    const first = marker(root, "CLN-VALID-1", "first.pdf");
    const second = marker(root, "CLN-VALID-2", "second.pdf");
    await fs.writeFile(journalPath, `${JSON.stringify(first)}\n{broken json}\n${JSON.stringify(second)}\n`, "utf8");

    const result = await importLeaderCleanupFallbackJournal({
      store,
      logger: { warn: (...args) => warnings.push(args) }
    });

    assert.deepEqual(result, { imported: 2, duplicates: 0, quarantined: 1 });
    assert.deepEqual(store.snapshot().fileCleanupJournal.map((row) => row.id), [first.id, second.id]);
    await assert.rejects(fs.access(journalPath), { code: "ENOENT" });
    const quarantineFiles = (await fs.readdir(journalDirectory)).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantineFiles.length, 1);
    assert.equal(await fs.readFile(path.join(journalDirectory, quarantineFiles[0]), "utf8"), "{broken json}\n");
    assert.match(String(warnings[0]?.[0] || ""), /quarantined/i);

    assert.deepEqual(await importLeaderCleanupFallbackJournal({ store }), { imported: 0, duplicates: 0 });
    assert.equal(store.snapshot().fileCleanupJournal.length, 2);
  });
});

test("fallback import preserves a truncated tail as evidence and still imports the complete prefix", async () => {
  const store = memoryStore();
  await withFallbackJournal([], async ({ root, journalDirectory, journalPath }) => {
    const valid = marker(root, "CLN-VALID-PREFIX", "prefix.pdf");
    const truncated = '{"id":"CLN-TRUNCATED"';
    await fs.writeFile(journalPath, `${JSON.stringify(valid)}\n${truncated}`, "utf8");

    const result = await importLeaderCleanupFallbackJournal({ store, logger: { warn() {} } });

    assert.deepEqual(result, { imported: 1, duplicates: 0, quarantined: 1 });
    assert.deepEqual(store.snapshot().fileCleanupJournal.map((row) => row.id), [valid.id]);
    const quarantineFiles = (await fs.readdir(journalDirectory)).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantineFiles.length, 1);
    assert.equal(await fs.readFile(path.join(journalDirectory, quarantineFiles[0]), "utf8"), `${truncated}\n`);
  });
});
