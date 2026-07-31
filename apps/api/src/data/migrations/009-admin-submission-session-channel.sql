ALTER TABLE registration_upload_sessions
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'personal'
  CHECK (channel IN ('personal', 'organization', 'admin'));

UPDATE registration_upload_sessions
SET channel = 'organization'
WHERE organization_id IS NOT NULL;
