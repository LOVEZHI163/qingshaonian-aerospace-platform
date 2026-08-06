ALTER TABLE projects
  ADD COLUMN submission_mode TEXT NOT NULL DEFAULT 'none'
  CONSTRAINT projects_submission_mode_check
  CHECK (submission_mode IN ('none', 'image_video'));

CREATE TABLE registration_upload_sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('active', 'committed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ
);

CREATE TABLE registration_submission_assets (
  id TEXT PRIMARY KEY,
  registration_id TEXT REFERENCES registrations(id) ON DELETE CASCADE,
  upload_session_id TEXT NOT NULL REFERENCES registration_upload_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('artwork_image', 'creation_video')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL,
  cleaned_at TIMESTAMPTZ,
  cleanup_reason TEXT NOT NULL DEFAULT '',
  UNIQUE (registration_id, kind)
);

CREATE INDEX registration_upload_sessions_owner_expires_at_idx
  ON registration_upload_sessions(owner_user_id, expires_at);
CREATE INDEX registration_submission_assets_registration_id_idx
  ON registration_submission_assets(registration_id);
CREATE INDEX registration_submission_assets_upload_session_id_idx
  ON registration_submission_assets(upload_session_id);
