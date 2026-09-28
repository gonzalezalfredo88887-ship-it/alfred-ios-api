const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DB_FILE = "./licenses.json";

if (!ADMIN_TOKEN) console.warn("WARNING: ADMIN_TOKEN no está configurado.");

function loadDb() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function send(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => {
      s += c;
      if (s.length > 100000) {
        req.destroy();
        reject(new Error("Body demasiado grande"));
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); }
      catch { reject(new Error("JSON inválido")); }
    });
  });
}

function admin(req) {
  return !!ADMIN_TOKEN && req.headers["x-admin-token"] === ADMIN_TOKEN;
}

function hashDevice(deviceId) {
  return crypto.createHash("sha256").update(String(deviceId)).digest("hex");
}

function keyPath(parts) {
  return parts.slice(2).join("/");
}

function licenseView(key, item) {
  const now = Date.now();
  const expires = new Date(item.expiresAt).getTime();
  const expired = !Number.isFinite(expires) || expires <= now;
  const blocked = item.blocked === true || item.active === false;
  return {
    key,
    active: !expired && !blocked,
    blocked,
    createdAt: item.createdAt || null,
    expiresAt: item.expiresAt,
    deviceBound: !!item.deviceHash,
    lastUsedAt: item.lastUsedAt || null,
    message: blocked ? "Licencia bloqueada." : expired ? "Licencia vencida." : "Licencia activa."
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = u.pathname.split("/").filter(Boolean);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token"
    });
    return res.end();
  }

  // Panel web de administración
  if (req.method === "GET" && (u.pathname === "/panel" || u.pathname === "/panel/")) {
    try {
      const html = fs.readFileSync("./ALFRED_IOS_PANEL_ESTILO_PAGINA.html", "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      return res.end(html);
    } catch (err) {
      return send(res, 500, {error:"No se pudo cargar el panel.", detail:String(err.message || err)});
    }
  }

  if (req.method === "GET" && u.pathname === "/") {
    return send(res, 200, {ok:true, service:"ALFRED IOS API", panel:"/panel"});
  }

  if (req.method === "GET" && u.pathname === "/health") {
    return send(res, 200, {ok:true, service:"ALFRED IOS API", status:"online"});
  }

  // Consulta pública. Para una app con binding por dispositivo:
  // GET /api/license/KEY?deviceId=UUID
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "license" && parts[2]) {
    const key = keyPath(parts);
    const db = loadDb();
    const item = db[key];

    if (!item) return send(res, 404, {active:false, message:"Licencia no encontrada."});

    const deviceId = u.searchParams.get("deviceId");
    if (deviceId) {
      const h = hashDevice(deviceId);
      if (item.deviceHash && item.deviceHash !== h) {
        return send(res, 409, {
          active:false,
          code:"DEVICE_MISMATCH",
          message:"Esta licencia ya está vinculada a otro dispositivo."
        });
      }
      if (!item.deviceHash) {
        item.deviceHash = h;
        item.lastUsedAt = new Date().toISOString();
        saveDb(db);
      } else {
        item.lastUsedAt = new Date().toISOString();
        saveDb(db);
      }
    }

    return send(res, 200, licenseView(key, item));
  }

  // Activación explícita para apps nativas:
  // POST /api/license/activate {key, deviceId}
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "license" && parts[2] === "activate") {
    try {
      const data = await readBody(req);
      const key = String(data.key || "").trim();
      const deviceId = String(data.deviceId || "").trim();
      if (!key || !deviceId) return send(res, 400, {error:"key y deviceId son obligatorios."});

      const db = loadDb();
      const item = db[key];
      if (!item) return send(res, 404, {active:false, message:"Licencia no encontrada."});

      const state = licenseView(key, item);
      if (!state.active) return send(res, 403, state);

      const h = hashDevice(deviceId);
      if (item.deviceHash && item.deviceHash !== h) {
        return send(res, 409, {
          active:false,
          code:"DEVICE_MISMATCH",
          message:"Esta licencia ya está vinculada a otro dispositivo."
        });
      }

      item.deviceHash = h;
      item.lastUsedAt = new Date().toISOString();
      saveDb(db);
      return send(res, 200, licenseView(key, item));
    } catch {
      return send(res, 400, {error:"JSON inválido."});
    }
  }

  // Admin: ver TODAS las licencias.
  if (req.method === "GET" && u.pathname === "/api/licenses") {
    if (!admin(req)) return send(res, 401, {error:"No autorizado."});
    const db = loadDb();
    const licenses = Object.entries(db).map(([key, item]) => licenseView(key, item));
    licenses.sort((a,b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return send(res, 200, {licenses});
  }

  // Admin: crear licencia.
  if (req.method === "POST" && u.pathname === "/api/licenses") {
    if (!admin(req)) return send(res, 401, {error:"No autorizado."});

    try {
      const data = await readBody(req);
      const days = Number(data.days || 30);
      const key = String(data.key || ("ALFRED-" + crypto.randomBytes(5).toString("hex").toUpperCase())).trim();
      const expiresAt = data.expiresAt ||
        new Date(Date.now() + days * 86400000).toISOString();

      if (!Number.isFinite(days) || days <= 0)
        return send(res, 400, {error:"days inválido."});

      if (!Number.isFinite(new Date(expiresAt).getTime()))
        return send(res, 400, {error:"expiresAt inválido."});

      const db = loadDb();
      if (db[key]) return send(res, 409, {error:"Esa key ya existe."});

      db[key] = {
        active: true,
        blocked: false,
        createdAt: new Date().toISOString(),
        expiresAt,
        deviceHash: null,
        lastUsedAt: null
      };
      saveDb(db);
      return send(res, 200, licenseView(key, db[key]));
    } catch {
      return send(res, 400, {error:"JSON inválido."});
    }
  }

  // Admin: bloquear/desbloquear.
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "licenses" && parts[2] && parts[3] === "block") {
    if (!admin(req)) return send(res, 401, {error:"No autorizado."});
    try {
      const data = await readBody(req);
      const key = keyPath(parts);
      const db = loadDb();
      const item = db[key];
      if (!item) return send(res, 404, {error:"Licencia no encontrada."});
      item.blocked = data.blocked !== false;
      item.active = !item.blocked;
      saveDb(db);
      return send(res, 200, licenseView(key, item));
    } catch {
      return send(res, 400, {error:"JSON inválido."});
    }
  }

  // Admin: resetear vínculo del dispositivo.
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "licenses" && parts[2] && parts[3] === "reset-device") {
    if (!admin(req)) return send(res, 401, {error:"No autorizado."});
    const key = keyPath(parts);
    const db = loadDb();
    const item = db[key];
    if (!item) return send(res, 404, {error:"Licencia no encontrada."});
    item.deviceHash = null;
    item.lastUsedAt = null;
    saveDb(db);
    return send(res, 200, {ok:true, message:"Dispositivo desvinculado. La próxima activación podrá vincular uno nuevo.", ...licenseView(key,item)});
  }

  // Admin: borrar licencia definitivamente.
  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "licenses" && parts[2]) {
    if (!admin(req)) return send(res, 401, {error:"No autorizado."});
    const key = keyPath(parts);
    const db = loadDb();
    if (!db[key]) return send(res, 404, {error:"Licencia no encontrada."});
    delete db[key];
    saveDb(db);
    return send(res, 200, {ok:true, message:"Licencia eliminada."});
  }

  return send(res, 404, {error:"Ruta no encontrada."});
});

server.listen(PORT, () => console.log(`ALFRED IOS API escuchando en :${PORT}`));
