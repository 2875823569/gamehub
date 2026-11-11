ALTER TABLE play_sessions ADD COLUMN account_session_id uuid REFERENCES account_sessions(id);
CREATE INDEX play_sessions_account ON play_sessions(account_session_id) WHERE account_session_id IS NOT NULL;
-- Older authenticated grants cannot be safely bound to a particular login; revoke instead of guessing.
UPDATE play_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id IS NOT NULL;
