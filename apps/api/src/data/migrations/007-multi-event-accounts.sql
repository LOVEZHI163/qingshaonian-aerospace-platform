ALTER TABLE organizations
  ADD CONSTRAINT organizations_owner_user_id_key UNIQUE (owner_user_id);

CREATE TABLE organization_event_participations (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  joined_by_user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, event_id)
);
CREATE INDEX organization_event_participations_event_id_idx
  ON organization_event_participations(event_id);

ALTER TABLE registrations
  ADD COLUMN created_by_user_id TEXT REFERENCES users(id),
  ADD COLUMN personal_user_id TEXT REFERENCES users(id),
  ADD COLUMN created_via TEXT;

UPDATE registrations r
SET created_by_user_id = r.user_id,
    personal_user_id = CASE WHEN u.type = 'ordinary' THEN r.user_id ELSE NULL END,
    created_via = CASE WHEN u.type = 'organization' THEN 'organization' ELSE 'personal' END
FROM users u
WHERE u.id = r.user_id;

ALTER TABLE registrations
  ALTER COLUMN created_by_user_id SET NOT NULL,
  ALTER COLUMN created_via SET NOT NULL,
  ADD CONSTRAINT registrations_created_via_check
    CHECK (created_via IN ('personal', 'organization')),
  ADD CONSTRAINT registrations_owner_check
    CHECK (personal_user_id IS NOT NULL OR organization_id IS NOT NULL),
  ADD CONSTRAINT registrations_event_project_athlete_key
    UNIQUE (event_id, project_id, athlete_key),
  DROP COLUMN user_id;

DROP INDEX IF EXISTS registrations_user_id_idx;
CREATE INDEX registrations_personal_user_id_idx
  ON registrations(personal_user_id);

ALTER TABLE certificates
  DROP COLUMN user_id,
  DROP COLUMN organization_id;
DROP INDEX IF EXISTS certificates_user_id_idx;
