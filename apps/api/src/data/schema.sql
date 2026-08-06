CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  temporary_password_ciphertext TEXT,
  temporary_password_iv TEXT,
  temporary_password_tag TEXT,
  temporary_password_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  credit_code TEXT UNIQUE,
  review_status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_document_id TEXT
);

CREATE TABLE IF NOT EXISTS organization_documents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL,
  cleaned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS file_cleanup_journal (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  category TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_attempt_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  invited_phone TEXT,
  invited_name TEXT,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  direction TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  theme TEXT NOT NULL,
  date_label TEXT NOT NULL,
  venue TEXT NOT NULL,
  registration_deadline TEXT NOT NULL,
  contact TEXT NOT NULL,
  registration_start_at TIMESTAMPTZ NOT NULL,
  registration_end_at TIMESTAMPTZ NOT NULL,
  registration_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (registration_mode IN ('automatic', 'force_open', 'force_closed')),
  status TEXT NOT NULL DEFAULT 'published',
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_event_participations (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  joined_by_user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, event_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  instructor_required BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,
  submission_mode TEXT NOT NULL DEFAULT 'none' CHECK (submission_mode IN ('none', 'image_video'))
);

CREATE TABLE IF NOT EXISTS project_groups (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL CHECK (group_name IN ('小学低段', '小学高段', '中学组', '职高/高中组')),
  PRIMARY KEY (project_id, group_name)
);

CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  source TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  personal_user_id TEXT REFERENCES users(id),
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  created_via TEXT NOT NULL CHECK (created_via IN ('personal', 'organization')),
  organization_name TEXT NOT NULL DEFAULT '',
  athlete JSONB NOT NULL,
  athlete_key TEXT NOT NULL,
  group_name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  project_name TEXT NOT NULL,
  project_type TEXT NOT NULL,
  instructor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (personal_user_id IS NOT NULL OR organization_id IS NOT NULL OR organization_name <> ''),
  UNIQUE (event_id, project_id, athlete_key)
);

CREATE TABLE IF NOT EXISTS registration_upload_sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'personal' CHECK (channel IN ('personal', 'organization', 'admin')),
  state TEXT NOT NULL CHECK (state IN ('active', 'committed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS registration_submission_assets (
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
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL,
  cleaned_at TIMESTAMPTZ,
  cleanup_reason TEXT NOT NULL DEFAULT '',
  UNIQUE (registration_id, kind)
);

CREATE TABLE IF NOT EXISTS results (
  registration_id TEXT PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE,
  award_name TEXT NOT NULL DEFAULT '',
  rank TEXT NOT NULL DEFAULT '',
  score TEXT NOT NULL DEFAULT '',
  recorded_at TIMESTAMPTZ
);

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

CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  certificate_no TEXT,
  slot SMALLINT NOT NULL DEFAULT 1 CONSTRAINT certificates_slot_check CHECK (slot IN (1, 2)),
  title TEXT NOT NULL DEFAULT '获奖证书',
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  award_name TEXT NOT NULL DEFAULT '',
  rank TEXT NOT NULL DEFAULT '',
  score TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  source TEXT NOT NULL DEFAULT 'manual',
  import_batch_id TEXT REFERENCES certificate_import_batches(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  cleaned_at TIMESTAMPTZ,
  UNIQUE (registration_id, slot)
);

CREATE TABLE IF NOT EXISTS certificate_import_errors (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES certificate_import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  registration_id TEXT,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_rate_buckets (
  key TEXT PRIMARY KEY,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS password_reset_challenges (
  phone TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auth_rate_buckets_updated_at_idx ON auth_rate_buckets(updated_at);
CREATE INDEX IF NOT EXISTS password_reset_challenges_expires_at_idx ON password_reset_challenges(expires_at);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs(target_type, target_id);

CREATE INDEX IF NOT EXISTS registrations_personal_user_id_idx ON registrations(personal_user_id);
CREATE INDEX IF NOT EXISTS registrations_organization_id_idx ON registrations(organization_id);
CREATE INDEX IF NOT EXISTS memberships_organization_id_idx ON memberships(organization_id);
CREATE INDEX IF NOT EXISTS organization_event_participations_event_id_idx ON organization_event_participations(event_id);
CREATE INDEX IF NOT EXISTS registration_upload_sessions_owner_expires_at_idx ON registration_upload_sessions(owner_user_id, expires_at);
CREATE INDEX IF NOT EXISTS registration_submission_assets_registration_id_idx ON registration_submission_assets(registration_id);
CREATE INDEX IF NOT EXISTS registration_submission_assets_upload_session_id_idx ON registration_submission_assets(upload_session_id);

CREATE TABLE IF NOT EXISTS site_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  platform_name TEXT NOT NULL,
  featured_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  platform_intro TEXT NOT NULL DEFAULT '',
  organizers JSONB NOT NULL DEFAULT '[]'::jsonb,
  contact TEXT NOT NULL DEFAULT '',
  icp TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL,
  seo_description TEXT NOT NULL DEFAULT '',
  default_hero_media_id TEXT,
  share_media_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_public_profiles (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  slogan TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  is_visible BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,
  hero_media_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('announcement','news','work','recap','guide')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','scheduled','published','offline')),
  publish_at TIMESTAMPTZ,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  cover_media_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('draft','public')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  variants JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  cleaned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS content_attachments (
  content_id TEXT NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_assets(id),
  label TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (content_id, media_id)
);
