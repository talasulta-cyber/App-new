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

test("admin panel supports license generation and lifecycle management", () => {
  assert.match(server, /app\.get\("\/admin"/);
  assert.match(server, /generateActivationCode/);
  assert.match(server, /app\.get\("\/v1\/admin\/licenses"/);
  assert.match(server, /app\.post\("\/v1\/admin\/licenses"/);
  assert.match(server, /app\.patch\("\/v1\/admin\/licenses\/:id"/);
  assert.match(server, /app\.delete\("\/v1\/admin\/licenses\/:id"/);
  assert.match(server, /app\.delete\("\/v1\/admin\/devices\/:id"/);
  assert.match(server, /SYNC_ADMIN_SETUP_TOKEN/);
  assert.match(server, /توليد الكود وحفظ الترخيص/);
});

test("license schema stores operator-facing user identity fields", () => {
  assert.match(schema, /user_name TEXT NOT NULL/);
  assert.match(schema, /user_number TEXT NOT NULL/);
  assert.match(schema, /code_hint TEXT NOT NULL/);
});

test("cloud backup stores one latest snapshot per workspace", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS cloud_backups/);
  assert.match(schema, /workspace_id UUID PRIMARY KEY REFERENCES workspaces\(id\) ON DELETE CASCADE/);
  assert.match(server, /app\.post\("\/v1\/cloud-backup"/);
  assert.match(server, /ON CONFLICT \(workspace_id\) DO UPDATE/);
  assert.match(server, /app\.get\("\/v1\/cloud-backup"/);
});

test("account deletion removes cloud data and license state", () => {
  assert.match(server, /app\.delete\("\/v1\/account"/);
  assert.match(server, /DELETE FROM cloud_backups WHERE workspace_id/);
  assert.match(server, /DELETE FROM devices WHERE workspace_id/);
  assert.match(server, /DELETE FROM licenses WHERE id/);
});
