ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS organization_deleted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE certificate_import_batches DROP CONSTRAINT IF EXISTS certificate_import_batches_created_by_fkey;
ALTER TABLE certificate_import_batches DROP CONSTRAINT IF EXISTS certificate_import_batches_created_by_fk;
ALTER TABLE certificate_import_batches ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE certificate_import_batches ADD CONSTRAINT certificate_import_batches_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE registration_upload_sessions DROP CONSTRAINT IF EXISTS registration_upload_sessions_owner_user_id_fkey;
ALTER TABLE registration_upload_sessions DROP CONSTRAINT IF EXISTS registration_upload_sessions_owner_user_id_fk;
ALTER TABLE registration_upload_sessions ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE registration_upload_sessions ADD CONSTRAINT registration_upload_sessions_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE registration_upload_sessions DROP CONSTRAINT IF EXISTS registration_upload_sessions_organization_id_fkey;
ALTER TABLE registration_upload_sessions DROP CONSTRAINT IF EXISTS registration_upload_sessions_organization_id_fk;
ALTER TABLE registration_upload_sessions ADD CONSTRAINT registration_upload_sessions_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE registration_submission_assets DROP CONSTRAINT IF EXISTS registration_submission_assets_uploaded_by_user_id_fkey;
ALTER TABLE registration_submission_assets DROP CONSTRAINT IF EXISTS registration_submission_assets_uploaded_by_user_id_fk;
ALTER TABLE registration_submission_assets ALTER COLUMN uploaded_by_user_id DROP NOT NULL;
ALTER TABLE registration_submission_assets ADD CONSTRAINT registration_submission_assets_uploaded_by_user_id_fkey
  FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
