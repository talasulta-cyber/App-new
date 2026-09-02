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

const adminHtml = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>إدارة تراخيص المزامنة</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f7f5;color:#183126;max-width:1050px;margin:0 auto;padding:24px}h1{margin:0 0 8px}.muted{color:#60756b}.panel{background:#fff;border:1px solid #d9e5df;border-radius:14px;padding:18px;margin:16px 0;box-shadow:0 4px 18px #1831260d}label{display:block;font-weight:700;margin:10px 0 5px}input,select,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #b9cbc2}input,select{width:100%;box-sizing:border-box}button{cursor:pointer;background:#176b4d;color:#fff;border:0;margin:5px 0 0 5px}button.danger{background:#a42c2c}button.secondary{background:#6a7c73}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:10px;border-bottom:1px solid #e1ebe6;white-space:nowrap}.code{font-family:monospace;direction:ltr;display:inline-block;background:#edf6f1;padding:4px 7px;border-radius:5px}.status{font-weight:700}.ok{color:#176b4d}.off{color:#a42c2c}#notice{min-height:24px;color:#a42c2c}</style></head>
<body><h1>لوحة تراخيص المزامنة</h1><p class="muted">لوحة مستقلة لخادم المزامنة. اللوحة القديمة وخادم الترخيص القديم لا يتأثران.</p>
<section class="panel"><label>رمز الإدارة السري</label><input id="token" type="password" autocomplete="off" placeholder="SYNC_ADMIN_SETUP_TOKEN"><p class="muted">يبقى الرمز في هذا المتصفح فقط ولا يُحفظ في الخادم.</p><button onclick="loadLicenses()">دخول / تحديث</button><span id="notice"></span></section>
<section class="panel"><h2>إنشاء ترخيص جديد</h2><div class="grid"><div><label>اسم المستخدم</label><input id="userName" placeholder="اسم صاحب المحل"></div><div><label>رقم المستخدم</label><input id="userNumber" placeholder="رقم الهاتف أو الرقم الداخلي"></div><div><label>المدة</label><select id="plan"><option value="monthly">شهري</option><option value="yearly">سنوي</option><option value="lifetime">دائم</option><option value="custom">مخصص</option></select></div><div><label>عدد الأجهزة</label><input id="maxDevices" type="number" min="1" value="3"></div><div><label>تاريخ الانتهاء للمخصص</label><input id="expiresAt" type="date"></div></div><button onclick="createLicense()">توليد الكود وحفظ الترخيص</button></section>
<section class="panel"><h2>التراخيص والأجهزة</h2><div class="table-wrap"><table><thead><tr><th>الكود</th><th>المستخدم</th><th>الخطة</th><th>الأجهزة</th><th>الانتهاء</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody id="rows"><tr><td colspan="7">أدخل رمز الإدارة واضغط دخول</td></tr></tbody></table></div></section>
<script>
const el=id=>document.getElementById(id); const token=()=>el('token').value.trim();
async function api(path,options){const r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json','x-sync-admin-token':token()}},options||{}));const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.message||data.error||'فشل الطلب');return data;}
function notice(text,bad=true){el('notice').textContent=text;el('notice').style.color=bad?'#a42c2c':'#176b4d';}
function dateText(value){return value?new Date(value).toLocaleDateString('ar'): 'دائم';}
async function loadLicenses(){try{const data=await api('/v1/admin/licenses');window.licenseRows=Object.fromEntries(data.licenses.map(l=>[l.id,l]));el('rows').innerHTML=data.licenses.map(l=>'<tr><td><span class="code">…'+(l.codeHint||'')+'</span></td><td>'+esc(l.userName)+'<br><small>'+esc(l.userNumber)+'</small></td><td>'+esc(l.plan)+'</td><td>'+l.deviceCount+' / '+l.maxDevices+'</td><td>'+dateText(l.expiresAt)+'</td><td class="status '+(l.active?'ok':'off')+'">'+(l.active?'فعال':'موقوف')+'</td><td><button class="secondary" onclick="toggleLicense(\''+l.id+'\')">'+(l.active?'إيقاف':'تفعيل')+'</button><button class="secondary" onclick="renewLicense(\''+l.id+'\')">تجديد</button><button class="secondary" onclick="showDevices(\''+l.id+'\')">الأجهزة</button><button class="danger" onclick="deleteLicense(\''+l.id+'\')">حذف</button></td></tr>').join('')||'<tr><td colspan="7">لا توجد تراخيص</td></tr>';notice('تم التحديث',false)}catch(e){notice(e.message)}}
function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function createLicense(){try{const plan=el('plan').value;let expiresAt=el('expiresAt').value||null;if(plan==='lifetime')expiresAt=null;const data=await api('/v1/admin/licenses',{method:'POST',body:JSON.stringify({userName:el('userName').value,userNumber:el('userNumber').value,plan,maxDevices:Number(el('maxDevices').value),expiresAt})});alert('تم إنشاء الكود:\n\n'+data.activationCode+'\n\nاحتفظ به وأرسله للمستخدم.');el('userName').value='';el('userNumber').value='';await loadLicenses()}catch(e){notice(e.message)}}
async function toggleLicense(id){const l=window.licenseRows[id];try{await api('/v1/admin/licenses/'+id,{method:'PATCH',body:JSON.stringify({userName:l.userName,userNumber:l.userNumber,plan:l.plan,maxDevices:l.maxDevices,expiresAt:l.expiresAt,active:!l.active})});await loadLicenses()}catch(e){notice(e.message)}}
async function renewLicense(id){const l=window.licenseRows[id];const value=prompt('أدخل تاريخ الانتهاء الجديد بصيغة YYYY-MM-DD',l.expiresAt?String(l.expiresAt).slice(0,10):'');if(!value)return;try{await api('/v1/admin/licenses/'+id,{method:'PATCH',body:JSON.stringify({userName:l.userName,userNumber:l.userNumber,plan:l.plan,maxDevices:l.maxDevices,expiresAt:value,active:true})});await loadLicenses()}catch(e){notice(e.message)}}
async function showDevices(id){const l=window.licenseRows[id];const devices=(l.devices||[]).map(d=>d.deviceName+' ('+d.deviceId+')').join('\\n')||'لا توجد أجهزة نشطة';alert('الأجهزة النشطة:\\n\\n'+devices)}
async function deleteLicense(id){if(!confirm('سيحذف الترخيص وبياناته المرتبطة نهائيًا. هل أنت متأكد؟'))return;try{await api('/v1/admin/licenses/'+id,{method:'DELETE'});await loadLicenses()}catch(e){notice(e.message)}}
</script></body></html>`;

app.get("/admin", (_req, res) => res.type("html").send(adminHtml));

function jsonError(res, status, error, message) {
  return res.status(status).json({ ok: false, error, message });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function generateActivationCode() {
  return `INV-${crypto.randomBytes(6).toString("hex").toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function requireAdmin(req, res) {
  if (!adminToken || req.get("x-sync-admin-token") !== adminToken) {
    jsonError(res, 401, "ADMIN_UNAUTHENTICATED", "The setup token is invalid.");
    return false;
  }
  return true;
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

app.get("/v1/admin/licenses", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await query(
      `SELECT l.id, l.code_hint AS "codeHint", l.user_name AS "userName", l.user_number AS "userNumber",
              l.plan, l.max_devices AS "maxDevices", l.expires_at AS "expiresAt", l.active,
              l.created_at AS "createdAt", COUNT(d.id)::INTEGER AS "deviceCount",
              COALESCE(json_agg(json_build_object('id', d.id, 'deviceId', d.device_id, 'deviceName', d.device_name, 'lastSeenAt', d.last_seen_at)
                ORDER BY d.last_seen_at DESC) FILTER (WHERE d.id IS NOT NULL), '[]'::json) AS devices
       FROM licenses l
       LEFT JOIN workspaces w ON w.license_id = l.id
       LEFT JOIN devices d ON d.workspace_id = w.id AND d.revoked_at IS NULL
       GROUP BY l.id ORDER BY l.created_at DESC`,
    );
    return res.json({ ok: true, licenses: result.rows });
  } catch (error) {
    return jsonError(res, 500, "LICENSE_LIST_FAILED", error instanceof Error ? error.message : "License list failed");
  }
});

app.post("/v1/admin/licenses", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const code = normalizeText(req.body?.activationCode, 200) || generateActivationCode();
  const plan = normalizeText(req.body?.plan, 40) || "monthly";
  const userName = normalizeText(req.body?.userName, 160);
  const userNumber = normalizeText(req.body?.userNumber, 80);
  const maxDevices = Number(req.body?.maxDevices);
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
    return jsonError(res, 400, "INVALID_LICENSE", "maxDevices and a valid optional expiresAt are required.");
  }
  try {
    const digest = sha256(code);
    const result = await query(
      `INSERT INTO licenses (code_digest, code_hint, user_name, user_number, plan, max_devices, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code_digest) DO UPDATE SET code_hint = EXCLUDED.code_hint, user_name = EXCLUDED.user_name,
         user_number = EXCLUDED.user_number, plan = EXCLUDED.plan, max_devices = EXCLUDED.max_devices,
         expires_at = EXCLUDED.expires_at, active = TRUE
       RETURNING id, plan, max_devices AS "maxDevices", expires_at AS "expiresAt", active`,
      [digest, code.slice(-6), userName, userNumber, plan, maxDevices, expiresAt],
    );
    return res.status(201).json({ ok: true, activationCode: code, license: result.rows[0] });
  } catch (error) {
    return jsonError(res, 500, "LICENSE_CREATE_FAILED", error instanceof Error ? error.message : "License creation failed");
  }
});

app.patch("/v1/admin/licenses/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = normalizeText(req.params.id, 80);
  const plan = normalizeText(req.body?.plan, 40) || "monthly";
  const userName = normalizeText(req.body?.userName, 160);
  const userNumber = normalizeText(req.body?.userNumber, 80);
  const maxDevices = Number(req.body?.maxDevices);
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  const active = req.body?.active !== false;
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
    return jsonError(res, 400, "INVALID_LICENSE", "maxDevices and a valid optional expiresAt are required.");
  }
  try {
    const result = await query(
      `UPDATE licenses SET plan = $1, user_name = $2, user_number = $3, max_devices = $4, expires_at = $5, active = $6
       WHERE id = $7 RETURNING id, code_hint AS "codeHint", user_name AS "userName", user_number AS "userNumber",
       plan, max_devices AS "maxDevices", expires_at AS "expiresAt", active`,
      [plan, userName, userNumber, maxDevices, expiresAt, active, id],
    );
    if (!result.rowCount) return jsonError(res, 404, "LICENSE_NOT_FOUND", "License not found.");
    return res.json({ ok: true, license: result.rows[0] });
  } catch (error) {
    return jsonError(res, 500, "LICENSE_UPDATE_FAILED", error instanceof Error ? error.message : "License update failed");
  }
});

app.delete("/v1/admin/licenses/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = normalizeText(req.params.id, 80);
  try {
    const result = await withTransaction(async (client) => {
      await client.query(`DELETE FROM sync_operations WHERE workspace_id IN (SELECT id FROM workspaces WHERE license_id = $1)`, [id]);
      await client.query(`DELETE FROM entities WHERE workspace_id IN (SELECT id FROM workspaces WHERE license_id = $1)`, [id]);
      await client.query(`DELETE FROM devices WHERE workspace_id IN (SELECT id FROM workspaces WHERE license_id = $1)`, [id]);
      await client.query(`DELETE FROM workspaces WHERE license_id = $1`, [id]);
      return client.query(`DELETE FROM licenses WHERE id = $1 RETURNING id`, [id]);
    });
    if (!result.rowCount) return jsonError(res, 404, "LICENSE_NOT_FOUND", "License not found.");
    return res.json({ ok: true, deleted: true });
  } catch (error) {
    return jsonError(res, 500, "LICENSE_DELETE_FAILED", error instanceof Error ? error.message : "License deletion failed");
  }
});

app.delete("/v1/admin/devices/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await query(`UPDATE devices SET revoked_at = NOW() WHERE id = $1 RETURNING id`, [normalizeText(req.params.id, 80)]);
    if (!result.rowCount) return jsonError(res, 404, "DEVICE_NOT_FOUND", "Device not found.");
    return res.json({ ok: true, revoked: true });
  } catch (error) {
    return jsonError(res, 500, "DEVICE_REVOKE_FAILED", error instanceof Error ? error.message : "Device revoke failed");
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
