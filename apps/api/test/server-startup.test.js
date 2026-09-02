import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "../../..");
const serverPath = path.resolve(import.meta.dirname, "../src/server.js");

async function startWithIdentityKey(value, options = {}) {
  const sessionSecret = Object.hasOwn(options, "sessionSecret")
    ? options.sessionSecret
    : "startup-session-secret-32-characters";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-startup-key-"));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: "0",
    DB_PATH: path.join(tempDir, "db.json"),
    UPLOAD_ROOT: path.join(tempDir, "uploads"),
    TEMP_PASSWORD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
  };
  if (value === undefined) delete env.REGISTRATION_ID_ENCRYPTION_KEY;
  else env.REGISTRATION_ID_ENCRYPTION_KEY = value;
  if (sessionSecret === undefined) delete env.SESSION_SECRET;
  else env.SESSION_SECRET = sessionSecret;

  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let observedListening = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`API startup did not settle: ${stderr}`));
      }, 10_000);
      const poll = setInterval(() => {
        if (!stdout.includes("API listening on http://localhost:")) return;
        observedListening = true;
        clearInterval(poll);
        clearTimeout(timeout);
        child.kill();
      }, 10);
      child.once("exit", (code) => {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve({ code, listened: observedListening, stdout, stderr });
      });
    });
  } finally {
    if (child.exitCode === null) child.kill();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("API startup rejects missing and invalid registration identity keys before listening", async () => {
  const cases = [
    [undefined, /REGISTRATION_ID_ENCRYPTION_KEY is required/],
    ["not base64!", /must be valid base64/],
    [Buffer.alloc(31, 8).toString("base64"), /must decode to exactly 32 bytes/]
  ];

  for (const [value, expectedError] of cases) {
    const result = await startWithIdentityKey(value);
    assert.equal(result.listened, false, `server listened with key ${String(value)}`);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, expectedError);
  }
});

test("API startup rejects a missing session secret instead of using a public test fallback", async () => {
  const result = await startWithIdentityKey(Buffer.alloc(32, 8).toString("base64"), { sessionSecret: undefined });
  assert.equal(result.listened, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /SESSION_SECRET is required/);
});
