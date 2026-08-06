-- Normalize historical pseudo-memberships before (re)creating the active-member constraint.
UPDATE memberships
SET status = 'removed'
WHERE status = 'active'
  AND (
    role IN ('owner', 'system')
    OR user_id IS NULL
  );

UPDATE memberships
SET status = 'removed'
WHERE status = 'active'
  AND user_id IN (SELECT id FROM users WHERE type <> 'ordinary');

UPDATE memberships
SET status = 'rejected'
WHERE status IN ('pending', 'invited')
  AND user_id IS NULL
  AND direction IN ('organization_invite', 'org_invite', 'invited');

UPDATE memberships
SET status = 'removed'
WHERE status = 'active'
  AND user_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(m.id)
    FROM memberships AS m
    JOIN users AS u ON u.id = m.user_id
    WHERE m.status = 'active'
      AND m.role NOT IN ('owner', 'system')
      AND u.type = 'ordinary'
    GROUP BY m.user_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS memberships_single_active_user_idx
ON memberships(user_id)
WHERE user_id IS NOT NULL AND status = 'active';
