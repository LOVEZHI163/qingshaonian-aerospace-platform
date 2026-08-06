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
