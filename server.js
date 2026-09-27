const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "CAMBIA_ESTE_TOKEN";
const DB_FILE = "./licenses.json";
const PANEL_FILE = "./ALFRED_IOS_PANEL_ESTILO_PAGINA.html";

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return {}; }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function sendJson(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => s += c);
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); }
      catch { reject(new Error("JSON inválido")); }
    });
  });
}

function authorized(req) {
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const parts = u.pathname.split("/").filter(Boolean);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token"
    });
    return res.end();
  }

  // Panel web: https://TU-SERVICIO.onrender.com/panel
  if (req.method === "GET" && u.pathname === "/panel") {
    try {
      const html = fs.readFileSync(PANEL_FILE, "utf8");
      return sendHtml(res, html);
    } catch {
      return sendJson(res, 500, { error: "No se encontró el archivo del panel." });
    }
  }

  // Health
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return sendJson(res, 200, {
      ok: true,
      service: "ALFRED IOS API",
      status: "online"
    });
  }

  // Public: GET /api/license/KEY
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "license" && parts[2]) {
    const key = parts.slice(2).join("/");
    const db = loadDb();
    const item = db[key];

    if (!item) {
      return sendJson(res, 404, { active: false, message: "Licencia no encontrada." });
    }

    const expired = new Date(item.expiresAt).getTime() <= Date.now();

    return sendJson(res, 200, {
      active: !expired && item.active !== false,
      key,
      createdAt: item.createdAt || null,
      expiresAt: item.expiresAt,
      message: expired ? "Licencia vencida." : "Licencia activa."
    });
  }

  // Admin: GET /api/licenses
  if (req.method === "GET" && u.pathname === "/api/licenses") {
    if (!authorized(req)) return sendJson(res, 401, { error: "No autorizado." });

    const db = loadDb();
    const licenses = Object.entries(db).map(([key, item]) => {
      const expiresAtMs = new Date(item.expiresAt).getTime();
      const active = expiresAtMs > Date.now() && item.active !== false;
      return {
        key,
        active,
        createdAt: item.createdAt || null,
        expiresAt: item.expiresAt
      };
    });

    licenses.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
    return sendJson(res, 200, { licenses });
  }

  // Admin: POST /api/licenses {days:1|7|15|30}
  if (req.method === "POST" && u.pathname === "/api/licenses") {
    if (!authorized(req)) return sendJson(res, 401, { error: "No autorizado." });

    try {
      const data = await body(req);
      const key = data.key || ("ALFRED-" + crypto.randomBytes(6).toString("hex").toUpperCase());
      const createdAt = new Date().toISOString();
      const expiresAt = data.expiresAt ||
        new Date(Date.now() + Number(data.days || 30) * 86400000).toISOString();

      if (!Number.isFinite(new Date(expiresAt).getTime())) {
        return sendJson(res, 400, { error: "expiresAt inválido." });
      }

      const db = loadDb();

      if (db[key]) {
        return sendJson(res, 409, { error: "Esa licencia ya existe." });
      }

      db[key] = {
        active: true,
        createdAt,
        expiresAt
      };

      saveDb(db);

      return sendJson(res, 200, {
        key,
        active: true,
        createdAt,
        expiresAt
      });
    } catch {
      return sendJson(res, 400, { error: "JSON inválido." });
    }
  }

  // Admin: DELETE /api/licenses/KEY
  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "licenses" && parts[2]) {
    if (!authorized(req)) return sendJson(res, 401, { error: "No autorizado." });

    const key = parts.slice(2).join("/");
    const db = loadDb();

    if (!db[key]) return sendJson(res, 404, { error: "Licencia no encontrada." });

    delete db[key];
    saveDb(db);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Ruta no encontrada." });
});

server.listen(PORT, () => {
  console.log(`ALFRED IOS API escuchando en :${PORT}`);
});
