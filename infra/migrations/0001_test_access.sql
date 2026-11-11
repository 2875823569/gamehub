CREATE TABLE environments (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('development', 'internal')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  accepting_access boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE test_access_grants (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL CHECK (generation > 0),
  token_digest text NOT NULL UNIQUE CHECK (length(token_digest) = 64),
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, environment_id, generation)
);

CREATE TABLE test_access_sessions (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL,
  generation integer NOT NULL,
  grant_id uuid NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (length(token_digest) = 64),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (grant_id, environment_id, generation)
    REFERENCES test_access_grants(id, environment_id, generation),
  UNIQUE (id, environment_id, generation)
);
CREATE INDEX test_access_sessions_grant_idx ON test_access_sessions(grant_id);
CREATE INDEX test_access_sessions_expiry_idx ON test_access_sessions(expires_at);

CREATE TABLE guest_sessions (
  id uuid PRIMARY KEY,
  access_session_id uuid NOT NULL UNIQUE,
  environment_id text NOT NULL,
  generation integer NOT NULL,
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 24),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (access_session_id, environment_id, generation)
    REFERENCES test_access_sessions(id, environment_id, generation)
);

CREATE TABLE access_rate_limits (
  key_digest text NOT NULL,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (key_digest, window_start)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  object_id uuid,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
