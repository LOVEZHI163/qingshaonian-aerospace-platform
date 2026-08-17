import { randomUUID } from "node:crypto";

const PURPOSES = new Set(["verify_email", "reset_password"]);

function assertPurpose(purpose) {
  if (!PURPOSES.has(purpose)) throw new Error("Invalid account email token purpose");
}

function active(row, { digest, purpose, now }) {
  return row.digest === digest
    && row.purpose === purpose
    && !row.usedAt
    && new Date(row.expiresAt).getTime() > new Date(now).getTime();
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    targetEmail: row.target_email,
    digest: row.digest,
    expiresAt: new Date(row.expires_at).toISOString(),
    usedAt: row.used_at ? new Date(row.used_at).toISOString() : null,
    requestIp: row.request_ip,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export function createAccountEmailTokenStore({ readDb, writeDb, pool, withMutationLock } = {}) {
  if (pool) {
    return {
      async replace(input) {
        assertPurpose(input.purpose);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "DELETE FROM account_email_tokens WHERE user_id = $1 AND purpose = $2",
            [input.userId, input.purpose]
          );
          await client.query(
            `INSERT INTO account_email_tokens
              (id, user_id, purpose, target_email, digest, expires_at, used_at, request_ip, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
            [randomUUID(), input.userId, input.purpose, input.targetEmail, input.digest, input.expiresAt, input.requestIp || "", input.createdAt]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async inspect({ digest, purpose, now }) {
        assertPurpose(purpose);
        const result = await pool.query(
          `SELECT * FROM account_email_tokens
           WHERE digest = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3`,
          [digest, purpose, now]
        );
        return fromRow(result.rows[0]);
      },
      async consume({ digest, purpose, now }) {
        assertPurpose(purpose);
        const result = await pool.query(
          `UPDATE account_email_tokens
           SET used_at = $3
           WHERE digest = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
           RETURNING *`,
          [digest, purpose, now]
        );
        return fromRow(result.rows[0]);
      },
      async revokeUserPurpose(userId, purpose) {
        assertPurpose(purpose);
        await pool.query("DELETE FROM account_email_tokens WHERE user_id = $1 AND purpose = $2", [userId, purpose]);
      }
    };
  }

  if (!readDb || !writeDb) throw new Error("Account email token store requires persistence");
  const locked = withMutationLock || ((handler) => handler());
  return {
    replace(input) {
      assertPurpose(input.purpose);
      return locked(async () => {
        const db = await readDb();
        db.accountEmailTokens ||= [];
        db.accountEmailTokens = db.accountEmailTokens.filter((row) => row.userId !== input.userId || row.purpose !== input.purpose);
        db.accountEmailTokens.push({ id: randomUUID(), ...input, usedAt: null });
        await writeDb(db);
      });
    },
    async inspect({ digest, purpose, now }) {
      assertPurpose(purpose);
      const db = await readDb();
      return (db.accountEmailTokens || []).find((row) => active(row, { digest, purpose, now })) || null;
    },
    consume({ digest, purpose, now }) {
      assertPurpose(purpose);
      return locked(async () => {
        const db = await readDb();
        const row = (db.accountEmailTokens || []).find((candidate) => active(candidate, { digest, purpose, now }));
        if (!row) return null;
        row.usedAt = new Date(now).toISOString();
        await writeDb(db);
        return structuredClone(row);
      });
    },
    revokeUserPurpose(userId, purpose) {
      assertPurpose(purpose);
      return locked(async () => {
        const db = await readDb();
        db.accountEmailTokens = (db.accountEmailTokens || []).filter((row) => row.userId !== userId || row.purpose !== purpose);
        await writeDb(db);
      });
    }
  };
}
