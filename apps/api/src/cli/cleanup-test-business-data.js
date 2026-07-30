import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  executeTestBusinessCleanup,
  previewTestBusinessCleanup
} from "../services/test-business-cleanup.js";

const CONFIRMATION_TOKEN = "DELETE-TEST-BUSINESS-DATA";

export async function runCleanupCommand({
  client,
  uploadRoot = process.env.UPLOAD_ROOT,
  args = process.argv.slice(2),
  write = (chunk) => process.stdout.write(chunk)
} = {}) {
  const confirmed = args.includes(`--confirm=${CONFIRMATION_TOKEN}`);
  const preview = await previewTestBusinessCleanup(client);
  write(`${JSON.stringify(preview, null, 2)}\n`);
  if (!confirmed) {
    write("Preview only. No data was deleted.\n");
    return { executed: false, preview };
  }
  const result = await executeTestBusinessCleanup(client, uploadRoot);
  write(`${JSON.stringify(result, null, 2)}\n`);
  return { executed: true, preview, result };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!process.env.UPLOAD_ROOT) throw new Error("UPLOAD_ROOT is required");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await runCleanupCommand({ client: pool });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { CONFIRMATION_TOKEN };
