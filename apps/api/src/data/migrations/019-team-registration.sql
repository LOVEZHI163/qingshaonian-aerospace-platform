ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS team_min_members SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS team_max_members SMALLINT NOT NULL DEFAULT 8;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_team_member_bounds_check;
ALTER TABLE projects ADD CONSTRAINT projects_team_member_bounds_check
  CHECK (team_min_members BETWEEN 1 AND 8
    AND team_max_members BETWEEN 1 AND 8
    AND team_min_members <= team_max_members);

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS team_code TEXT NOT NULL DEFAULT '';
ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_event_project_athlete_key;
ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_event_id_project_id_athlete_key_key;

CREATE TABLE IF NOT EXISTS registration_participants (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  display_order SMALLINT NOT NULL CHECK (display_order BETWEEN 1 AND 8),
  name TEXT NOT NULL,
  school TEXT NOT NULL,
  grade TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (registration_id, display_order),
  UNIQUE (id, registration_id)
);

CREATE TABLE IF NOT EXISTS registration_participant_identities (
  participant_id TEXT PRIMARY KEY REFERENCES registration_participants(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  id_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS registration_participant_identity_fingerprint_idx
  ON registration_participant_identities(id_fingerprint);

ALTER TABLE certificates ADD COLUMN IF NOT EXISTS participant_id TEXT;
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_registration_id_slot_key;
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_participant_registration_fkey;
ALTER TABLE certificates ADD CONSTRAINT certificates_participant_registration_fkey
  FOREIGN KEY (participant_id, registration_id)
  REFERENCES registration_participants(id, registration_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS certificates_registration_slot_legacy_key
  ON certificates(registration_id, slot) WHERE participant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS certificates_participant_slot_key
  ON certificates(registration_id, participant_id, slot) WHERE participant_id IS NOT NULL;
