ALTER TABLE organizations ADD COLUMN IF NOT EXISTS credit_code TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS reject_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE organizations
SET credit_code = 'LEGACY-' || id, review_status = 'approved'
WHERE credit_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_credit_code_key ON organizations(credit_code);

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
