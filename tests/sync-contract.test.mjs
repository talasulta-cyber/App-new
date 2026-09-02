import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const schema = await fs.readFile(new URL("../schema.sql", import.meta.url), "utf8");
const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");

test("schema keeps licenses, workspaces and devices isolated", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS licenses/);
  assert.match(schema, /max_devices INTEGER NOT NULL CHECK \(max_devices > 0\)/);
  assert.match(schema, /license_id UUID NOT NULL UNIQUE REFERENCES licenses/);
  assert.match(schema, /UNIQUE \(workspace_id, device_id\)/);
  assert.match(schema, /revoked_at TIMESTAMPTZ/);
});

test("schema records ordered operations and protects duplicate operation ids", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS sync_operations/);
  assert.match(schema, /sequence BIGSERIAL PRIMARY KEY/);
  assert.match(schema, /UNIQUE \(workspace_id, operation_id\)/);
  assert.match(schema, /CHECK \(mode IN \('upsert', 'delete'\)\)/);
});

test("server validates sessions against the active device and license", () => {
  assert.match(server, /WHERE d\.id = \$1 AND d\.workspace_id = \$2 AND d\.device_id = \$3 AND d\.revoked_at IS NULL/);
  assert.match(server, /if \(!license\.active\)/);
  assert.match(server, /LICENSE_EXPIRED/);
});

test("push is idempotent inside one workspace", () => {
  assert.match(server, /SELECT sequence, status FROM sync_operations WHERE workspace_id = \$1 AND operation_id = \$2/);
  assert.match(server, /duplicate: true/);
  assert.match(server, /INSERT INTO sync_operations/);
});
