CREATE TABLE comments (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  game_id uuid NOT NULL REFERENCES games(id),
  user_id uuid NOT NULL REFERENCES users(id),
  parent_id uuid REFERENCES comments(id),
  content text NOT NULL CHECK(char_length(content) BETWEEN 1 AND 2000),
  status text NOT NULL CHECK(status IN ('visible','pending','deleted','hidden')),
  moderation_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_game ON comments(environment_id,game_id,created_at DESC,id);
CREATE TABLE likes (
  environment_id text NOT NULL REFERENCES environments(id),
  game_id uuid NOT NULL REFERENCES games(id),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment_id,game_id,user_id)
);
CREATE TABLE favorites (
  environment_id text NOT NULL REFERENCES environments(id),
  game_id uuid NOT NULL REFERENCES games(id),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment_id,game_id,user_id)
);
CREATE TABLE reports (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  user_id uuid NOT NULL REFERENCES users(id),
  object_type text NOT NULL CHECK(object_type IN ('game','comment')),
  object_id uuid NOT NULL,
  reason text NOT NULL,
  reason_digest text NOT NULL,
  state text NOT NULL DEFAULT 'new' CHECK(state IN ('new','accepted','resolved','dismissed')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id,user_id,object_type,object_id,reason_digest)
);
CREATE TABLE appeals (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  user_id uuid NOT NULL REFERENCES users(id),
  object_type text NOT NULL CHECK(object_type IN ('account','game','report')),
  object_id uuid NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'new' CHECK(state IN ('new','accepted','resolved','dismissed')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  user_id uuid NOT NULL REFERENCES users(id),
  event_key text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id,user_id,event_key)
);
CREATE TABLE test_feedback (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  access_session_id uuid NOT NULL REFERENCES test_access_sessions(id),
  game_id uuid REFERENCES games(id),
  version_id uuid REFERENCES game_versions(id),
  play_session_id uuid REFERENCES play_sessions(id),
  expected text NOT NULL,
  actual text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'new' CHECK(state IN ('new','accepted','in_progress','awaiting_retest','closed','declined')),
  severity text NOT NULL DEFAULT 'normal' CHECK(severity IN ('blocking','severe','normal','suggestion')),
  assigned_to uuid REFERENCES users(id),
  fix_version_id uuid REFERENCES game_versions(id),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(game_id,version_id) REFERENCES game_versions(game_id,id)
);
CREATE TABLE test_feedback_events (
  id uuid PRIMARY KEY,
  feedback_id uuid NOT NULL REFERENCES test_feedback(id),
  actor text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE feedback_uploads (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  access_session_id uuid NOT NULL REFERENCES test_access_sessions(id),
  mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','text/plain')),
  expected_size integer NOT NULL CHECK(expected_size BETWEEN 1 AND 5242880),
  expected_digest text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','passed','failed')),
  content bytea,
  failure_reason text,
  feedback_id uuid REFERENCES test_feedback(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day'
);
