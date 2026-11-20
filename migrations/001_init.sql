-- Initial schema for callyzer-call-reports.

CREATE TABLE admins (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,           -- SHA-256 of the cookie token; raw token never stored
  admin_id   BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- Non-secret business settings (schedule, template names, toggles...).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- Secrets (API tokens) encrypted with AES-256-GCM using APP_ENCRYPTION_KEY.
CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- Health/status of integrations (last test, last success...).
CREATE TABLE integration_status (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per registered Callyzer phone. The phone number itself is never stored:
-- phone_key is an HMAC of it and masked_number shows only the last 4 digits.
CREATE TABLE phones (
  phone_key       TEXT PRIMARY KEY,
  emp_name        TEXT NOT NULL DEFAULT '',
  emp_code        TEXT,
  masked_number   TEXT NOT NULL DEFAULT '',
  person_override TEXT,                 -- admin-set person name used to combine phones
  excluded        BOOLEAN NOT NULL DEFAULT false,
  registered      BOOLEAN NOT NULL DEFAULT true,  -- false = seen in call data but not in employee list
  last_sync_at    TIMESTAMPTZ,
  app_uninstalled BOOLEAN,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WhatsApp recipients of the report (internal team members).
CREATE TABLE recipients (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,      -- E.164 digits without '+', e.g. 919876543210
  active     BOOLEAN NOT NULL DEFAULT true,
  is_test    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual')),
  source          TEXT NOT NULL DEFAULT 'callyzer' CHECK (source IN ('callyzer', 'sample')),
  report_date     DATE NOT NULL,
  slot            TEXT,                  -- 'HH:mm' for scheduled runs
  cutoff_at       TIMESTAMPTZ NOT NULL,  -- data window is [start of report_date IST, cutoff_at)
  delivery_mode   TEXT NOT NULL CHECK (delivery_mode IN ('none', 'test', 'all')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'partial', 'failed', 'cancelled')),
  step            TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 6,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at     TIMESTAMPTZ NOT NULL,
  locked_by       TEXT,
  heartbeat_at    TIMESTAMPTZ,
  error           TEXT,
  warnings        JSONB NOT NULL DEFAULT '[]',
  report          JSONB,                 -- computed report model (names + numbers only, no phone numbers)
  data_fetched_at TIMESTAMPTZ,
  rendered_at     TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
-- The core duplicate guard: one scheduled run per date and slot, ever.
CREATE UNIQUE INDEX runs_scheduled_once ON runs(report_date, slot) WHERE kind = 'scheduled';
CREATE INDEX runs_queue_idx ON runs(status, next_attempt_at);
CREATE INDEX runs_created_idx ON runs(created_at DESC);

CREATE TABLE run_events (
  id      BIGSERIAL PRIMARY KEY,
  run_id  BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  level   TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX run_events_run_idx ON run_events(run_id, id);

CREATE TABLE report_images (
  run_id     BIGINT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  png        BYTEA NOT NULL,
  width      INT NOT NULL,
  height     INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  recipient_name      TEXT NOT NULL,
  recipient_phone     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'accepted', 'sent', 'delivered', 'read', 'failed', 'unknown')),
  local_message_id    TEXT NOT NULL UNIQUE,
  broadcast_id        TEXT,
  whatsapp_message_id TEXT,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The second duplicate guard: one delivery per recipient per run.
  UNIQUE (run_id, recipient_phone)
);
CREATE INDEX deliveries_run_idx ON deliveries(run_id);

CREATE TABLE webhook_events (
  id               BIGSERIAL PRIMARY KEY,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type       TEXT,
  local_message_id TEXT,
  status           TEXT,
  matched          BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX webhook_events_received_idx ON webhook_events(received_at DESC);
