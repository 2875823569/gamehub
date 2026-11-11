CREATE TABLE games (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  official_key text,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '其他',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished','restricted')),
  restricted boolean NOT NULL DEFAULT false,
  restriction_reason text,
  current_version_id uuid,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id, official_key)
);
CREATE INDEX games_owner_idx ON games(environment_id,owner_id,created_at);
CREATE TABLE artifact_uploads (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  expected_size integer NOT NULL CHECK (expected_size BETWEEN 1 AND 104857600),
  expected_digest text NOT NULL CHECK (length(expected_digest)=64),
  object_digest text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploaded','checking','passed','failed')),
  manifest jsonb,
  files jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE TABLE artifact_jobs (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('scan','export')),
  input_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','expired')),
  result_digest text,
  failure_reason text,
  lease_owner uuid,
  lease_epoch integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE UNIQUE INDEX artifact_scan_once ON artifact_jobs(input_id) WHERE kind='scan';
CREATE TABLE game_versions (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id),
  number integer NOT NULL CHECK(number>0),
  manifest jsonb NOT NULL,
  files jsonb NOT NULL,
  source text NOT NULL CHECK(source IN ('upload','ai','official')),
  source_label text,
  base_version_id uuid REFERENCES game_versions(id),
  content_digest text NOT NULL,
  check_status text NOT NULL CHECK(check_status IN ('passed','failed')),
  check_evidence jsonb NOT NULL DEFAULT '{}',
  review_status text NOT NULL DEFAULT 'draft' CHECK(review_status IN ('draft','pending','reviewing','approved','rejected','withdrawn','revoked')),
  previewed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(game_id,number),
  UNIQUE(game_id,id)
);
ALTER TABLE games ADD CONSTRAINT games_current_version_fk FOREIGN KEY(id,current_version_id) REFERENCES game_versions(game_id,id);
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL UNIQUE REFERENCES games(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  workspace_revision integer NOT NULL DEFAULT 0 CHECK(workspace_revision>=0),
  base_version_id uuid REFERENCES game_versions(id),
  draft jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE draft_snapshots (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  revision integer NOT NULL,
  base_version_id uuid REFERENCES game_versions(id),
  draft jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,revision)
);
CREATE TABLE review_submissions (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id),
  version_id uuid NOT NULL REFERENCES game_versions(id),
  submitter_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK(status IN ('pending','reviewing','approved','rejected','withdrawn')),
  publish_on_approval boolean NOT NULL DEFAULT true,
  reviewer_id uuid REFERENCES users(id),
  reason text,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(submitter_id,idempotency_key)
);
CREATE UNIQUE INDEX one_active_review ON review_submissions(game_id) WHERE status IN ('pending','reviewing');
CREATE TABLE publication_heads (
  environment_id text NOT NULL REFERENCES environments(id),
  scope text NOT NULL CHECK(scope='internal_catalog'),
  game_id uuid NOT NULL REFERENCES games(id),
  version_id uuid NOT NULL,
  PRIMARY KEY(environment_id,scope,game_id),
  FOREIGN KEY(game_id,version_id) REFERENCES game_versions(game_id,id)
);
CREATE TABLE releases (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  game_id uuid NOT NULL REFERENCES games(id),
  version_id uuid NOT NULL REFERENCES game_versions(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL CHECK(scope='internal_catalog'),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE play_sessions (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  access_session_id uuid NOT NULL REFERENCES test_access_sessions(id),
  user_id uuid REFERENCES users(id),
  game_id uuid NOT NULL REFERENCES games(id),
  version_id uuid NOT NULL,
  scope text NOT NULL CHECK(scope IN ('preview','internal_catalog')),
  resource_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(game_id,version_id) REFERENCES game_versions(game_id,id)
);
CREATE INDEX play_sessions_game_idx ON play_sessions(game_id,expires_at);
CREATE TABLE game_saves (
  user_id uuid NOT NULL REFERENCES users(id),
  game_id uuid NOT NULL REFERENCES games(id),
  save_schema_version integer NOT NULL CHECK(save_schema_version>0),
  revision integer NOT NULL CHECK(revision>0),
  data jsonb,
  game_version_id uuid NOT NULL REFERENCES game_versions(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,game_id,save_schema_version)
);
CREATE TABLE artifact_download_grants (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES artifact_jobs(id),
  access_session_id uuid NOT NULL REFERENCES test_access_sessions(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  token_digest text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
