CREATE TABLE IF NOT EXISTS registration_identities (
  registration_id text PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  id_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_leaders (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  current_document_id text,
  review_status text NOT NULL CHECK (review_status IN ('pending','approved','rejected')),
  rejection_reason text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  submission_version integer NOT NULL DEFAULT 1,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_leader_documents (
  id text PRIMARY KEY,
  leader_id text NOT NULL REFERENCES organization_leaders(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  original_name text NOT NULL,
  stored_name text NOT NULL,
  file_path text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_at timestamptz NOT NULL,
  cleaned_at timestamptz,
  UNIQUE (leader_id, version)
);

CREATE TABLE IF NOT EXISTS organization_leader_reviews (
  id text PRIMARY KEY,
  leader_id text NOT NULL REFERENCES organization_leaders(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submission_version integer NOT NULL,
  action text NOT NULL CHECK (action IN ('submitted','approved','rejected','enabled','disabled')),
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  snapshot jsonb NOT NULL,
  document_id text REFERENCES organization_leader_documents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS organization_leaders_organization_id_idx ON organization_leaders(organization_id);
CREATE INDEX IF NOT EXISTS organization_leaders_review_status_idx ON organization_leaders(review_status);
CREATE INDEX IF NOT EXISTS organization_leader_documents_leader_id_idx ON organization_leader_documents(leader_id);
CREATE INDEX IF NOT EXISTS organization_leader_reviews_leader_id_idx ON organization_leader_reviews(leader_id);

ALTER TABLE organization_leaders
  DROP CONSTRAINT IF EXISTS organization_leaders_current_document_id_fkey;
ALTER TABLE organization_leaders
  ADD CONSTRAINT organization_leaders_current_document_id_fkey
  FOREIGN KEY (current_document_id) REFERENCES organization_leader_documents(id) ON DELETE SET NULL;
