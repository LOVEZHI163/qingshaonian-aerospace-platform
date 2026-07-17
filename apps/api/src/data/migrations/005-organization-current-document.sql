ALTER TABLE organizations ADD COLUMN IF NOT EXISTS current_document_id TEXT;
ALTER TABLE file_cleanup_journal ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
UPDATE file_cleanup_journal SET last_attempt_at = created_at WHERE last_attempt_at IS NULL;
