import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("019 adds bounded team rosters and participant certificate targets", async () => {
  const sql = await readFile(new URL("../src/data/migrations/019-team-registration.sql", import.meta.url), "utf8");
  assert.match(sql, /team_min_members SMALLINT NOT NULL DEFAULT 1/);
  assert.match(sql, /team_max_members SMALLINT NOT NULL DEFAULT 8/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS registration_participants/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS registration_participant_identities/);
  assert.match(sql, /participant_id TEXT/);
  assert.match(sql, /UNIQUE \(registration_id, display_order\)/);
  assert.match(sql, /UNIQUE \(id, registration_id\)/);
  assert.match(sql, /FOREIGN KEY \(participant_id, registration_id\)\s+REFERENCES registration_participants\(id, registration_id\) ON DELETE CASCADE/);
  assert.match(sql, /certificates_registration_slot_legacy_key/);
  assert.match(sql, /certificates_participant_slot_key/);
});
