ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_url_fingerprint TEXT;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_name TEXT NOT NULL DEFAULT '';
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_author TEXT NOT NULL DEFAULT '';
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;

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
