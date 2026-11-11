CREATE TABLE point_accounts (
  environment_id text NOT NULL REFERENCES environments(id),
  user_id uuid NOT NULL REFERENCES users(id),
  available bigint NOT NULL DEFAULT 0 CHECK (available BETWEEN 0 AND 9007199254740991),
  frozen bigint NOT NULL DEFAULT 0 CHECK (frozen BETWEEN 0 AND 9007199254740991),
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed BETWEEN 0 AND 9007199254740991),
  revision integer NOT NULL DEFAULT 0,
  PRIMARY KEY (environment_id, user_id)
);
CREATE TABLE point_lots (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL,
  user_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('test_grant','test_payment','compensation')),
  source_key text NOT NULL,
  initial bigint NOT NULL CHECK (initial > 0 AND initial <= 9007199254740991),
  available bigint NOT NULL CHECK (available >= 0),
  frozen bigint NOT NULL DEFAULT 0 CHECK (frozen >= 0),
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  expired bigint NOT NULL DEFAULT 0 CHECK (expired >= 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id,user_id) REFERENCES point_accounts(environment_id,user_id),
  UNIQUE(environment_id,source_key),
  CHECK (initial = available + frozen + consumed + expired)
);
CREATE INDEX point_lots_owner_idx ON point_lots(environment_id,user_id);
CREATE TABLE point_transactions (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL,
  user_id uuid NOT NULL,
  business_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('grant','freeze','settle','release','expire','compensate','refund')),
  amount bigint NOT NULL CHECK(amount >= 0),
  available_delta bigint NOT NULL,
  frozen_delta bigint NOT NULL,
  consumed_delta bigint NOT NULL,
  reason text NOT NULL,
  task_id uuid,
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id,user_id) REFERENCES point_accounts(environment_id,user_id),
  UNIQUE(environment_id,business_key)
);
CREATE INDEX point_transactions_owner_idx ON point_transactions(environment_id,user_id,created_at DESC,id);
CREATE TABLE ai_quotes (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  game_id uuid NOT NULL REFERENCES games(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  workspace_revision integer NOT NULL,
  base_version_id uuid,
  prompt text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('create','modify')),
  points integer NOT NULL CHECK(points >= 0),
  pricing_version text NOT NULL DEFAULT 'mock-v1',
  provider text NOT NULL DEFAULT 'mock' CHECK(provider = 'mock'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_tasks (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  quote_id uuid NOT NULL REFERENCES ai_quotes(id),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled','timed_out')),
  points integer NOT NULL CHECK(points >= 0),
  lease_epoch integer NOT NULL DEFAULT 0,
  worker_id text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0 AND attempts <= 3),
  deadline_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  output_version_id uuid,
  failure_code text,
  original_task_id uuid REFERENCES ai_tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id,user_id,idempotency_key)
);
CREATE UNIQUE INDEX ai_task_quote_once ON ai_tasks(quote_id) WHERE original_task_id IS NULL;
CREATE INDEX ai_tasks_queue_idx ON ai_tasks(environment_id,status,created_at);
CREATE TABLE point_allocations (
  task_id uuid NOT NULL REFERENCES ai_tasks(id),
  lot_id uuid NOT NULL REFERENCES point_lots(id),
  amount bigint NOT NULL CHECK(amount > 0),
  refunded bigint NOT NULL DEFAULT 0 CHECK(refunded >= 0 AND refunded <= amount),
  PRIMARY KEY(task_id,lot_id)
);
CREATE TABLE point_freeze_results (
  task_id uuid PRIMARY KEY REFERENCES ai_tasks(id),
  outcome text NOT NULL CHECK(outcome IN ('settled','released')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_attempts (
  task_id uuid NOT NULL REFERENCES ai_tasks(id),
  lease_epoch integer NOT NULL,
  provider text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','succeeded','failed','superseded')),
  checks jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,lease_epoch)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL,
  generation integer NOT NULL,
  business_key text NOT NULL,
  event_type text NOT NULL,
  user_id uuid NOT NULL,
  payload jsonb NOT NULL,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id,business_key)
);
CREATE TABLE processed_events (
  consumer text NOT NULL,
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(consumer,event_id)
);
CREATE TABLE provider_budget_accounts (
  environment_id text NOT NULL REFERENCES environments(id),
  provider text NOT NULL,
  period_kind text NOT NULL CHECK(period_kind IN ('day','month')),
  period_key text NOT NULL,
  limit_micros bigint NOT NULL CHECK(limit_micros >= 0 AND limit_micros <= 9007199254740991),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros >= 0),
  PRIMARY KEY(environment_id,provider,period_kind,period_key),
  CHECK(reserved_micros + spent_micros <= limit_micros)
);
CREATE TABLE provider_cost_reservations (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL,
  provider text NOT NULL,
  call_key text NOT NULL,
  day_key text NOT NULL,
  month_key text NOT NULL,
  amount_micros bigint NOT NULL CHECK(amount_micros > 0),
  actual_micros bigint,
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','uncertain','settled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id,provider,call_key)
);
CREATE TABLE quality_cases (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES ai_tasks(id),
  environment_id text NOT NULL,
  user_id uuid NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','repairing','repaired','refunded','rejected')),
  repair_task_id uuid REFERENCES ai_tasks(id),
  repair_count integer NOT NULL DEFAULT 0 CHECK(repair_count BETWEEN 0 AND 2),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_orders (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL REFERENCES environments(id),
  generation integer NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  product_id text NOT NULL,
  rule_version text NOT NULL,
  channel text NOT NULL CHECK(channel='mock'),
  amount_minor integer NOT NULL CHECK(amount_minor>0),
  points integer NOT NULL CHECK(points>0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','refund_pending','refunded','closed')),
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id,user_id,idempotency_key)
);
CREATE TABLE payment_events (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL,
  order_id uuid NOT NULL REFERENCES payment_orders(id),
  provider_event_key text NOT NULL,
  event_type text NOT NULL,
  payload_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id,provider_event_key)
);
CREATE TABLE refund_orders (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES payment_orders(id),
  environment_id text NOT NULL,
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  reason text NOT NULL,
  amount_minor integer NOT NULL,
  points integer NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','processing','succeeded','rejected','failed')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id,user_id,idempotency_key)
);
CREATE UNIQUE INDEX refund_order_active_once ON refund_orders(order_id) WHERE status IN ('requested','processing','succeeded');
