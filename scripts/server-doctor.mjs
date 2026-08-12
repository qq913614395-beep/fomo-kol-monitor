import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function loadEnv(file) {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

loadEnv(process.env.MONITOR_ENV_FILE || path.resolve(".env"));
const checks = [];
const add = (name, state, detail) => checks.push({ name, state, detail });
const [major, minor] = process.versions.node.split(".").map(Number);
add("node", major > 22 || (major === 22 && minor >= 13) ? "ok" : "error", process.versions.node);

const publicUrl = String(process.env.PUBLIC_BASE_URL || "");
let publicOrigin = "";
try { const parsed = new URL(publicUrl); publicOrigin = parsed.origin; add("public_https", parsed.protocol === "https:" ? "ok" : "error", publicOrigin); }
catch { add("public_https", "error", "PUBLIC_BASE_URL is missing or invalid"); }

const master = String(process.env.MONITOR_MASTER_KEY || "");
let masterBytes = 0;
try { masterBytes = Buffer.from(master, "base64url").length; } catch {}
add("master_key", process.platform === "win32" && !master ? "ok" : masterBytes === 32 ? "ok" : "error", process.platform === "win32" && !master ? "Windows DPAPI" : `${masterBytes} bytes`);

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim());
add("allowed_origin", publicOrigin && allowedOrigins.includes(publicOrigin) ? "ok" : "error", allowedOrigins.join(", ") || "empty");
let hostname = "";
try { hostname = new URL(publicOrigin).hostname; } catch {}
const trustedHosts = String(process.env.TRUSTED_HOSTS || "").split(",").map((item) => item.trim().toLowerCase());
add("trusted_host", hostname && trustedHosts.includes(hostname.toLowerCase()) ? "ok" : "error", trustedHosts.join(", ") || "empty");

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
try { accessSync(dataDir, constants.R_OK | constants.W_OK); add("data_directory", "ok", dataDir); }
catch { add("data_directory", "error", `${dataDir} is not readable and writable`); }

const databaseFile = path.resolve(process.env.DATABASE_PATH || path.join(dataDir, "monitor.sqlite3"));
let activeTargets = 0;
if (existsSync(databaseFile)) {
  try {
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    const integrity = database.prepare("PRAGMA quick_check").get().quick_check;
    activeTargets = Number(database.prepare("SELECT COUNT(*) AS count FROM monitor_targets WHERE desired_state='active'").get().count || 0);
    database.close();
    add("sqlite", integrity === "ok" ? "ok" : "error", `${integrity}; ${activeTargets} physical targets`);
  } catch (error) { add("sqlite", "error", error.message); }
} else add("sqlite", "warn", "database will be created on first start");

const rate = Math.max(1, Number(process.env.GMGN_REQUESTS_PER_SECOND || 8));
const projectedTargets = Math.max(activeTargets, Number(process.env.DESIGN_TARGET_COUNT || 1000));
const cycleSeconds = Math.ceil(projectedTargets / rate);
add("gmgn_capacity", cycleSeconds <= 30 ? "ok" : "warn", `${projectedTargets} targets at ${rate} requests/s => at least ${cycleSeconds}s per confirmation cycle`);

for (const name of ["SOLANA_RPC_HTTP", "BASE_RPC_HTTP", "BNB_RPC_HTTP", "ETH_RPC_HTTP"]) {
  const value = String(process.env[name] || "");
  const privateEndpoint = value && !/publicnode|mainnet-beta\.solana\.com|cloudflare-eth|mainnet\.base\.org|binance\.org/i.test(value);
  add(name.toLowerCase(), privateEndpoint ? "ok" : "warn", !value ? "missing" : privateEndpoint ? "configured endpoint" : "public/shared endpoint detected");
}

const output = { ok: !checks.some((item) => item.state === "error"), checks };
if (process.argv.includes("--json")) console.log(JSON.stringify(output, null, 2));
else for (const check of checks) console.log(`${check.state.toUpperCase().padEnd(5)} ${check.name.padEnd(20)} ${check.detail}`);
if (!output.ok) process.exitCode = 1;
