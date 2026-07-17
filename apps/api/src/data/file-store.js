import fs from "node:fs/promises";
import path from "node:path";

import { ensureDbShape, seedDb } from "./seed.js";

export function createFileStore(dbPath) {
  return {
    kind: "file",
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
    async close() {}
  };
}
