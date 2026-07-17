CREATE TABLE IF NOT EXISTS file_cleanup_journal (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  category TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
