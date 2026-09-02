CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_digest TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'monthly',
  max_devices INTEGER NOT NULL CHECK (max_devices > 0),
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id UUID NOT NULL UNIQUE REFERENCES licenses(id) ON DELETE RESTRICT,
  name TEXT NOT NULL DEFAULT 'Inventory workspace',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT 'Android device',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, device_id)
);

CREATE TABLE IF NOT EXISTS entities (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS sync_operations (
  sequence BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('upsert', 'delete')),
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'conflict')),
  UNIQUE (workspace_id, operation_id)
);

CREATE INDEX IF NOT EXISTS entities_workspace_updated_idx
  ON entities (workspace_id, updated_at, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS sync_operations_workspace_sequence_idx
  ON sync_operations (workspace_id, sequence);

CREATE INDEX IF NOT EXISTS devices_workspace_active_idx
  ON devices (workspace_id) WHERE revoked_at IS NULL;
