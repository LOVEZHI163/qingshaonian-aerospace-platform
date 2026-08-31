CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  email TEXT,
  email_verified_at TIMESTAMPTZ,
  email_updated_at TIMESTAMPTZ,
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

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  target_email TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  request_ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS account_email_tokens_user_purpose_idx
  ON account_email_tokens (user_id, purpose, created_at DESC);

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
  submission_mode TEXT NOT NULL DEFAULT 'none' CHECK (submission_mode IN ('none', 'image_video')),
  team_min_members SMALLINT NOT NULL DEFAULT 1,
  team_max_members SMALLINT NOT NULL DEFAULT 8,
  CONSTRAINT projects_team_member_bounds_check CHECK (
    team_min_members BETWEEN 1 AND 8
    AND team_max_members BETWEEN 1 AND 8
    AND team_min_members <= team_max_members
  )
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
  organization_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  athlete JSONB NOT NULL,
  athlete_key TEXT NOT NULL,
  group_name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  project_name TEXT NOT NULL,
  project_type TEXT NOT NULL,
  instructor TEXT NOT NULL DEFAULT '',
  team_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (personal_user_id IS NOT NULL OR organization_id IS NOT NULL OR organization_name <> '')
);

CREATE TABLE IF NOT EXISTS registration_identities (
  registration_id TEXT PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  id_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

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

CREATE TABLE IF NOT EXISTS organization_leaders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  current_document_id TEXT,
  review_status TEXT NOT NULL CHECK (review_status IN ('pending','approved','rejected')),
  rejection_reason TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  submission_version INTEGER NOT NULL DEFAULT 1,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_leader_documents (
  id TEXT PRIMARY KEY,
  leader_id TEXT NOT NULL REFERENCES organization_leaders(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL,
  cleaned_at TIMESTAMPTZ,
  UNIQUE (leader_id, version)
);

CREATE TABLE IF NOT EXISTS organization_leader_reviews (
  id TEXT PRIMARY KEY,
  leader_id TEXT NOT NULL REFERENCES organization_leaders(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submission_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('submitted','approved','rejected','enabled','disabled')),
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  snapshot JSONB NOT NULL,
  document_id TEXT REFERENCES organization_leader_documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE organization_leaders
  DROP CONSTRAINT IF EXISTS organization_leaders_current_document_id_fkey;
ALTER TABLE organization_leaders
  ADD CONSTRAINT organization_leaders_current_document_id_fkey
  FOREIGN KEY (current_document_id) REFERENCES organization_leader_documents(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS registration_upload_sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
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
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
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
  participant_id TEXT,
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
  CONSTRAINT certificates_participant_registration_fkey
    FOREIGN KEY (participant_id, registration_id)
    REFERENCES registration_participants(id, registration_id) ON DELETE CASCADE
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
CREATE INDEX IF NOT EXISTS organization_leaders_organization_id_idx ON organization_leaders(organization_id);
CREATE INDEX IF NOT EXISTS organization_leaders_review_status_idx ON organization_leaders(review_status);
CREATE INDEX IF NOT EXISTS organization_leader_documents_leader_id_idx ON organization_leader_documents(leader_id);
CREATE INDEX IF NOT EXISTS organization_leader_reviews_leader_id_idx ON organization_leader_reviews(leader_id);
CREATE INDEX IF NOT EXISTS memberships_organization_id_idx ON memberships(organization_id);
CREATE INDEX IF NOT EXISTS organization_event_participations_event_id_idx ON organization_event_participations(event_id);
CREATE INDEX IF NOT EXISTS registration_upload_sessions_owner_expires_at_idx ON registration_upload_sessions(owner_user_id, expires_at);
CREATE INDEX IF NOT EXISTS registration_submission_assets_registration_id_idx ON registration_submission_assets(registration_id);
CREATE INDEX IF NOT EXISTS registration_submission_assets_upload_session_id_idx ON registration_submission_assets(upload_session_id);
CREATE INDEX IF NOT EXISTS registration_participant_identity_fingerprint_idx ON registration_participant_identities(id_fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS certificates_registration_slot_legacy_key ON certificates(registration_id, slot) WHERE participant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS certificates_participant_slot_key ON certificates(registration_id, participant_id, slot) WHERE participant_id IS NOT NULL;

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
  source_url TEXT,
  source_url_fingerprint TEXT,
  source_name TEXT NOT NULL DEFAULT '',
  source_author TEXT NOT NULL DEFAULT '',
  source_published_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS content_posts_source_url_fingerprint_unique
  ON content_posts(source_url_fingerprint)
  WHERE source_url_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS site_content_import_batches (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  normalized_source_url TEXT NOT NULL,
  source_url_fingerprint TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('wechat','web')),
  source_name TEXT NOT NULL DEFAULT '',
  source_author TEXT NOT NULL DEFAULT '',
  source_published_at TIMESTAMPTZ,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body_template_html TEXT NOT NULL,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('ready','committed','cancelled','expired')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS site_content_import_batches_created_by_status_idx
  ON site_content_import_batches(created_by, status);
CREATE INDEX IF NOT EXISTS site_content_import_batches_expires_at_idx
  ON site_content_import_batches(expires_at);

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
