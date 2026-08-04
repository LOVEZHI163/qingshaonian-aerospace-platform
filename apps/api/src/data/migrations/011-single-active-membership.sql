CREATE UNIQUE INDEX IF NOT EXISTS memberships_single_active_user_idx
ON memberships(user_id)
WHERE user_id IS NOT NULL AND status = 'active';
