CREATE TABLE users (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 24),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','closure_requested')),
  terms_version text NOT NULL,
  terms_accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, environment_id)
);
CREATE TABLE phone_bindings (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  environment_id text NOT NULL REFERENCES environments(id),
  phone_digest text NOT NULL,
  phone_ciphertext text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  verified_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE UNIQUE INDEX phone_bindings_active_phone ON phone_bindings(environment_id,phone_digest) WHERE active;
CREATE UNIQUE INDEX phone_bindings_active_user ON phone_bindings(user_id) WHERE active;
CREATE TABLE test_phone_allowlist (
  environment_id text NOT NULL REFERENCES environments(id),
  phone_digest text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment_id,phone_digest)
);
CREATE TABLE sms_challenges (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  access_session_id uuid NOT NULL REFERENCES test_access_sessions(id),
  phone_digest text NOT NULL,
  phone_ciphertext text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('login','admin','support','phone-change-old','phone-change-new')),
  code_digest text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_challenges_phone_time ON sms_challenges(environment_id,phone_digest,created_at DESC);
CREATE TABLE test_sms_deliveries (
  challenge_id uuid PRIMARY KEY REFERENCES sms_challenges(id),
  code_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE account_sessions (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL,
  generation integer NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  access_session_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('user','admin','support')),
  token_digest text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(access_session_id,environment_id,generation)
    REFERENCES test_access_sessions(id,environment_id,generation)
);
CREATE INDEX account_sessions_user ON account_sessions(user_id,created_at DESC);
CREATE TABLE role_assignments (
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK(role IN ('super_admin','reviewer','operations','finance','support')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by text NOT NULL,
  PRIMARY KEY(user_id,role)
);
CREATE TABLE account_restrictions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  capability text NOT NULL CHECK(capability IN ('create','submit','comment','billing','all')),
  reason text NOT NULL,
  expires_at timestamptz,
  released_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_restrictions_user ON account_restrictions(user_id) WHERE released_at IS NULL;
CREATE TABLE closure_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','reviewing','completed','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX closure_requests_pending ON closure_requests(user_id) WHERE state IN ('requested','reviewing');
