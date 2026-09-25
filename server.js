const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DB_FILE = path.join(__dirname, "licenses.json");

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDb(db) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, DB_FILE);
}

function send(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token"
  });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => {
      s += c;
      if (Buffer.byteLength(s, "utf8") > 1024 * 1024) {
        reject(new Error("Payload demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); }
      catch { reject(new Error("JSON inválido")); }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  return Boolean(ADMIN_TOKEN) &&
    req.headers["x-admin-token"] === ADMIN_TOKEN;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const parts = u.pathname.split("/").filter(Boolean);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token"
      });
      return res.end();
    }

    // Render health check
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
      return send(res, 200, {
        ok: true,
        service: "ALFRED IOS API",
        status: "online"
      });
    }

    // Public: GET /api/license/KEY
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "license" && parts[2]) {
      const key = decodeURIComponent(parts.slice(2).join("/"));
      const db = loadDb();
      const item = db[key];

      if (!item) {
        return send(res, 404, {
          active: false,
          message: "Licencia no encontrada."
        });
      }

      const expires = new Date(item.expiresAt).getTime();
      const expired = !Number.isFinite(expires) || expires <= Date.now();
      const active = !expired && item.active !== false;

      return send(res, 200, {
        active,
        expiresAt: item.expiresAt,
        message: active
          ? "Licencia activa."
          : expired
            ? "Licencia vencida."
            : "Licencia desactivada."
      });
    }

    // Admin: POST /api/licenses
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "licenses") {
      if (!authorized(req)) {
        return send(res, 401, { error: "No autorizado." });
      }

      const data = await body(req);
      const key = String(data.key || crypto.randomBytes(6).toString("hex").toUpperCase()).trim();

      let expiresAt;
      if (data.expiresAt) {
        expiresAt = new Date(data.expiresAt).toISOString();
      } else {
        const days = Number(data.days || 30);
        if (!Number.isFinite(days) || days <= 0) {
          return send(res, 400, { error: "days inválido." });
        }
        expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      }

      const db = loadDb();
      db[key] = { active: true, expiresAt };
      saveDb(db);

      return send(res, 200, { key, active: true, expiresAt });
    }

    // Admin: DELETE /api/licenses/KEY
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "licenses" && parts[2]) {
      if (!authorized(req)) {
        return send(res, 401, { error: "No autorizado." });
      }

      const key = decodeURIComponent(parts.slice(2).join("/"));
      const db = loadDb();
      delete db[key];
      saveDb(db);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "Ruta no encontrada." });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: "Error interno del servidor." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ALFRED IOS API escuchando en ${HOST}:${PORT}`);
});
