const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ADMIN_TOKEN) {
  console.error("ERROR: Falta la variable de entorno ADMIN_TOKEN.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("ERROR: Falta la variable de entorno DATABASE_URL.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function adminAuthorized(req) {
  return typeof req.headers["x-admin-token"] === "string" &&
    req.headers["x-admin-token"] === ADMIN_TOKEN;
}

function requireAdmin(req, res) {
  if (!adminAuthorized(req)) {
    sendJson(res, 401, { error: "ADMIN_TOKEN inválido o ausente." });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request demasiado grande."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error("JSON inválido.")); }
    });
    req.on("error", reject);
  });
}

function makeKey() {
  const a = crypto.randomBytes(4).toString("hex").toUpperCase();
  const b = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `ALFRED-${a}-${b}`;
}

function normalizeLicense(row) {
  const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
  const createdAt = row.created_at ? new Date(row.created_at).toISOString() : null;
  const lastUsedAt = row.last_used_at ? new Date(row.last_used_at).toISOString() : null;
  return {
    key: row.key,
    createdAt,
    expiresAt,
    blocked: Boolean(row.blocked),
    active: !row.blocked && Boolean(row.expires_at) && new Date(row.expires_at).getTime() > Date.now(),
    deviceBound: Boolean(row.device_id),
    lastUsedAt
  };
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      blocked BOOLEAN NOT NULL DEFAULT FALSE,
      device_id TEXT,
      last_used_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON licenses (expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_device_id ON licenses (device_id)`);
}

async function getLicense(key) {
  const result = await pool.query(
    `SELECT id, key, created_at, expires_at, blocked, device_id, last_used_at
     FROM licenses WHERE key = $1 LIMIT 1`, [key]
  );
  return result.rows[0] || null;
}

async function listLicenses() {
  const result = await pool.query(`
    SELECT id, key, created_at, expires_at, blocked, device_id, last_used_at
    FROM licenses ORDER BY created_at DESC
  `);
  return result.rows.map(normalizeLicense);
}

async function createLicense(body) {
  const key = typeof body.key === "string" && body.key.trim() ? body.key.trim() : makeKey();
  if (key.length > 200) throw new Error("La key es demasiado larga.");

  let expiresAt;
  if (body.expiresAt) {
    expiresAt = new Date(body.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw new Error("expiresAt no es una fecha válida.");
  } else {
    const days = Number(body.days ?? 30);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw new Error("days debe ser un número entre 1 y 3650.");
    }
    expiresAt = new Date(Date.now() + days * 86400000);
  }

  const result = await pool.query(
    `INSERT INTO licenses (key, expires_at) VALUES ($1, $2)
     RETURNING id, key, created_at, expires_at, blocked, device_id, last_used_at`,
    [key, expiresAt]
  );
  return normalizeLicense(result.rows[0]);
}

async function handleLicenseValidation(res, url) {
  const key = decodeURIComponent(url.pathname.slice("/api/license/".length));
  const deviceId = url.searchParams.get("deviceId");

  if (!key) return sendJson(res, 400, { error: "Falta la licencia." });
  const license = await getLicense(key);

  if (!license) {
    return sendJson(res, 404, { active: false, message: "Licencia inválida o inactiva." });
  }
  if (license.blocked) {
    return sendJson(res, 403, { license: { ...normalizeLicense(license), active: false }, message: "Esta licencia está bloqueada." });
  }
  if (new Date(license.expires_at).getTime() <= Date.now()) {
    return sendJson(res, 403, { license: { ...normalizeLicense(license), active: false }, message: "Esta licencia está vencida." });
  }
  if (!deviceId || deviceId.length > 500) {
    return sendJson(res, 400, { active: false, message: "Falta un deviceId válido." });
  }
  if (license.device_id && license.device_id !== deviceId) {
    return sendJson(res, 403, { license: { ...normalizeLicense(license), active: false }, message: "Esta licencia ya está vinculada a otro dispositivo." });
  }

  const updated = await pool.query(
    `UPDATE licenses SET device_id = COALESCE(device_id, $1), last_used_at = NOW()
     WHERE id = $2
     RETURNING id, key, created_at, expires_at, blocked, device_id, last_used_at`,
    [deviceId, license.id]
  );
  return sendJson(res, 200, { license: normalizeLicense(updated.rows[0]) });
}

async function handleAdminRoutes(req, res, url) {
  if (!requireAdmin(req, res)) return;

  if (req.method === "GET" && url.pathname === "/api/licenses") {
    return sendJson(res, 200, { licenses: await listLicenses() });
  }

  if (req.method === "POST" && url.pathname === "/api/licenses") {
    try {
      const license = await createLicense(await readBody(req));
      return sendJson(res, 201, license);
    } catch (err) {
      if (err && err.code === "23505") return sendJson(res, 409, { error: "Esa key ya existe." });
      return sendJson(res, 400, { error: err.message || "No se pudo crear la licencia." });
    }
  }

  const match = url.pathname.match(/^\/api\/licenses\/([^/]+)(?:\/(block|reset-device))?$/);
  if (!match) return sendJson(res, 404, { error: "Ruta no encontrada." });

  const key = decodeURIComponent(match[1]);
  const action = match[2];

  if (req.method === "POST" && action === "block") {
    const body = await readBody(req);
    const result = await pool.query(
      `UPDATE licenses SET blocked = $1 WHERE key = $2
       RETURNING id, key, created_at, expires_at, blocked, device_id, last_used_at`,
      [Boolean(body.blocked), key]
    );
    if (!result.rows[0]) return sendJson(res, 404, { error: "Licencia no encontrada." });
    return sendJson(res, 200, normalizeLicense(result.rows[0]));
  }

  if (req.method === "POST" && action === "reset-device") {
    const result = await pool.query(
      `UPDATE licenses SET device_id = NULL WHERE key = $1
       RETURNING id, key, created_at, expires_at, blocked, device_id, last_used_at`, [key]
    );
    if (!result.rows[0]) return sendJson(res, 404, { error: "Licencia no encontrada." });
    return sendJson(res, 200, normalizeLicense(result.rows[0]));
  }

  if (req.method === "DELETE" && !action) {
    const result = await pool.query(`DELETE FROM licenses WHERE key = $1 RETURNING key`, [key]);
    if (!result.rows[0]) return sendJson(res, 404, { error: "Licencia no encontrada." });
    return sendJson(res, 200, { ok: true, key: result.rows[0].key });
  }

  return sendJson(res, 405, { error: "Método no permitido." });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
      });
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, { ok: true, service: "ALFRED IOS API", database: "PostgreSQL" });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      await pool.query("SELECT 1");
      return sendJson(res, 200, { ok: true, database: "connected" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/license/")) {
      return handleLicenseValidation(res, url);
    }
    if (url.pathname === "/api/licenses" || url.pathname.startsWith("/api/licenses/")) {
      return handleAdminRoutes(req, res, url);
    }
    return sendJson(res, 404, { error: "Ruta no encontrada." });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "Error interno del servidor." });
  }
});

async function start() {
  try {
    await pool.query("SELECT 1");
    await ensureSchema();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`ALFRED IOS API escuchando en el puerto ${PORT}`);
      console.log("PostgreSQL conectado y tabla licenses lista.");
    });
  } catch (err) {
    console.error("No se pudo iniciar la API:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", async () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});

start();
