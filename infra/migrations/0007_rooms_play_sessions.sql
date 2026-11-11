ALTER TABLE room_members ADD COLUMN play_session_id uuid REFERENCES play_sessions(id);
CREATE INDEX room_members_play_session ON room_members(play_session_id);
