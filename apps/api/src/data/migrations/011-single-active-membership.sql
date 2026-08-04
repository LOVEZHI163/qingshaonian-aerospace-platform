-- Older databases may contain multiple active rows before this index existed.
-- Preserve the lexicographically first row deterministically and retire the rest.
UPDATE memberships
SET status = 'removed'
WHERE status = 'active'
  AND user_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM memberships
    WHERE status = 'active' AND user_id IS NOT NULL
    GROUP BY user_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS memberships_single_active_user_idx
ON memberships(user_id)
WHERE user_id IS NOT NULL AND status = 'active';
