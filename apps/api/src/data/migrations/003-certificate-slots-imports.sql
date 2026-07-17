ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_registration_id_key;
ALTER TABLE certificates ALTER COLUMN certificate_no DROP NOT NULL;
ALTER TABLE certificates ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '获奖证书';
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS import_batch_id TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS cleaned_at TIMESTAMPTZ;

ALTER TABLE certificates
  ADD CONSTRAINT certificates_slot_check CHECK (slot IN (1, 2));

CREATE UNIQUE INDEX IF NOT EXISTS certificates_registration_slot_key
  ON certificates(registration_id, slot);

CREATE TABLE IF NOT EXISTS certificate_import_batches (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  status TEXT NOT NULL,
  preview_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  valid_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  replace_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS certificate_import_errors (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES certificate_import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  registration_id TEXT,
  message TEXT NOT NULL
);

DO $$ BEGIN
  ALTER TABLE certificates
    ADD CONSTRAINT certificates_import_batch_id_fkey
    FOREIGN KEY (import_batch_id) REFERENCES certificate_import_batches(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
