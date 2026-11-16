// PostgreSQL schema. Safe to run on every start (IF NOT EXISTS).
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- A team. Every query is scoped to one workspace (multi-tenant).
CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,       -- conflict rules, custom fields, retention
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'field' CHECK (role IN ('admin', 'supervisor', 'field', 'viewer')),
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,                               -- UUID made on the device
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT,
  last_cursor BIGINT NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ,
  scope JSONB NOT NULL DEFAULT '{"mode":"all"}'::jsonb,  -- partial sync
  revoked BOOLEAN NOT NULL DEFAULT false,            -- remote sign-out
  wipe BOOLEAN NOT NULL DEFAULT false                -- remote sign-out also erases the device's data
);

-- Long-lived login for one device. Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,                               -- UUID made on the device
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Pending',
  priority TEXT NOT NULL DEFAULT 'Medium',
  notes TEXT NOT NULL DEFAULT '',
  notes_state BYTEA,                                 -- Yjs document behind "notes" (text merging)
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  assigned_to INTEGER REFERENCES users(id),
  due_date DATE,
  custom JSONB NOT NULL DEFAULT '{}'::jsonb,         -- admin-defined form fields
  version INTEGER NOT NULL DEFAULT 1,
  field_meta JSONB NOT NULL DEFAULT '{}'::jsonb,     -- per field: version + device that last changed it
  is_deleted BOOLEAN NOT NULL DEFAULT false,         -- tombstone
  deleted_at TIMESTAMPTZ,
  flagged BOOLEAN NOT NULL DEFAULT false,
  created_by INTEGER,
  updated_by_device TEXT,
  updated_by_user INTEGER,
  updated_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seq BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_records_ws_seq ON records (workspace_id, last_seq);

-- Full snapshot of every version: record history and undo.
CREATE TABLE IF NOT EXISTS record_versions (
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  kind TEXT NOT NULL,
  user_name TEXT,
  device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, version)
);

CREATE TABLE IF NOT EXISTS change_log (
  seq BIGSERIAL PRIMARY KEY,
  record_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  op_id TEXT,
  kind TEXT NOT NULL,
  device_id TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applied_ops (
  op_id TEXT PRIMARY KEY,                            -- idempotency key
  result JSONB NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conflicts (
  id SERIAL PRIMARY KEY,
  record_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  device_id TEXT,
  user_id INTEGER,
  fields JSONB NOT NULL,
  local_value JSONB NOT NULL,
  server_value JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  resolved_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_conflicts_open ON conflicts (workspace_id, status);

-- Photos and files. Uploaded in chunks so a dropped connection resumes where it stopped.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,                               -- UUID made on the device
  record_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  data BYTEA NOT NULL DEFAULT ''::bytea,
  uploaded BOOLEAN NOT NULL DEFAULT false,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_record ON attachments (record_id);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT,
  message TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read);

CREATE TABLE IF NOT EXISTS sync_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INTEGER,
  user_id INTEGER,
  device_id TEXT,
  direction TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sync_events_at ON sync_events (at);
`;
