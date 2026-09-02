import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.SYNC_DATABASE_URL;
const sessionSecret = process.env.SYNC_SESSION_SECRET;
const adminToken = process.env.SYNC_ADMIN_SETUP_TOKEN;
const maxBodyBytes = process.env.SYNC_MAX_BODY_BYTES || "4mb";

if (!databaseUrl) {
  console.warn("SYNC_DATABASE_URL is not set; the service will start without touching any other project database.");
}
if (!sessionSecret) {
  console.warn("SYNC_SESSION_SECRET is not set; register/login routes will reject requests until it is configured.");
}

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5 }) : null;

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: maxBodyBytes }));

function jsonError(res, status, error, message) {
  return res.status(status).json({ ok: false, error, message });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeToken(token) {
  if (!sessionSecret || typeof token !== "string") return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function authFromRequest(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const auth = decodeToken(token);
  if (!auth?.workspaceId || !auth?.devicePk || !auth?.deviceId) {
    return jsonError(res, 401, "UNAUTHENTICATED", "A valid sync session is required.");
  }
  try {
    const result = await query(
      `SELECT d.id, l.active, l.expires_at AS "expiresAt"
       FROM devices d
       JOIN workspaces w ON w.id = d.workspace_id
       JOIN licenses l ON l.id = w.license_id
       WHERE d.id = $1 AND d.workspace_id = $2 AND d.device_id = $3 AND d.revoked_at IS NULL`,
      [auth.devicePk, auth.workspaceId, auth.deviceId],
    );
    const license = result.rows[0];
    if (!license) return jsonError(res, 401, "DEVICE_REVOKED", "This device is not active.");
    if (!license.active) return jsonError(res, 409, "LICENSE_INACTIVE", "The license is inactive.");
    if (license.expiresAt && Date.now() >= new Date(license.expiresAt).getTime()) return jsonError(res, 409, "LICENSE_EXPIRED", "The license has expired.");
    req.syncAuth = auth;
    return next();
  } catch (error) {
    return jsonError(res, 503, "AUTH_CHECK_FAILED", error instanceof Error ? error.message : "Authentication check failed");
  }
}

function normalizeText(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function assertDeviceId(value) {
  const id = normalizeText(value, 160);
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error("INVALID_DEVICE_ID");
  return id;
}

function assertOperation(operation) {
  if (!operation || typeof operation !== "object") throw new Error("INVALID_OPERATION");
  const operationId = normalizeText(operation.operationId, 160);
  const entityType = normalizeText(operation.entityType, 80);
  const entityId = normalizeText(operation.entityId, 160);
  const mode = operation.mode === "delete" ? "delete" : operation.mode === "upsert" ? "upsert" : "";
  if (!operationId || !entityType || !entityId || !mode || !/^[A-Za-z0-9._:-]+$/.test(entityType) || !/^[A-Za-z0-9._:-]+$/.test(entityId)) {
    throw new Error("INVALID_OPERATION");
  }
  if (mode === "upsert" && (operation.payload === null || typeof operation.payload !== "object")) {
    throw new Error("INVALID_PAYLOAD");
  }
  return { operationId, entityType, entityId, mode, payload: mode === "delete" ? null : operation.payload };
}

function isCollectionDelta(value) {
  return Boolean(value && typeof value === "object" && value.syncKind === "collection-delta" && Array.isArray(value.upserts) && Array.isArray(value.removedIds));
}

function syncItemId(item) {
  if (item && typeof item === "object") {
    const candidate = item.id ?? item.number;
    if (candidate !== undefined && candidate !== null) return String(candidate);
  }
  return JSON.stringify(item);
}

function mergeCollection(currentPayload, delta) {
  const current = Array.isArray(currentPayload) ? currentPayload : [];
  const removed = new Set(delta.removedIds.map(String));
  const result = current.filter((item) => !removed.has(syncItemId(item)));
  const positions = new Map(result.map((item, index) => [syncItemId(item), index]));
  for (const item of delta.upserts) {
    const id = syncItemId(item);
    const existingIndex = positions.get(id);
    if (existingIndex === undefined) {
      positions.set(id, result.length);
      result.push(item);
    } else {
      result[existingIndex] = item;
    }
  }
  return result;
}

function mergeEntityPayload(currentPayload, incomingPayload) {
  if (isCollectionDelta(incomingPayload)) return mergeCollection(currentPayload, incomingPayload);
  return incomingPayload;
}

async function query(text, values) {
  if (!pool) throw new Error("DATABASE_NOT_CONFIGURED");
  return pool.query(text, values);
}

async function withTransaction(callback) {
  if (!pool) throw new Error("DATABASE_NOT_CONFIGURED");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  const schema = await fs.readFile(path.join(process.cwd(), "schema.sql"), "utf8");
  await query(schema);
}

app.get("/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    return res.json({ ok: true, service: "inventory-sync", database: "ready" });
  } catch (error) {
    return jsonError(res, 503, "DATABASE_UNAVAILABLE", error instanceof Error ? error.message : "Database unavailable");
  }
});

app.post("/v1/admin/licenses", async (req, res) => {
  if (!adminToken || req.get("x-sync-admin-token") !== adminToken) {
    return jsonError(res, 401, "ADMIN_UNAUTHENTICATED", "The setup token is invalid.");
  }
  const code = normalizeText(req.body?.activationCode, 200);
  const plan = normalizeText(req.body?.plan, 40) || "monthly";
  const maxDevices = Number(req.body?.maxDevices);
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  if (!code || !Number.isInteger(maxDevices) || maxDevices < 1 || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
    return jsonError(res, 400, "INVALID_LICENSE", "activationCode, maxDevices and a valid optional expiresAt are required.");
  }
  try {
    const digest = sha256(code);
    const result = await query(
      `INSERT INTO licenses (code_digest, plan, max_devices, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code_digest) DO UPDATE SET plan = EXCLUDED.plan, max_devices = EXCLUDED.max_devices, expires_at = EXCLUDED.expires_at, active = TRUE
       RETURNING id, plan, max_devices AS "maxDevices", expires_at AS "expiresAt", active`,
      [digest, plan, maxDevices, expiresAt],
    );
    return res.status(201).json({ ok: true, license: result.rows[0] });
  } catch (error) {
    return jsonError(res, 500, "LICENSE_CREATE_FAILED", error instanceof Error ? error.message : "License creation failed");
  }
});

app.post("/v1/sync/register", async (req, res) => {
  const activationCode = normalizeText(req.body?.activationCode, 200);
  let deviceId;
  try {
    deviceId = assertDeviceId(req.body?.deviceId);
  } catch (error) {
    return jsonError(res, 400, error.message, "deviceId is invalid.");
  }
  const deviceName = normalizeText(req.body?.deviceName, 120) || "Android device";
  if (!activationCode) return jsonError(res, 400, "INVALID_ACTIVATION_CODE", "activationCode is required.");
  if (!sessionSecret) return jsonError(res, 503, "SYNC_NOT_CONFIGURED", "SYNC_SESSION_SECRET is not configured.");
  try {
    const result = await withTransaction(async (client) => {
      const licenseResult = await client.query(
        `SELECT id, plan, max_devices, expires_at, active FROM licenses WHERE code_digest = $1 FOR UPDATE`,
        [sha256(activationCode)],
      );
      const license = licenseResult.rows[0];
      if (!license) throw Object.assign(new Error("LICENSE_NOT_FOUND"), { code: "LICENSE_NOT_FOUND" });
      if (!license.active) throw Object.assign(new Error("LICENSE_INACTIVE"), { code: "LICENSE_INACTIVE" });
      if (license.expires_at && Date.now() >= new Date(license.expires_at).getTime()) throw Object.assign(new Error("LICENSE_EXPIRED"), { code: "LICENSE_EXPIRED" });

      let workspaceResult = await client.query(`SELECT id, name FROM workspaces WHERE license_id = $1 FOR UPDATE`, [license.id]);
      let workspace = workspaceResult.rows[0];
      if (!workspace) {
        workspaceResult = await client.query(`INSERT INTO workspaces (license_id) VALUES ($1) RETURNING id, name`, [license.id]);
        workspace = workspaceResult.rows[0];
      }

      let deviceResult = await client.query(
        `SELECT id, device_id AS "deviceId", device_name AS "deviceName" FROM devices WHERE workspace_id = $1 AND device_id = $2 FOR UPDATE`,
        [workspace.id, deviceId],
      );
      let device = deviceResult.rows[0];
      if (device) {
        await client.query(`UPDATE devices SET device_name = $3, last_seen_at = NOW(), revoked_at = NULL WHERE id = $1 AND workspace_id = $2`, [device.id, workspace.id, deviceName]);
      } else {
        const countResult = await client.query(`SELECT COUNT(*)::int AS count FROM devices WHERE workspace_id = $1 AND revoked_at IS NULL`, [workspace.id]);
        if (countResult.rows[0].count >= license.max_devices) throw Object.assign(new Error("DEVICE_LIMIT_REACHED"), { code: "DEVICE_LIMIT_REACHED" });
        deviceResult = await client.query(
          `INSERT INTO devices (workspace_id, device_id, device_name) VALUES ($1, $2, $3) RETURNING id, device_id AS "deviceId", device_name AS "deviceName"`,
          [workspace.id, deviceId, deviceName],
        );
        device = deviceResult.rows[0];
      }
      const token = encodeToken({ workspaceId: workspace.id, devicePk: device.id, deviceId, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 });
      return { token, workspace, device, license: { plan: license.plan, expiresAt: license.expires_at, maxDevices: license.max_devices } };
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const code = error?.code;
    if (code === "LICENSE_NOT_FOUND") return jsonError(res, 404, code, "Activation code was not found on the sync server.");
    if (code === "LICENSE_INACTIVE" || code === "LICENSE_EXPIRED" || code === "DEVICE_LIMIT_REACHED") return jsonError(res, 409, code, "The license cannot register this device.");
    return jsonError(res, 500, "REGISTER_FAILED", error instanceof Error ? error.message : "Registration failed");
  }
});

app.post("/v1/sync/pull", authFromRequest, async (req, res) => {
  const since = Math.max(0, Number(req.body?.since || 0));
  const limit = Math.min(500, Math.max(1, Number(req.body?.limit || 200)));
  if (!Number.isSafeInteger(since)) return jsonError(res, 400, "INVALID_CURSOR", "since must be a non-negative integer.");
  try {
    await query(`UPDATE devices SET last_seen_at = NOW() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`, [req.syncAuth.devicePk, req.syncAuth.workspaceId]);
    const result = await query(
      `SELECT sequence, operation_id AS "operationId", entity_type AS "entityType", entity_id AS "entityId", mode, payload, created_at AS "createdAt"
       FROM sync_operations WHERE workspace_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3`,
      [req.syncAuth.workspaceId, since, limit],
    );
    const lastSequence = result.rows.length ? Number(result.rows[result.rows.length - 1].sequence) : since;
    return res.json({ ok: true, changes: result.rows, nextCursor: lastSequence, hasMore: result.rows.length === limit });
  } catch (error) {
    return jsonError(res, 500, "PULL_FAILED", error instanceof Error ? error.message : "Pull failed");
  }
});

app.post("/v1/sync/push", authFromRequest, async (req, res) => {
  const rawOperations = Array.isArray(req.body?.operations) ? req.body.operations : [];
  if (!rawOperations.length || rawOperations.length > 100) return jsonError(res, 400, "INVALID_BATCH", "operations must contain between 1 and 100 items.");
  let operations;
  try {
    operations = rawOperations.map(assertOperation);
  } catch (error) {
    return jsonError(res, 400, error.message, "One or more operations are invalid.");
  }
  try {
    const result = await withTransaction(async (client) => {
      const applied = [];
      for (const operation of operations) {
        const existing = await client.query(
          `SELECT sequence, status FROM sync_operations WHERE workspace_id = $1 AND operation_id = $2`,
          [req.syncAuth.workspaceId, operation.operationId],
        );
        if (existing.rows[0]) {
          applied.push({ operationId: operation.operationId, sequence: Number(existing.rows[0].sequence), status: existing.rows[0].status, duplicate: true });
          continue;
        }

        const entity = await client.query(
          `SELECT payload, version, updated_at AS "updatedAt" FROM entities WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3 FOR UPDATE`,
          [req.syncAuth.workspaceId, operation.entityType, operation.entityId],
        );
        const currentVersion = entity.rows[0]?.version ? Number(entity.rows[0].version) : 0;
        const nextVersion = currentVersion + 1;
        const nextPayload = operation.mode === "upsert" ? mergeEntityPayload(entity.rows[0]?.payload, operation.payload) : null;
        if (operation.mode === "delete") {
          await client.query(
            `INSERT INTO entities (workspace_id, entity_type, entity_id, payload, version, deleted_at, updated_at)
             VALUES ($1, $2, $3, '{}'::jsonb, $4, NOW(), NOW())
             ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET payload = '{}'::jsonb, version = $4, deleted_at = NOW(), updated_at = NOW()`,
            [req.syncAuth.workspaceId, operation.entityType, operation.entityId, nextVersion],
          );
        } else {
          await client.query(
            `INSERT INTO entities (workspace_id, entity_type, entity_id, payload, version, deleted_at, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, NULL, NOW())
             ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET payload = $4::jsonb, version = $5, deleted_at = NULL, updated_at = NOW()`,
            [req.syncAuth.workspaceId, operation.entityType, operation.entityId, JSON.stringify(nextPayload), nextVersion],
          );
        }
        const inserted = await client.query(
          `INSERT INTO sync_operations (workspace_id, operation_id, device_id, entity_type, entity_id, mode, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           RETURNING sequence, status`,
          [req.syncAuth.workspaceId, operation.operationId, req.syncAuth.devicePk, operation.entityType, operation.entityId, operation.mode, operation.payload ? JSON.stringify(operation.payload) : null],
        );
        applied.push({ operationId: operation.operationId, sequence: Number(inserted.rows[0].sequence), status: inserted.rows[0].status, version: nextVersion, duplicate: false });
      }
      await client.query(`UPDATE devices SET last_seen_at = NOW() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`, [req.syncAuth.devicePk, req.syncAuth.workspaceId]);
      return applied;
    });
    return res.json({ ok: true, applied: result });
  } catch (error) {
    return jsonError(res, 500, "PUSH_FAILED", error instanceof Error ? error.message : "Push failed");
  }
});

app.get("/v1/sync/snapshot", authFromRequest, async (req, res) => {
  try {
    const result = await query(
      `SELECT entity_type AS "entityType", entity_id AS "entityId", payload, version, updated_at AS "updatedAt"
       FROM entities WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY entity_type, entity_id`,
      [req.syncAuth.workspaceId],
    );
    return res.json({ ok: true, entities: result.rows });
  } catch (error) {
    return jsonError(res, 500, "SNAPSHOT_FAILED", error instanceof Error ? error.message : "Snapshot failed");
  }
});

app.post("/v1/sync/heartbeat", authFromRequest, async (req, res) => {
  try {
    await query(`UPDATE devices SET last_seen_at = NOW() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`, [req.syncAuth.devicePk, req.syncAuth.workspaceId]);
    return res.json({ ok: true, serverTime: new Date().toISOString() });
  } catch (error) {
    return jsonError(res, 500, "HEARTBEAT_FAILED", error instanceof Error ? error.message : "Heartbeat failed");
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") return jsonError(res, 413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  return jsonError(res, 500, "INTERNAL_ERROR", "Unexpected server error.");
});

function safeDatabaseError(error) {
  const message = error instanceof Error ? error.message : "Unknown database error";
  return databaseUrl ? message.replaceAll(databaseUrl, "[redacted]") : message;
}

async function start() {
  if (pool) {
    try {
      await ensureSchema();
      console.log("Sync schema is ready.");
    } catch (error) {
      console.error("Failed to initialize sync schema", safeDatabaseError(error));
    }
  }
  app.listen(port, "0.0.0.0", () => console.log(`Inventory sync server listening on ${port}`));
}

start().catch((error) => {
  console.error("Failed to start sync server", error);
  process.exitCode = 1;
});
