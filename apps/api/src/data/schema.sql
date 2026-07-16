CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
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
  contact TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  source TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  organization_id TEXT REFERENCES organizations(id),
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
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  registration_id TEXT PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE,
  award_name TEXT NOT NULL DEFAULT '',
  rank TEXT NOT NULL DEFAULT '',
  score TEXT NOT NULL DEFAULT '',
  recorded_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  organization_id TEXT REFERENCES organizations(id),
  certificate_no TEXT NOT NULL,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  award_name TEXT NOT NULL DEFAULT '',
  rank TEXT NOT NULL DEFAULT '',
  score TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS registrations_user_id_idx ON registrations(user_id);
CREATE INDEX IF NOT EXISTS registrations_organization_id_idx ON registrations(organization_id);
CREATE INDEX IF NOT EXISTS memberships_organization_id_idx ON memberships(organization_id);
CREATE INDEX IF NOT EXISTS certificates_user_id_idx ON certificates(user_id);
