const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "CAMBIA_ESTE_TOKEN";
const DB_FILE = "./licenses.json";

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return {}; }
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

  // Public endpoint: GET /api/license/KEY
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "license" && parts[2]) {
    const key = parts.slice(2).join("/");
    const db = loadDb();
    const item = db[key];

    if (!item) return send(res, 404, {active:false, message:"Licencia no encontrada."});

    const expired = new Date(item.expiresAt).getTime() <= Date.now();
    return send(res, 200, {
      active: !expired && item.active !== false,
      expiresAt: item.expiresAt,
      message: expired ? "Licencia vencida." : "Licencia activa."
    });
  }

  // Admin: POST /api/licenses  {days:30} or {expiresAt:"2026-12-31T23:59:59Z", key:"..."}
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "licenses") {
    if (req.headers["x-admin-token"] !== ADMIN_TOKEN)
      return send(res, 401, {error:"No autorizado."});

    try {
      const data = await body(req);
      const key = data.key || crypto.randomBytes(6).toString("hex").toUpperCase();
      const expiresAt = data.expiresAt || new Date(Date.now() + Number(data.days || 30)*86400000).toISOString();

      if (Number.isNaN(new Date(expiresAt).getTime()))
        return send(res, 400, {error:"expiresAt inválido."});

      const db = loadDb();
      db[key] = {active:true, expiresAt};
      saveDb(db);

      return send(res, 200, {key, active:true, expiresAt});
    } catch {
      return send(res, 400, {error:"JSON inválido."});
    }
  }

  // Admin: DELETE /api/licenses/KEY
  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "licenses" && parts[2]) {
    if (req.headers["x-admin-token"] !== ADMIN_TOKEN)
      return send(res, 401, {error:"No autorizado."});

    const key = parts.slice(2).join("/");
    const db = loadDb();
    delete db[key];
    saveDb(db);
    return send(res, 200, {ok:true});
  }

  send(res, 404, {error:"Ruta no encontrada."});
});

server.listen(PORT, () => console.log(`ALFRED IOS API escuchando en :${PORT}`));
