import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const fileLocks = new Map();
const MAX_RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_AUTH_STATE_RETRIES = 100;

function sameDigest(left, right) {
  const expected = Buffer.from(String(left || ""), "hex");
  const actual = Buffer.from(String(right || ""), "hex");
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}

function exclusive(lockKey, operation) {
  const previous = fileLocks.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  fileLocks.set(lockKey, current);
  return current.finally(() => {
    if (fileLocks.get(lockKey) === current) fileLocks.delete(lockKey);
  });
}

function emptyState() {
  return { rateBuckets: {}, challenges: {} };
}

export function createFileAuthState(filePath) {
  async function read() {
    try {
      const state = JSON.parse(await fs.readFile(filePath, "utf8"));
      state.rateBuckets ||= {};
      state.challenges ||= {};
      return state;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return emptyState();
    }
  }

  async function write(state) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state), "utf8");
  }

  return {
    consumeRateLimits(rules, now = Date.now()) {
      return exclusive(filePath, async () => {
        const state = await read();
        for (const [key, events] of Object.entries(state.rateBuckets)) {
          if (!events.length || events.at(-1) <= now - MAX_RATE_WINDOW_MS) delete state.rateBuckets[key];
        }
        let allowed = true;
        const prepared = rules.map((rule) => {
          const events = (state.rateBuckets[rule.key] || []).filter((time) => time > now - rule.windowMs);
          if (events.length >= rule.limit || (rule.cooldownMs && events.at(-1) > now - rule.cooldownMs)) allowed = false;
          return { rule, events };
        });
        for (const { rule, events } of prepared) {
          if (allowed) events.push(now);
          if (events.length) state.rateBuckets[rule.key] = events;
          else delete state.rateBuckets[rule.key];
        }
        await write(state);
        return allowed;
      });
    },
    clearRateLimit(key) {
      return exclusive(filePath, async () => {
        const state = await read();
        delete state.rateBuckets[key];
        await write(state);
      });
    },
    releaseRateLimits(keys, eventTime) {
      return exclusive(filePath, async () => {
        const state = await read();
        for (const key of keys) {
          const events = state.rateBuckets[key] || [];
          const index = events.lastIndexOf(eventTime);
          if (index >= 0) events.splice(index, 1);
          if (!events.length) delete state.rateBuckets[key];
        }
        await write(state);
      });
    },
    saveChallenge(challenge, { enabled = true } = {}) {
      return exclusive(filePath, async () => {
        const state = await read();
        if (enabled) state.challenges[challenge.phone] = { ...challenge, attempts: challenge.attempts || 0 };
        else delete state.challenges[challenge.phone];
        await write(state);
      });
    },
    deleteChallenge(phone, digest) {
      return exclusive(filePath, async () => {
        const state = await read();
        if (!digest || state.challenges[phone]?.digest === digest) delete state.challenges[phone];
        await write(state);
      });
    },
    consumeChallenge({ phone, digest, now = Date.now(), maxAttempts }) {
      return exclusive(filePath, async () => {
        const state = await read();
        for (const [key, item] of Object.entries(state.challenges)) {
          if (item.expiresAt <= now) delete state.challenges[key];
        }
        const challenge = state.challenges[phone];
        if (!challenge || challenge.expiresAt <= now) {
          delete state.challenges[phone];
          await write(state);
          return false;
        }
        if (!sameDigest(challenge.digest, digest)) {
          challenge.attempts = (challenge.attempts || 0) + 1;
          if (challenge.attempts >= maxAttempts) delete state.challenges[phone];
          await write(state);
          return false;
        }
        delete state.challenges[phone];
        await write(state);
        return true;
      });
    }
  };
}

export function createPostgresAuthState(pool) {
  function conflict() {
    const error = new Error("auth state changed concurrently");
    error.code = "AUTH_STATE_CONFLICT";
    return error;
  }

  return {
    async consumeRateLimits(rules, now = Date.now()) {
      for (let attempt = 0; attempt < MAX_AUTH_STATE_RETRIES; attempt += 1) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DELETE FROM auth_rate_buckets WHERE updated_at <= $1", [new Date(now - MAX_RATE_WINDOW_MS)]);
          const prepared = [];
          let allowed = true;
          for (const rule of [...rules].sort((left, right) => left.key.localeCompare(right.key))) {
            const inserted = await client.query(
              "INSERT INTO auth_rate_buckets (key, events, updated_at) VALUES ($1, '[]'::jsonb, $2) ON CONFLICT (key) DO NOTHING RETURNING key",
              [rule.key, new Date(now)]
            );
            const result = await client.query("SELECT events, version FROM auth_rate_buckets WHERE key = $1 FOR UPDATE", [rule.key]);
            const originalEvents = (result.rows[0]?.events || []).map(Number);
            const events = originalEvents.filter((time) => time > now - rule.windowMs);
            if (events.length >= rule.limit || (rule.cooldownMs && events.at(-1) > now - rule.cooldownMs)) allowed = false;
            prepared.push({
              rule,
              events,
              version: result.rows[0].version,
              needsCleanup: events.length !== originalEvents.length,
              wasInserted: inserted.rowCount === 1
            });
          }
          for (const { rule, events, version, needsCleanup, wasInserted } of prepared) {
            if (!allowed && events.length === 0) {
              await client.query(
                "DELETE FROM auth_rate_buckets WHERE key = $1 AND version = $2 AND events = '[]'::jsonb",
                [rule.key, version]
              );
              continue;
            }
            if (!allowed && !needsCleanup && !wasInserted) continue;
            if (allowed) events.push(now);
            const updated = await client.query(
              "UPDATE auth_rate_buckets SET events = $2::jsonb, updated_at = $3, version = version + 1 WHERE key = $1 AND version = $4 RETURNING key",
              [rule.key, JSON.stringify(events), new Date(now), version]
            );
            if (updated.rowCount !== 1) throw conflict();
          }
          await client.query("COMMIT");
          return allowed;
        } catch (error) {
          await client.query("ROLLBACK");
          if (error.code === "AUTH_STATE_CONFLICT" && attempt < MAX_AUTH_STATE_RETRIES - 1) {
            continue;
          }
          if (error.code === "AUTH_STATE_CONFLICT") return false;
          throw error;
        } finally {
          client.release();
        }
      }
      throw conflict();
    },
    async clearRateLimit(key) {
      await pool.query("DELETE FROM auth_rate_buckets WHERE key = $1", [key]);
    },
    async releaseRateLimits(keys, eventTime) {
      for (let attempt = 0; attempt < MAX_AUTH_STATE_RETRIES; attempt += 1) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const key of [...keys].sort()) {
            const result = await client.query("SELECT events, version FROM auth_rate_buckets WHERE key = $1 FOR UPDATE", [key]);
            if (result.rowCount === 0) continue;
            const events = (result.rows[0]?.events || []).map(Number);
            const index = events.lastIndexOf(eventTime);
            if (index >= 0) events.splice(index, 1);
            const changed = events.length
              ? await client.query(
                "UPDATE auth_rate_buckets SET events = $2::jsonb, version = version + 1 WHERE key = $1 AND version = $3 RETURNING key",
                [key, JSON.stringify(events), result.rows[0].version]
              )
              : await client.query("DELETE FROM auth_rate_buckets WHERE key = $1 AND version = $2 RETURNING key", [key, result.rows[0].version]);
            if (changed.rowCount !== 1) throw conflict();
          }
          await client.query("COMMIT");
          return;
        } catch (error) {
          await client.query("ROLLBACK");
          if (error.code === "AUTH_STATE_CONFLICT" && attempt < MAX_AUTH_STATE_RETRIES - 1) {
            continue;
          }
          if (error.code === "AUTH_STATE_CONFLICT") return;
          throw error;
        } finally {
          client.release();
        }
      }
      throw conflict();
    },
    async saveChallenge(challenge, { enabled = true } = {}) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO password_reset_challenges (phone, digest, expires_at, attempts)
           SELECT $1, $2, $3::timestamptz, $4::integer WHERE $5::boolean = TRUE
           ON CONFLICT (phone) DO UPDATE SET digest = EXCLUDED.digest, expires_at = EXCLUDED.expires_at,
             attempts = EXCLUDED.attempts, version = password_reset_challenges.version + 1`,
          [challenge.phone, challenge.digest, new Date(challenge.expiresAt), challenge.attempts || 0, enabled]
        );
        await client.query("DELETE FROM password_reset_challenges WHERE phone = $1 AND $2::boolean = FALSE", [challenge.phone, enabled]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async deleteChallenge(phone, digest) {
      if (digest) {
        await pool.query("DELETE FROM password_reset_challenges WHERE phone = $1 AND digest = $2", [phone, digest]);
      } else {
        await pool.query("DELETE FROM password_reset_challenges WHERE phone = $1", [phone]);
      }
    },
    async consumeChallenge({ phone, digest, now = Date.now(), maxAttempts }) {
      await pool.query("DELETE FROM password_reset_challenges WHERE expires_at <= $1", [new Date(now)]);
      for (let attempt = 0; attempt < MAX_AUTH_STATE_RETRIES; attempt += 1) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query("SELECT digest, expires_at, attempts, version FROM password_reset_challenges WHERE phone = $1 FOR UPDATE", [phone]);
          const challenge = result.rows[0];
          if (!challenge) {
            await client.query("COMMIT");
            return false;
          }
          let changed;
          if (!sameDigest(challenge.digest, digest)) {
            if (challenge.attempts + 1 >= maxAttempts) {
              changed = await client.query("DELETE FROM password_reset_challenges WHERE phone = $1 AND version = $2 RETURNING phone", [phone, challenge.version]);
            } else {
              changed = await client.query(
                "UPDATE password_reset_challenges SET attempts = attempts + 1, version = version + 1 WHERE phone = $1 AND version = $2 RETURNING phone",
                [phone, challenge.version]
              );
            }
            if (changed.rowCount !== 1) throw conflict();
            await client.query("COMMIT");
            return false;
          }
          changed = await client.query("DELETE FROM password_reset_challenges WHERE phone = $1 AND version = $2 RETURNING phone", [phone, challenge.version]);
          if (changed.rowCount !== 1) throw conflict();
          await client.query("COMMIT");
          return true;
        } catch (error) {
          await client.query("ROLLBACK");
          if (error.code === "AUTH_STATE_CONFLICT" && attempt < MAX_AUTH_STATE_RETRIES - 1) {
            continue;
          }
          if (error.code === "AUTH_STATE_CONFLICT") return false;
          throw error;
        } finally {
          client.release();
        }
      }
      throw conflict();
    }
  };
}
