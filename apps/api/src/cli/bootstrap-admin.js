import crypto from "node:crypto";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { hashPassword, validatePassword } from "../auth/passwords.js";

function publicUser(user) {
  const { password, sessionVersion, ...safe } = user;
  return safe;
}

function parseOption(args, name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || "";
}

async function withTransaction(client, work) {
  const connection = typeof client.connect === "function" ? await client.connect() : client;
  try {
    await connection.query("BEGIN");
    const result = await work(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    try { await connection.query("ROLLBACK"); } catch { /* retain original error */ }
    throw error;
  } finally {
    connection.release?.();
  }
}

export async function bootstrapAdmin(client, input) {
  const normalizedName = String(input?.name || "").trim();
  const normalizedPhone = String(input?.phone || "").trim();
  let secret = String(input?.password || "");
  if (!normalizedName || !normalizedPhone) throw new Error("Administrator name and phone are required");
  const passwordError = validatePassword(secret);
  if (passwordError) throw new Error(passwordError);

  try {
    const passwordHash = await hashPassword(secret);
    secret = "";
    if (input && typeof input === "object") input.password = "";
    return await withTransaction(client, async (connection) => {
      const existing = await connection.query("SELECT 1 FROM users WHERE type = 'admin' LIMIT 1");
      if (existing.rowCount > 0) throw new Error("Administrator already exists");
      const user = {
        id: `U${crypto.randomUUID()}`,
        name: normalizedName,
        phone: normalizedPhone,
        password: passwordHash,
        type: "admin",
        status: "active",
        sessionVersion: 0,
        mustChangePassword: false,
        createdAt: new Date().toISOString()
      };
      await connection.query(
        `INSERT INTO users
          (id, name, phone, password, type, status, session_version, must_change_password, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [user.id, user.name, user.phone, user.password, user.type, user.status, user.sessionVersion, user.mustChangePassword, user.createdAt]
      );
      return publicUser(user);
    });
  } finally {
    secret = "";
    if (input && typeof input === "object") input.password = "";
  }
}

async function readPasswordFromStdin() {
  const terminal = readline.createInterface({ input: process.stdin, terminal: false });
  try {
    return await terminal.question("");
  } finally {
    terminal.close();
  }
}

export async function runBootstrapAdmin({
  client,
  args = process.argv.slice(2),
  readPassword = readPasswordFromStdin,
  write = (chunk) => process.stdout.write(chunk)
} = {}) {
  const name = parseOption(args, "name");
  const phone = parseOption(args, "phone");
  if (!args.includes("--password-stdin")) throw new Error("--password-stdin is required");
  let password = await readPassword();
  try {
    const user = await bootstrapAdmin(client, { name, phone, password });
    write(`${JSON.stringify(user)}\n`);
    return user;
  } finally {
    password = "";
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await runBootstrapAdmin({ client: pool });
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
