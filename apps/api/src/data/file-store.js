import fs from "node:fs/promises";
import path from "node:path";

import { ensureDbShape, seedDb } from "./seed.js";
import { createFileAuthState } from "./auth-state.js";

export function createFileStore(dbPath) {
  let tail = Promise.resolve();
  return {
    kind: "file",
    authState: createFileAuthState(`${dbPath}.auth.json`),
    async initialize() {},
    async readDb() {
      try {
        return ensureDbShape(JSON.parse(await fs.readFile(dbPath, "utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const initial = ensureDbShape(structuredClone(seedDb));
        await this.writeDb(initial);
        return initial;
      }
    },
    async writeDb(db) {
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.writeFile(dbPath, JSON.stringify(ensureDbShape(structuredClone(db)), null, 2), "utf8");
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
