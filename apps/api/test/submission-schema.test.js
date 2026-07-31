import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("submission migration adds project mode and private upload tables", async () => {
  const migration = await readFile(new URL("../src/data/migrations/008-image-video-submissions.sql", import.meta.url), "utf8");

  assert.match(migration, /ADD COLUMN submission_mode TEXT NOT NULL DEFAULT 'none'/);
  assert.match(migration, /CHECK \(submission_mode IN \('none', 'image_video'\)\)/);
  assert.match(migration, /CREATE TABLE registration_upload_sessions/);
  assert.match(migration, /CREATE TABLE registration_submission_assets/);
  assert.match(migration, /CHECK \(kind IN \('artwork_image', 'creation_video'\)\)/);
  assert.match(migration, /UNIQUE \(registration_id, kind\)/);
});
