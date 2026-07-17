ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_start_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_end_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_mode TEXT NOT NULL DEFAULT 'automatic';
ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_registration_mode_check') THEN
    ALTER TABLE events ADD CONSTRAINT events_registration_mode_check
      CHECK (registration_mode IN ('automatic', 'force_open', 'force_closed'));
  END IF;
END $$;

UPDATE events
SET registration_start_at = COALESCE(registration_start_at, created_at),
    registration_end_at = COALESCE(registration_end_at, (registration_deadline || ' 23:59:59+08')::timestamptz);
ALTER TABLE events ALTER COLUMN registration_start_at SET NOT NULL;
ALTER TABLE events ALTER COLUMN registration_end_at SET NOT NULL;

UPDATE events SET is_current = TRUE
WHERE id = 'wz-aerospace-2026'
  AND NOT EXISTS (SELECT 1 FROM events WHERE is_current = TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS events_single_current_key
  ON events ((is_current)) WHERE is_current = TRUE;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS instructor_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS project_groups (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  PRIMARY KEY (project_id, group_name)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_groups_group_name_check') THEN
    ALTER TABLE project_groups ADD CONSTRAINT project_groups_group_name_check
      CHECK (group_name IN ('小学低段', '小学高段', '中学组', '职高/高中组'));
  END IF;
END $$;
