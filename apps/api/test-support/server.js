import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPhoneRegistrationToken } from "../src/auth/sms-registration.js";

const rootDir = path.resolve(import.meta.dirname, "../../..");
const serverPath = path.resolve(import.meta.dirname, "../src/server.js");

function waitForAddress(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`API server did not start in time: ${stderr}`)), 30_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/API listening on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`API server exited before becoming ready (${code}): ${stderr}`));
    });
  });
}

export async function withTestServer(fn, {
  prefix = "aerogp-api-",
  env = {},
  approvedOrganizationLeaders = true
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tempDir, "db.json");
  const sessionSecret = env.SESSION_SECRET || "test-session-secret-32-characters";
  const phoneVerificationToken = (phone) => createPhoneRegistrationToken({
    phone,
    secret: sessionSecret,
    now: Date.now(),
    nonce: `test-${String(phone).replace(/\D/g, "")}`
  }).phoneVerificationToken;
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: "0",
      DB_PATH: dbPath,
      UPLOAD_ROOT: path.join(tempDir, "uploads"),
      TEMP_PASSWORD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      REGISTRATION_ID_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
      SESSION_SECRET: sessionSecret,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const baseUrl = await waitForAddress(child);
    if (approvedOrganizationLeaders) {
      const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
      db.organizationLeaders = (db.organizations || []).map((organization, index) => ({
        id: `OL-TEST-${index + 1}`,
        organizationId: organization.id,
        name: `测试领队${index + 1}`,
        phone: `1380000090${index + 1}`,
        email: "",
        notes: "",
        currentDocumentId: null,
        reviewStatus: "approved",
        rejectionReason: "",
        enabled: true,
        submissionVersion: 1,
        reviewedBy: "U9001",
        reviewedAt: "2026-08-07T00:00:00.000Z",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z"
      }));
      await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
    }
    await fn({ baseUrl, dbPath, tempDir, phoneVerificationToken });
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
