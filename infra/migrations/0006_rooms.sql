CREATE TABLE rooms (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  game_id uuid NOT NULL REFERENCES games(id),
  version_id uuid NOT NULL,
  official_key text NOT NULL,
  invitation_digest text NOT NULL UNIQUE,
  host_player_id uuid NOT NULL,
  sequence integer NOT NULL DEFAULT 0 CHECK(sequence >= 0),
  lease_owner uuid,
  lease_epoch integer NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  lease_until timestamptz,
  status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','playing','ended','closed')),
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(game_id,version_id) REFERENCES game_versions(game_id,id)
);
CREATE TABLE room_members (
  room_id uuid NOT NULL REFERENCES rooms(id),
  player_id uuid NOT NULL REFERENCES guest_sessions(id),
  access_session_id uuid NOT NULL REFERENCES test_access_sessions(id),
  nickname text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_action_at timestamptz,
  left_at timestamptz,
  PRIMARY KEY(room_id,player_id),
  UNIQUE(room_id,access_session_id)
);
CREATE TABLE room_actions (
  room_id uuid NOT NULL REFERENCES rooms(id),
  action_id text NOT NULL,
  player_id uuid NOT NULL,
  request_digest text NOT NULL,
  sequence integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id,action_id)
);
CREATE TABLE room_events (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  sequence integer NOT NULL,
  event_type text NOT NULL,
  player_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id,sequence)
);
CREATE TABLE room_connection_tickets (
  token_digest text PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  player_id uuid NOT NULL,
  access_session_id uuid NOT NULL REFERENCES test_access_sessions(id),
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 seconds',
  consumed_at timestamptz
);
