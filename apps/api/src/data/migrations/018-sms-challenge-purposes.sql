ALTER TABLE password_reset_challenges
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'sms-password-reset';

ALTER TABLE password_reset_challenges
  DROP CONSTRAINT IF EXISTS password_reset_challenges_pkey;

ALTER TABLE password_reset_challenges
  ADD CONSTRAINT password_reset_challenges_pkey PRIMARY KEY (purpose, phone);

CREATE INDEX IF NOT EXISTS password_reset_challenges_purpose_expires_at_idx
  ON password_reset_challenges(purpose, expires_at);
