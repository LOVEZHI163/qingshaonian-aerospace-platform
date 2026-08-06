import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ensureDbShape, seedDb } from "./seed.js";
import { createFileAuthState } from "./auth-state.js";

export function createFileStore(dbPath, {
  fileSystem = fs,
  makeTempPath = () => path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.${process.pid}.${randomUUID()}.tmp`)
} = {}) {
  let tail = Promise.resolve();
  return {
    kind: "file",
    authState: createFileAuthState(`${dbPath}.auth.json`),
    async initialize() {},
    async readDb() {
      try {
        return ensureDbShape(JSON.parse(await fileSystem.readFile(dbPath, "utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const initial = ensureDbShape(structuredClone(seedDb));
        await this.writeDb(initial);
        return initial;
      }
    },
    async writeDb(db) {
      await fileSystem.mkdir(path.dirname(dbPath), { recursive: true });
      const tempPath = makeTempPath();
      try {
        await fileSystem.writeFile(
          tempPath,
          JSON.stringify(ensureDbShape(structuredClone(db)), null, 2),
          { encoding: "utf8", flag: "wx" }
        );
        await fileSystem.rename(tempPath, dbPath);
      } catch (error) {
        try { await fileSystem.rm(tempPath, { force: true }); } catch { /* best-effort cleanup */ }
        throw error;
      }
    },
    async acquireMutationLock() {
      let unlock;
      const previous = tail;
      tail = new Promise((resolve) => { unlock = resolve; });
      await previous;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        unlock();
      };
    },
    async withMutationLock(handler) {
      const release = await this.acquireMutationLock();
      try {
        return await handler();
      } finally {
        await release();
      }
    },
    async close() {}
  };
}
