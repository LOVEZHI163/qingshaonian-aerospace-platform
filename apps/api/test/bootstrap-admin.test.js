import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { bootstrapAdmin, runBootstrapAdmin } from "../src/cli/bootstrap-admin.js";
import { createPostgresStore } from "../src/data/postgres-store.js";
import { verifyPassword } from "../src/auth/passwords.js";

async function withEmptyDatabase(fn) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool, { seedOnEmpty: false, testOnlyPgMemCompatibility: true });
  try {
    await store.initialize();
    await fn(pool);
  } finally {
    await store.close();
  }
}

test("bootstrapAdmin creates exactly one active administrator with a hash", async () => {
  await withEmptyDatabase(async (pool) => {
    const user = await bootstrapAdmin(pool, {
      name: "赛事管理员",
      phone: "13900000000",
      password: "Strong123"
    });
    assert.deepEqual(Object.keys(user).sort(), ["createdAt", "id", "mustChangePassword", "name", "phone", "status", "type"]);
    assert.equal(user.type, "admin");
    assert.equal(user.status, "active");
    const row = (await pool.query("SELECT password FROM users WHERE id = $1", [user.id])).rows[0];
    assert.equal(await verifyPassword("Strong123", row.password), true);
  });
});

test("bootstrapAdmin rejects weak passwords", async () => {
  await withEmptyDatabase(async (pool) => {
    await assert.rejects(
      bootstrapAdmin(pool, { name: "赛事管理员", phone: "13900000000", password: "weak" }),
      /密码|password/i
    );
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM users")).rows[0].count, 0);
  });
});

test("bootstrapAdmin clears the supplied password reference after hashing", async () => {
  await withEmptyDatabase(async (pool) => {
    const input = { name: "赛事管理员", phone: "13900000000", password: "Strong123" };
    await bootstrapAdmin(pool, input);
    assert.equal(input.password, "");
  });
});

test("bootstrapAdmin refuses to create a second administrator", async () => {
  await withEmptyDatabase(async (pool) => {
    await bootstrapAdmin(pool, { name: "赛事管理员", phone: "13900000000", password: "Strong123" });
    await assert.rejects(
      bootstrapAdmin(pool, { name: "另一个管理员", phone: "13900000001", password: "Strong123" }),
      /administrator already exists/i
    );
  });
});

test("bootstrap command reads stdin and never echoes the submitted password", async () => {
  await withEmptyDatabase(async (pool) => {
    let output = "";
    await runBootstrapAdmin({
      client: pool,
      args: ["--name=赛事管理员", "--phone=13900000000", "--password-stdin"],
      readPassword: async () => "Strong123",
      write: (chunk) => { output += chunk; }
    });
    assert.equal(output.includes("Strong123"), false);
    assert.match(output, /13900000000/);
  });
});
