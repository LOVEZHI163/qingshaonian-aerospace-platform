ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_ciphertext TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_iv TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_tag TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_created_at TIMESTAMPTZ;

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_created_by_user_id_fkey;
ALTER TABLE registrations ALTER COLUMN created_by_user_id DROP NOT NULL;
ALTER TABLE registrations ADD CONSTRAINT registrations_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_organization_id_fkey;
ALTER TABLE registrations ADD CONSTRAINT registrations_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_check;
ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_owner_snapshot_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_owner_snapshot_check
  CHECK (personal_user_id IS NOT NULL OR organization_id IS NOT NULL OR organization_name <> '');
