import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseImport } from "./core.mjs";
import { ENTRYPOINT_V07, ENTRYPOINT_V08 } from "./core.mjs";
import { EventEnricher } from "./enricher.mjs";
import { FomoBridgeSecretStore, normalizeFomoAlert, verifyBridgeSignature } from "./fomo-web.mjs";
import { GmgnWatcher } from "./gmgn.mjs";
import { Notifier } from "./notifier.mjs";
import { RealtimeWatchers } from "./realtime.mjs";
import { resolvePerson } from "./resolver.mjs";
import { Store } from "./store.mjs";
import { NotificationSecretStore } from "./secrets.mjs";
import { Watchers } from "./watchers.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = () => new Date().toISOString();

async function loadEnv(file) {
  try {
    const text = await readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
await loadEnv(path.join(projectRoot, ".env"));

const bool = (value, fallback = false) => value == null || value === "" ? fallback : ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
const list = (value, fallback = []) => {
  const values = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? values : fallback;
};

const config = {
  port: Number(process.env.PORT || 8788),
  pollIntervalMs: Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 2500)),
  evmPollIntervalMs: Math.max(1000, Number(process.env.EVM_POLL_INTERVAL_MS || 2500)),
  relayPollIntervalMs: Math.max(2000, Number(process.env.RELAY_POLL_INTERVAL_MS || 4000)),
  solanaPageSize: Math.max(8, Math.min(100, Number(process.env.SOLANA_PAGE_SIZE || 20))),
  solanaMaxPages: Math.max(1, Math.min(20, Number(process.env.SOLANA_MAX_PAGES || 5))),
  evmMaxBlockRange: Math.max(1, Number(process.env.EVM_MAX_BLOCK_RANGE || 50)),
  evmMaxCatchupBlocks: Math.max(20, Number(process.env.EVM_MAX_CATCHUP_BLOCKS || 200)),
  relayPageSize: Math.max(8, Math.min(50, Number(process.env.RELAY_PAGE_SIZE || 25))),
  backfillOnFirstRun: bool(process.env.BACKFILL_ON_FIRST_RUN, false),
  dataDir: path.resolve(projectRoot, process.env.DATA_DIR || "./data"),
  databaseFile: path.resolve(projectRoot, process.env.DATABASE_PATH || "./data/monitor.sqlite3"),
  solanaRpcHttp: process.env.SOLANA_RPC_HTTP || "https://api.mainnet-beta.solana.com",
  solanaRpcWs: process.env.SOLANA_RPC_WS || "",
  enableRpcWebsocket: bool(process.env.ENABLE_RPC_WEBSOCKET, true),
  subscriptionRefreshMs: Math.max(5000, Number(process.env.SUBSCRIPTION_REFRESH_MS || 15_000)),
  entryPointAddresses: list(process.env.EVM_ENTRYPOINT_ADDRESSES, [ENTRYPOINT_V08, ENTRYPOINT_V07]),
  relayApiBase: process.env.RELAY_API_BASE || "https://api.relay.link",
  relayRequestsPath: process.env.RELAY_REQUESTS_PATH || "/requests/v2",
  relayApiKey: process.env.RELAY_API_KEY || "",
  enableFomoscanResolver: bool(process.env.ENABLE_FOMOSCAN_RESOLVER, false),
  enableTokenEnrichment: bool(process.env.ENABLE_TOKEN_ENRICHMENT, true),
  dexScreenerApiBase: process.env.DEXSCREENER_API_BASE || "https://api.dexscreener.com",
  tokenCacheTtlMs: Math.max(15_000, Number(process.env.TOKEN_CACHE_TTL_MS || 60_000)),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  webhookUrl: process.env.WEBHOOK_URL || "",
  enableGmgn: bool(process.env.ENABLE_GMGN, true),
  gmgnCliPath: process.env.GMGN_CLI_PATH || "",
  gmgnChains: list(process.env.GMGN_CHAINS, ["sol", "bsc", "base", "eth"]),
  gmgnPollIntervalMs: Math.max(3000, Number(process.env.GMGN_POLL_INTERVAL_MS || 5000)),
  gmgnCommandTimeoutMs: Math.max(5000, Number(process.env.GMGN_COMMAND_TIMEOUT_MS || 15_000)),
  gmgnLimit: Math.max(10, Math.min(100, Number(process.env.GMGN_LIMIT || 100))),
  gmgnMaxPages: Math.max(1, Math.min(10, Number(process.env.GMGN_MAX_PAGES || 4))),
  gmgnLookbackSeconds: Math.max(60, Number(process.env.GMGN_LOOKBACK_SECONDS || 600)),
  gmgnConcurrency: Math.max(1, Math.min(32, Number(process.env.GMGN_CONCURRENCY || 4))),
  gmgnRequestsPerSecond: Math.max(1, Math.min(50, Number(process.env.GMGN_REQUESTS_PER_SECOND || 8))),
  rpcConcurrency: Math.max(1, Math.min(64, Number(process.env.RPC_CONCURRENCY || 8))),
  relayConcurrency: Math.max(1, Math.min(32, Number(process.env.RELAY_CONCURRENCY || 4))),
  disableExternalCollectors: bool(process.env.DISABLE_EXTERNAL_COLLECTORS, false),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS, ["http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:3002", "http://127.0.0.1:3002"]),
  trustedHosts: list(process.env.TRUSTED_HOSTS, []),
  evmChains: [
    { key: "base", name: "Base", chainId: 8453, rpcUrl: process.env.BASE_RPC_HTTP || "https://base-rpc.publicnode.com", fallbackRpcUrl: process.env.BASE_RPC_FALLBACK_HTTP || "https://mainnet.base.org", wsUrl: process.env.BASE_RPC_WS || "" },
    { key: "bsc", name: "BNB Chain", chainId: 56, rpcUrl: process.env.BNB_RPC_HTTP || "https://bsc-rpc.publicnode.com", fallbackRpcUrl: process.env.BNB_RPC_FALLBACK_HTTP || "https://bsc-dataseed.binance.org", wsUrl: process.env.BNB_RPC_WS || "" },
    { key: "ethereum", name: "Ethereum", chainId: 1, rpcUrl: process.env.ETH_RPC_HTTP || "https://ethereum-rpc.publicnode.com", fallbackRpcUrl: process.env.ETH_RPC_FALLBACK_HTTP || "https://cloudflare-eth.com", wsUrl: process.env.ETH_RPC_WS || "" },
  ],
};

const lockPath = path.resolve(projectRoot, process.env.INSTANCE_LOCK_PATH || `${config.databaseFile}.lock`);
const lockOwner = randomUUID();
const lockRecord = { pid: process.pid, owner: lockOwner, startedAt: stamp(), databaseFile: config.databaseFile };

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // EPERM means the process exists but belongs to a different account. Any
    // unknown result is also treated as live so an active lock is never removed.
    return true;
  }
}

function recoverStaleLock() {
  let existing;
  let malformed = false;
  try {
    existing = JSON.parse(readFileSync(lockPath, "utf8"));
    malformed = !Number.isSafeInteger(Number(existing?.pid)) || Number(existing.pid) <= 0 || typeof existing?.owner !== "string" || !existing.owner;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    malformed = true;
  }
  if (malformed) {
    // A newly-created lock has a very small open/write window. Do not recover
    // malformed or empty content until it has remained unchanged for 30s.
    let ageMs = 0;
    try { ageMs = Date.now() - statSync(lockPath).mtimeMs; } catch (statError) { return statError.code === "ENOENT"; }
    if (ageMs < 30_000) throw new Error(`INSTANCE_LOCK_INITIALIZING: ${lockPath}`);
    existing = null;
  }
  if (existing && processIsAlive(Number(existing.pid)) !== false) {
    throw new Error(`INSTANCE_ALREADY_RUNNING: pid=${existing.pid} lock=${lockPath}`);
  }

  // Rename is the recovery claim: if another starter won the race, this fails
  // and acquisition is retried without ever unlinking the new owner's lock.
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  try { unlinkSync(stalePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return true;
}

function acquireInstanceLock() {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(handle, `${JSON.stringify(lockRecord)}\n`, null, "utf8");
        fsyncSync(handle);
        return handle;
      } catch (error) {
        closeSync(handle);
        try { unlinkSync(lockPath); } catch {}
        throw error;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      recoverStaleLock();
    }
  }
  throw new Error(`INSTANCE_LOCK_ACQUIRE_FAILED: ${lockPath}`);
}

function releaseInstanceLock(handle) {
  try { closeSync(handle); } catch {}
  try {
    const existing = JSON.parse(readFileSync(lockPath, "utf8"));
    if (existing.owner === lockOwner && Number(existing.pid) === process.pid) unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`INSTANCE_LOCK_RELEASE_FAILED: ${error.message}`);
  }
}
const lockHandle = acquireInstanceLock();

const store = new Store(config.dataDir, { databaseFile: config.databaseFile });
await store.load();
const database = store.database;
const notificationSecrets = new NotificationSecretStore(path.join(config.dataDir, "notification-secrets.dpapi.json"));
await notificationSecrets.load();
const fomoBridgeSecrets = new FomoBridgeSecretStore(path.join(config.dataDir, "fomo-web-bridge.dpapi.json"), process.env.FOMO_BRIDGE_TEST_SECRET || "");
await fomoBridgeSecrets.load();
const savedTelegram = await notificationSecrets.get("telegram");
const savedWebhook = await notificationSecrets.get("webhook");
if (savedTelegram?.enabled !== false) { config.telegramBotToken = savedTelegram?.botToken || config.telegramBotToken; config.telegramChatId = savedTelegram?.chatId || config.telegramChatId; }
if (savedWebhook?.enabled !== false) config.webhookUrl = savedWebhook?.url || config.webhookUrl;
function refreshNotificationRecipients() {
  database.notificationRecipients = [
    ...(config.telegramBotToken && config.telegramChatId ? [{ channel: "telegram", recipient: config.telegramChatId }] : []),
    ...(config.webhookUrl ? [{ channel: "webhook", recipient: "configured-webhook" }] : []),
  ];
}
refreshNotificationRecipients();
const localSessionToken = randomBytes(24).toString("base64url");
const runtimeStatus = { startedAt: stamp(), readiness: "starting", lastPollAt: "", lastErrorAt: "", error: "", sources: {}, sourceDetails: {} };
const sseClients = new Set();
const notifier = new Notifier(config, (error) => { runtimeStatus.error = error.message; });
const enricher = new EventEnricher(config);
let lastBroadcastSequence = Number(database.eventBounds().max || 0);

function publicConfig() {
  return {
    pollIntervalMs: config.pollIntervalMs, gmgnPollIntervalMs: config.gmgnPollIntervalMs,
    backfillOnFirstRun: config.backfillOnFirstRun, websocket: config.enableRpcWebsocket,
    gmgn: config.enableGmgn, resolverEnabled: config.enableFomoscanResolver,
    tokenEnrichment: config.enableTokenEnrichment,
    notifications: { telegram: Boolean(config.telegramBotToken && config.telegramChatId), webhook: Boolean(config.webhookUrl), browser: true },
    fomoWeb: { configured: fomoBridgeSecrets.status().configured, transport: "authenticated-browser-bridge", authoritative: false },
    chains: [{ key: "solana", name: "Solana", chainId: 792703809 }, ...config.evmChains.map(({ key, name, chainId }) => ({ key, name, chainId }))],
  };
}

function sendEnvelope(client, envelope) {
  client.write(`id: ${envelope.sequence}\nevent: monitor-event\ndata: ${JSON.stringify(envelope)}\n\n`);
}

function flushEvents() {
  const envelopes = database.eventsAfter(lastBroadcastSequence, 500);
  for (const envelope of envelopes) {
    for (const client of sseClients) sendEnvelope(client, envelope);
    lastBroadcastSequence = envelope.sequence;
  }
}

function recomputeReadiness() {
  if (config.disableExternalCollectors) {
    runtimeStatus.readiness = "degraded";
    return;
  }
  const details = Object.entries(runtimeStatus.sourceDetails).filter(([source]) => !["collectors", "fomo_web"].includes(source)).map(([, detail]) => detail);
  if (!details.length) {
    runtimeStatus.readiness = "starting";
    return;
  }
  const states = details.map((detail) => String(detail.health || detail.state || "unknown").toLowerCase());
  const degraded = states.some((state) => /degraded|unconfigured|disabled|error|unavailable|reconnecting|needs api key/.test(state));
  const onlyPending = states.every((state) => /starting|connecting|waiting|unknown/.test(state));
  runtimeStatus.readiness = degraded ? "degraded" : onlyPending ? "starting" : "healthy";
}

function report(source, state, detail = {}) {
  const health = detail.health || (state === "connected" ? "healthy" : String(state).startsWith("error") ? "degraded" : state);
  runtimeStatus.sources[source] = state;
  runtimeStatus.sourceDetails[source] = { ...(runtimeStatus.sourceDetails[source] || {}), ...detail, state, health, updatedAt: stamp() };
  recomputeReadiness();
  try { database.upsertHealth(source, runtimeStatus.sourceDetails[source]); flushEvents(); } catch (error) { runtimeStatus.error = error.message; }
}

async function emit(event) {
  const result = await store.addOrMergeEvent(event);
  if (result.record?.kind === "trade" && result.record?.confirmationState === "confirmed") database.reconcilePendingFomoAlerts();
  flushEvents();
  const needsMarketEnrichment = result.record?.kind === "trade"
    && (result.isNew || (result.isUpdated && !result.record.marketEnrichedAt));
  if (needsMarketEnrichment) {
    enricher.enrich(result.record).then(async (enriched) => {
      if (enriched === result.record || !enriched.token) return;
      await store.updateEvent(result.record.stableSourceGroupKey || result.record.key, {
        ...enriched,
        marketEnrichedAt: stamp(),
        notificationEligible: false,
      });
      report("market", "connected", { transport: "http", health: "healthy", lastCheckedAt: stamp() });
    }).catch((error) => report("market", `error: ${error.message}`, { transport: "http", health: "degraded", errorCode: "MARKET_ENRICHMENT_FAILED", errorMessage: error.message }));
  }
  return result.isNew ? result.record : null;
}

const watchers = new Watchers({ config, store, emit, status: runtimeStatus, report });
const realtimeWatchers = new RealtimeWatchers({ config, store, emit, report });
const gmgnWatcher = new GmgnWatcher({ config, store, emit, report });

function originAllowed(request) {
  const origin = request.headers.origin;
  return !origin || config.allowedOrigins.includes(origin);
}
function hostAllowed(host) {
  const normalized = String(host || "").toLowerCase().replace(/\.$/, "");
  if (/^(127\.0\.0\.1|localhost):\d+$/.test(normalized)) return true;
  return config.trustedHosts.some((item) => {
    const trusted = String(item).toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    return normalized === trusted || normalized.split(":")[0] === trusted;
  });
}
function bridgeOriginAllowed(request) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(String(request.headers.origin || ""));
}
function fomoBridgeStatus() {
  const secret = fomoBridgeSecrets.status();
  const source = runtimeStatus.sourceDetails.fomo_web || database.listHealth().find((item) => item.source === "fomo_web") || {};
  return {
    configured: secret.configured,
    updatedAt: secret.updatedAt,
    secretMask: secret.secretMask,
    transport: "authenticated-browser-bridge",
    authoritative: false,
    createsTrades: false,
    createsNotifications: false,
    source,
    summary: database.fomoBridgeSummary(),
  };
}
function applyCors(request, response) {
  const origin = request.headers.origin;
  if (origin && (config.allowedOrigins.includes(origin) || bridgeOriginAllowed(request))) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,x-local-session,idempotency-key,last-event-id,x-fomo-timestamp,x-fomo-signature");
}
function jsonResponse(request, response, status, payload) {
  applyCors(request, response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}
function errorResponse(request, response, status, code, message, requestId, details = {}, retryable = false) {
  jsonResponse(request, response, status, { error: { code, message, retryable, details }, requestId });
}
async function body(request, limit = 1_000_000) {
  const text = await rawBody(request, limit);
  return text ? JSON.parse(text) : {};
}
async function rawBody(request, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large"), { code: "REQUEST_TOO_LARGE", status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function authorizeMutation(request) {
  if (!originAllowed(request)) throw Object.assign(new Error("Origin is not allowed"), { code: "ORIGIN_REJECTED", status: 403 });
  if (request.headers["x-local-session"] !== localSessionToken) throw Object.assign(new Error("Local session token is missing or invalid"), { code: "LOCAL_SESSION_REQUIRED", status: 403 });
}
function page(url) {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 100)));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor") || 0));
  return { limit, cursor };
}
function accepted(request, response, operation) { jsonResponse(request, response, 202, { operationId: operation.id, operation, requestId: request.requestId }); }
function runOperation(operation, task) {
  queueMicrotask(async () => {
    database.updateOperation(operation.id, { status: "running", progress: 5 }); flushEvents();
    try {
      const result = await task((progress) => database.updateOperation(operation.id, { status: "running", progress }));
      database.updateOperation(operation.id, { status: "succeeded", progress: 100, result });
    } catch (error) {
      database.updateOperation(operation.id, { status: "failed", progress: 100, errorCode: error.code || "OPERATION_FAILED", errorMessage: error.message });
    }
    flushEvents();
  });
}

async function reconcileNow() {
  const results = gmgnWatcher.getReconciliation();
  const saved = [];
  for (const item of results) saved.push(database.saveReconciliation({
    personId: item.personId, chain: item.chain, wallet: item.wallet,
    windowStart: new Date(Date.now() - 86400000).toISOString(), windowEnd: stamp(),
    status: item.sourceComplete ? "closed" : "incomplete", sourceComplete: Boolean(item.sourceComplete), sourceCount: item.sourceTransactions,
    localCount: item.localTransactions, matched: item.matched || 0,
    missing: item.missing, extra: item.extra || 0, mismatched: item.mismatched || 0, items: item.items || [],
  }));
  return saved;
}

async function processOutbox() {
  const rows = database.listDeliverableNotifications({ excludeChannel: "browser", limit: 10 });
  for (const row of rows) {
    const claimed = database.claimNotification(row.id, `worker:${process.pid}`);
    if (!claimed) continue;
    const trade = database.getTrade(row.trade_id);
    const person = trade?.personId ? database.getPerson(trade.personId) : database.listPeople().find((item) => trade?.kolIds?.includes(item.id));
    try {
      const delivered = await notifier.sendChannel(row.channel, trade, person, row.idempotency_key);
      database.finishNotification(row.id, delivered);
    } catch (error) {
      const attempts = row.attempts + 1;
      const status = error.retryable && attempts < 3 ? "retry_wait" : error.retryable ? "failed" : "unknown_delivery";
      database.finishNotification(row.id, { status, error: error.message });
      if (status === "retry_wait") database.db.prepare("UPDATE notification_outbox SET next_retry_at=? WHERE id=?").run(new Date(Date.now() + 1000 * 2 ** attempts).toISOString(), row.id);
    }
  }
  flushEvents();
}

const server = http.createServer(async (request, response) => {
  request.requestId = randomUUID();
  applyCors(request, response);
  if (request.method === "OPTIONS") {
    const preflightPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const allowed = originAllowed(request) || (preflightPath === "/api/v1/ingest/fomo-alerts" && bridgeOriginAllowed(request));
    if (!allowed) return errorResponse(request, response, 403, "ORIGIN_REJECTED", "Origin is not allowed", request.requestId);
    response.writeHead(204); response.end(); return;
  }
  const host = request.headers.host || "";
  if (!hostAllowed(host)) return errorResponse(request, response, 400, "HOST_REJECTED", "Host is not allowed", request.requestId);
  const url = new URL(request.url, `http://${host}`);
  try {
    if (request.method === "GET" && url.pathname === "/") return jsonResponse(request, response, 200, { name: "FOMO KOL Monitor", apiVersion: "v1", dashboard: "http://localhost:3001" });

    if (request.method === "GET" && ["/api/status", "/api/v1/status"].includes(url.pathname)) {
      const summary = database.statusSummary();
      return jsonResponse(request, response, 200, { ...runtimeStatus, ...summary, readiness: runtimeStatus.readiness, sourceDetails: Object.fromEntries(database.listHealth().map((item) => [item.source, item])), config: publicConfig(), fomoWeb: fomoBridgeStatus(), localSessionToken, asOfEventId: summary.asOfEventId, requestId: request.requestId });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/status:refresh") {
      authorizeMutation(request); const op = database.createOperation("status.refresh", { idempotencyKey: request.headers["idempotency-key"], requestId: request.requestId });
      runOperation(op, async () => ({ status: database.statusSummary(), health: database.listHealth() })); return accepted(request, response, op);
    }

    if (request.method === "GET" && ["/api/people", "/api/v1/people"].includes(url.pathname)) {
      const people = store.listPeople();
      return jsonResponse(request, response, 200, url.pathname.startsWith("/api/v1") ? { items: people, nextCursor: null, asOfEventId: database.eventBounds().max } : people);
    }
    if (request.method === "POST" && ["/api/people", "/api/v1/people"].includes(url.pathname)) {
      authorizeMutation(request); const input = await body(request);
      if (url.pathname === "/api/v1/people") {
        const op = database.createOperation("people.create", { idempotencyKey: request.headers["idempotency-key"], requestId: request.requestId });
        runOperation(op, async () => ({ person: await store.upsertPerson(input) })); return accepted(request, response, op);
      }
      const person = await store.upsertPerson(input); flushEvents(); return jsonResponse(request, response, 201, person);
    }

    if (request.method === "POST" && url.pathname === "/api/v1/people/import:preview") {
      authorizeMutation(request); const input = await body(request); const rows = parseImport(input.text || JSON.stringify(input.people || []));
      const current = new Map(store.listPeople().map((item) => [item.handle, item]));
      const preview = rows.map((row) => ({ row, action: !row.handle ? "invalid" : current.has(row.handle) ? "update" : "create", reason: !row.handle ? "handle is required" : "" }));
      return jsonResponse(request, response, 200, { items: preview, summary: { create: preview.filter((x) => x.action === "create").length, update: preview.filter((x) => x.action === "update").length, invalid: preview.filter((x) => x.action === "invalid").length } });
    }
    if (request.method === "POST" && ["/api/import", "/api/v1/people/import:commit"].includes(url.pathname)) {
      authorizeMutation(request); const input = await body(request); const op = database.createOperation("people.import", { idempotencyKey: request.headers["idempotency-key"], requestId: request.requestId });
      runOperation(op, async (progress) => {
        const rows = parseImport(input.text || JSON.stringify(input.people || [])); const imported = [];
        for (let index = 0; index < rows.length; index += 1) { imported.push(await store.upsertPerson(rows[index])); progress(Math.round(((index + 1) / Math.max(rows.length, 1)) * 90)); }
        return { count: imported.length, people: imported };
      }); return accepted(request, response, op);
    }

    const personAction = url.pathname.match(/^\/api\/v1\/people\/([^/:]+):(pause|resume|backfill)$/);
    if (personAction && request.method === "POST") {
      authorizeMutation(request); const [, personId, action] = personAction; const person = store.getPerson(personId);
      if (!person) return errorResponse(request, response, 404, "PERSON_NOT_FOUND", "Person not found", request.requestId);
      if (action === "pause" || action === "resume") {
        const updated = await store.setPersonState(personId, action === "pause" ? "paused" : "active"); flushEvents(); return jsonResponse(request, response, 200, updated);
      }
      const op = database.createOperation("people.backfill", { idempotencyKey: request.headers["idempotency-key"], requestId: request.requestId });
      runOperation(op, async () => gmgnWatcher.backfillPerson(person)); return accepted(request, response, op);
    }
    const legacyBackfill = url.pathname.match(/^\/api\/people\/([^/]+)\/backfill$/);
    if (legacyBackfill && request.method === "POST") {
      authorizeMutation(request); const person = store.getPerson(legacyBackfill[1]); if (!person) return errorResponse(request, response, 404, "PERSON_NOT_FOUND", "Person not found", request.requestId);
      const op = database.createOperation("people.backfill", { requestId: request.requestId }); runOperation(op, async () => gmgnWatcher.backfillPerson(person)); return accepted(request, response, op);
    }
    const resolution = url.pathname.match(/^\/api\/(?:v1\/)?people\/([^/]+)\/(?:address-resolution|resolve)$/);
    if (resolution && request.method === "POST") {
      authorizeMutation(request); const person = store.getPerson(resolution[1]); if (!person) return errorResponse(request, response, 404, "PERSON_NOT_FOUND", "Person not found", request.requestId);
      const op = database.createOperation("address-resolution", { requestId: request.requestId });
      runOperation(op, async () => {
        const resolved = await resolvePerson(config, person); const candidates = [];
        if (resolved.solanaAddress && resolved.solanaAddress !== person.solanaAddress) candidates.push(await store.upsertAddressCandidate(person.id, { chain: "solana", address: resolved.solanaAddress, addressRole: "source_wallet", verificationState: "pending", source: "resolver", confidence: 0.6, evidence: resolved.evidence }));
        for (const candidate of resolved.candidates || []) candidates.push(await store.upsertAddressCandidate(person.id, { ...candidate, verificationState: "pending" }));
        return { candidates, evidence: resolved.evidence || [] };
      }); return accepted(request, response, op);
    }
    const personRoute = url.pathname.match(/^\/api\/(?:v1\/)?people\/([^/]+)$/);
    if (personRoute && request.method === "PATCH") {
      authorizeMutation(request); const current = store.getPerson(personRoute[1]); if (!current) return errorResponse(request, response, 404, "PERSON_NOT_FOUND", "Person not found", request.requestId);
      const input = await body(request); const updated = input.enabled != null ? await store.setPersonState(current.id, input.enabled ? "active" : "paused") : await store.upsertPerson({ ...current, ...input, id: current.id }); flushEvents(); return jsonResponse(request, response, 200, updated);
    }
    if (personRoute && request.method === "DELETE") {
      authorizeMutation(request); const removed = await store.removePerson(personRoute[1]); flushEvents(); return jsonResponse(request, response, removed ? 200 : 404, { removed });
    }

    const bindingsRoute = url.pathname.match(/^\/api\/v1\/people\/([^/]+)\/wallet-bindings$/);
    if (bindingsRoute && request.method === "GET") return jsonResponse(request, response, 200, { items: store.listBindings(bindingsRoute[1]) });
    if (bindingsRoute && request.method === "POST") { authorizeMutation(request); const result = await store.upsertBinding(bindingsRoute[1], await body(request)); flushEvents(); return jsonResponse(request, response, 201, result); }
    const bindingRoute = url.pathname.match(/^\/api\/v1\/people\/([^/]+)\/wallet-bindings\/([^/:]+)(?::(verify|reject))?$/);
    if (bindingRoute) {
      const [, personId, bindingId, action] = bindingRoute;
      if (request.method === "PATCH") { authorizeMutation(request); const result = await store.updateBinding(personId, bindingId, await body(request)); flushEvents(); return result ? jsonResponse(request, response, 200, result) : errorResponse(request, response, 404, "BINDING_NOT_FOUND", "Wallet binding not found", request.requestId); }
      if (request.method === "DELETE") { authorizeMutation(request); const removed = await store.removeBinding(personId, bindingId); flushEvents(); return jsonResponse(request, response, removed ? 200 : 404, { removed }); }
      if (request.method === "POST" && action) { authorizeMutation(request); const result = await store.updateBinding(personId, bindingId, { verificationState: action === "verify" ? "verified" : "rejected" }); flushEvents(); return result ? jsonResponse(request, response, 200, result) : errorResponse(request, response, 404, "BINDING_NOT_FOUND", "Wallet binding not found", request.requestId); }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/wallet-bindings") {
      const pagination = page(url); const items = database.listAllBindings(pagination);
      return jsonResponse(request, response, 200, { items, nextCursor: items.length === pagination.limit ? pagination.cursor + pagination.limit : null, asOfEventId: database.eventBounds().max });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/address-candidates") {
      const pagination = page(url); const items = database.listAddressCandidates(url.searchParams.get("personId") || null, { ...pagination, state: url.searchParams.get("state") || "" });
      return jsonResponse(request, response, 200, { items, nextCursor: items.length === pagination.limit ? pagination.cursor + pagination.limit : null, asOfEventId: database.eventBounds().max });
    }
    const candidateRoute = url.pathname.match(/^\/api\/v1\/people\/([^/]+)\/address-candidates\/([^/:]+):(verify|reject)$/);
    if (candidateRoute && request.method === "POST") {
      authorizeMutation(request); const [, personId, candidateId, action] = candidateRoute; const input = await body(request);
      const result = action === "verify" ? await store.verifyAddressCandidate(personId, candidateId, input) : await store.rejectAddressCandidate(personId, candidateId);
      flushEvents(); return result ? jsonResponse(request, response, 200, result) : errorResponse(request, response, 404, "CANDIDATE_NOT_FOUND", "Address candidate not found", request.requestId);
    }

    if (request.method === "GET" && ["/api/events", "/api/v1/trades"].includes(url.pathname)) {
      const view = url.pathname === "/api/events" ? (url.searchParams.get("scope") === "history" ? "history" : url.searchParams.get("scope") === "live" ? "live" : "live") : (url.searchParams.get("view") || "live");
      const pagination = page(url); const items = database.listTrades(view, { ...pagination, chain: url.searchParams.get("chain") || "" });
      if (url.pathname === "/api/events") return jsonResponse(request, response, 200, items);
      return jsonResponse(request, response, 200, { items, nextCursor: items.length === pagination.limit ? pagination.cursor + pagination.limit : null, asOfEventId: database.eventBounds().max });
    }
    const tradeRoute = url.pathname.match(/^\/api\/v1\/trades\/([^/]+)$/);
    if (tradeRoute && request.method === "GET") { const trade = database.getTrade(tradeRoute[1]); return trade ? jsonResponse(request, response, 200, trade) : errorResponse(request, response, 404, "TRADE_NOT_FOUND", "Trade not found", request.requestId); }

    if (request.method === "GET" && ["/api/reconciliation", "/api/v1/reconciliations"].includes(url.pathname)) {
      const items = database.listReconciliations(); return jsonResponse(request, response, 200, url.pathname.startsWith("/api/v1") ? { items } : { checkedAt: stamp(), targets: items });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/reconciliations") {
      authorizeMutation(request); const op = database.createOperation("reconciliation", { idempotencyKey: request.headers["idempotency-key"], requestId: request.requestId }); runOperation(op, reconcileNow); return accepted(request, response, op);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/operations") {
      const pagination = page(url); const items = database.listOperations(pagination);
      return jsonResponse(request, response, 200, { items, nextCursor: items.length === pagination.limit ? pagination.cursor + pagination.limit : null, asOfEventId: database.eventBounds().max });
    }
    const operationRoute = url.pathname.match(/^\/api\/v1\/operations\/([^/]+)$/);
    if (operationRoute && request.method === "GET") { const op = database.getOperation(operationRoute[1]); return op ? jsonResponse(request, response, 200, op) : errorResponse(request, response, 404, "OPERATION_NOT_FOUND", "Operation not found", request.requestId); }

    if (request.method === "GET" && url.pathname === "/api/v1/relay-evidence") {
      const pagination = page(url); const items = database.listRelayEvidence(pagination);
      return jsonResponse(request, response, 200, { items, nextCursor: items.length === pagination.limit ? pagination.cursor + pagination.limit : null, asOfEventId: database.eventBounds().max });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/fomo-web/status") {
      return jsonResponse(request, response, 200, { ...fomoBridgeStatus(), requestId: request.requestId });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/fomo-web/pair") {
      authorizeMutation(request);
      const paired = await fomoBridgeSecrets.pair();
      report("fomo_web", "waiting", { health: "waiting", transport: "authenticated-browser-bridge", configured: true, reason: "Waiting for the browser extension to forward an alert" });
      return jsonResponse(request, response, 201, { ...fomoBridgeStatus(), secret: paired.secret, requestId: request.requestId });
    }
    if (request.method === "DELETE" && url.pathname === "/api/v1/fomo-web/pair") {
      authorizeMutation(request);
      await fomoBridgeSecrets.revoke();
      report("fomo_web", "unconfigured", { health: "unconfigured", transport: "authenticated-browser-bridge", configured: false, reason: "Pairing has been revoked" });
      return jsonResponse(request, response, 200, { ...fomoBridgeStatus(), requestId: request.requestId });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/fomo-alerts") {
      const pagination = page(url);
      const items = database.listFomoAlerts({ ...pagination, matchState: url.searchParams.get("matchState") || "" });
      return jsonResponse(request, response, 200, { items, nextCursor: items.length === pagination.limit ? pagination.cursor + pagination.limit : null, summary: database.fomoBridgeSummary(), asOfEventId: database.eventBounds().max, requestId: request.requestId });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/ingest/fomo-alerts") {
      const origin = String(request.headers.origin || "");
      if (origin && !bridgeOriginAllowed(request)) return errorResponse(request, response, 403, "BRIDGE_ORIGIN_REJECTED", "Only the paired browser extension may use this endpoint", request.requestId);
      const raw = await rawBody(request, 1_500_000);
      const timestamp = String(request.headers["x-fomo-timestamp"] || "");
      const signature = String(request.headers["x-fomo-signature"] || "");
      if (!fomoBridgeSecrets.status().configured) return errorResponse(request, response, 403, "FOMO_BRIDGE_UNPAIRED", "FOMO Web bridge is not paired", request.requestId);
      if (!verifyBridgeSignature({ secret: fomoBridgeSecrets.getSecret(), timestamp, rawBody: raw, signature })) {
        return errorResponse(request, response, 401, "FOMO_BRIDGE_SIGNATURE_INVALID", "Bridge signature is invalid or expired", request.requestId);
      }
      let input;
      try { input = raw ? JSON.parse(raw) : {}; }
      catch { return errorResponse(request, response, 400, "INVALID_JSON", "Request body is not valid JSON", request.requestId); }
      if (input.kind === "status") {
        const state = ["connected", "reconnecting", "disconnected", "error"].includes(input.state) ? input.state : "connected";
        report("fomo_web", state, {
          health: state === "connected" ? "healthy" : state === "reconnecting" ? "reconnecting" : "degraded",
          transport: "authenticated-browser-bridge", configured: true, lastCheckedAt: stamp(),
          pageUrl: typeof input.pageUrl === "string" ? input.pageUrl.slice(0, 300) : undefined,
          errorCode: state === "error" ? "FOMO_BRIDGE_ERROR" : undefined,
          errorMessage: state === "error" && typeof input.message === "string" ? input.message.slice(0, 500) : undefined,
        });
        return jsonResponse(request, response, 200, { accepted: true, kind: "status", state, requestId: request.requestId });
      }
      const alerts = Array.isArray(input.alerts) ? input.alerts : input.alert ? [input.alert] : [];
      if (!alerts.length) return errorResponse(request, response, 400, "FOMO_ALERTS_REQUIRED", "At least one alert is required", request.requestId);
      if (alerts.length > 100) return errorResponse(request, response, 413, "FOMO_BATCH_TOO_LARGE", "A batch may contain at most 100 alerts", request.requestId);
      const counts = { received: alerts.length, inserted: 0, duplicate: 0, matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 };
      const receivedAt = stamp();
      for (const alertInput of alerts) {
        try {
          const normalized = normalizeFomoAlert(alertInput, receivedAt);
          const saved = database.insertFomoAlert(normalized);
          if (saved.inserted) counts.inserted += 1; else counts.duplicate += 1;
          if (saved.alert.matchState === "matched") counts.matched += 1;
          else if (saved.alert.matchState === "ambiguous") counts.ambiguous += 1;
          else counts.unmatched += 1;
        } catch { counts.invalid += 1; }
      }
      report("fomo_web", "connected", { health: "healthy", transport: "authenticated-browser-bridge", configured: true, lastCheckedAt: receivedAt, lastSuccessAt: receivedAt, lastTargetEventAt: counts.inserted ? receivedAt : undefined, lastBatchSize: alerts.length, lastBatchInserted: counts.inserted });
      flushEvents();
      return jsonResponse(request, response, 202, { accepted: true, ...counts, summary: database.fomoBridgeSummary(), requestId: request.requestId });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/notification-channels") return jsonResponse(request, response, 200, { items: notificationSecrets.list().map((item) => item.id === "telegram" ? { ...item, configured: item.configured || Boolean(config.telegramBotToken && config.telegramChatId) } : item.id === "webhook" ? { ...item, configured: item.configured || Boolean(config.webhookUrl) } : item) });
    const channelRoute = url.pathname.match(/^\/api\/v1\/notification-channels\/(telegram|webhook)$/);
    if (channelRoute && ["PUT", "PATCH", "DELETE"].includes(request.method || "")) {
      authorizeMutation(request); const id = channelRoute[1];
      if (request.method === "DELETE") {
        await notificationSecrets.remove(id);
        if (id === "telegram") { config.telegramBotToken = ""; config.telegramChatId = ""; } else config.webhookUrl = "";
        refreshNotificationRecipients();
        return jsonResponse(request, response, 200, { removed: true, id });
      }
      const input = await body(request); const saved = await notificationSecrets.set(id, input);
      if (id === "telegram") { config.telegramBotToken = input.botToken; config.telegramChatId = input.chatId; } else config.webhookUrl = input.url;
      refreshNotificationRecipients();
      return jsonResponse(request, response, 200, saved);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/notification-intents") return jsonResponse(request, response, 200, { items: database.listNotificationIntents({ channel: url.searchParams.get("channel") || "browser", status: url.searchParams.get("status") || "pending" }) });
    const intentAction = url.pathname.match(/^\/api\/v1\/notification-intents\/([^/:]+):(claim|ack)$/);
    if (intentAction && request.method === "POST") {
      authorizeMutation(request); const input = await body(request); const [, id, action] = intentAction;
      const result = action === "claim" ? database.claimNotification(id, input.owner || `browser:${request.headers["user-agent"] || "local"}`) : database.finishNotification(id, { status: input.status === "failed" ? "failed" : "delivered", error: input.error || null, owner: input.owner || null }); flushEvents();
      return result ? jsonResponse(request, response, 200, result) : errorResponse(request, response, 409, "INTENT_NOT_CLAIMABLE", "Notification intent is no longer claimable", request.requestId);
    }
    if (request.method === "POST" && ["/api/test-notification", "/api/v1/notifications:test"].includes(url.pathname)) {
      authorizeMutation(request); return jsonResponse(request, response, 200, { status: "ready", browser: true, telegram: Boolean(config.telegramBotToken && config.telegramChatId), webhook: Boolean(config.webhookUrl), sent: false, message: "配置检查完成；未向真实外部频道发送测试消息。" });
    }

    if (request.method === "GET" && ["/api/events/stream", "/api/v1/events/stream"].includes(url.pathname)) {
      if (!originAllowed(request)) return errorResponse(request, response, 403, "ORIGIN_REJECTED", "Origin is not allowed", request.requestId);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...(request.headers.origin ? { "access-control-allow-origin": request.headers.origin } : {}) });
      const requested = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0); const bounds = database.eventBounds();
      if (requested && requested < Number(bounds.min) - 1) sendEnvelope(response, { id: randomUUID(), sequence: Number(bounds.max), type: "reset.required", payloadVersion: "1.0", occurredAt: stamp(), entityId: null, data: { reason: "cursor_expired", asOfEventId: bounds.max } });
      else for (const envelope of database.eventsAfter(requested, 1000)) sendEnvelope(response, envelope);
      response.write(`event: ready\ndata: ${JSON.stringify({ type: "ready", asOfEventId: bounds.max })}\n\n`);
      sseClients.add(response); request.on("close", () => sseClients.delete(response)); return;
    }

    return errorResponse(request, response, 404, "NOT_FOUND", "Route not found", request.requestId);
  } catch (error) {
    return errorResponse(request, response, error.status || 500, error.code || "INTERNAL_ERROR", error.message, request.requestId, {}, Boolean(error.retryable));
  }
});

server.listen(config.port, "127.0.0.1", () => {
  runtimeStatus.readiness = "starting";
  database.appendEvent("health.updated", "service", { source: "service", state: "starting", storage: "sqlite" });
  if (!config.disableExternalCollectors) {
    report("collectors", "connected", { health: "healthy", reason: "external read-only collectors active" });
    watchers.start(); realtimeWatchers.start(); gmgnWatcher.start();
  }
  else report("collectors", "disabled", { health: "disabled", reason: "isolated validation mode" });
  report("fomo_web", fomoBridgeSecrets.status().configured ? "waiting" : "unconfigured", {
    health: fomoBridgeSecrets.status().configured ? "waiting" : "unconfigured",
    transport: "authenticated-browser-bridge", configured: fomoBridgeSecrets.status().configured,
    reason: fomoBridgeSecrets.status().configured ? "Waiting for the browser extension to forward an alert" : "Pair the browser extension to enable FOMO Web verification",
  });
  recomputeReadiness();
  flushEvents();
  console.log(`FOMO KOL Monitor API: http://127.0.0.1:${config.port}`);
});

const eventTimer = setInterval(flushEvents, 250); eventTimer.unref?.();
const heartbeatTimer = setInterval(() => { for (const client of sseClients) client.write(`: heartbeat ${Date.now()}\n\n`); }, 15_000); heartbeatTimer.unref?.();
const outboxTimer = setInterval(() => processOutbox().catch((error) => { runtimeStatus.error = error.message; }), 1000); outboxTimer.unref?.();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  watchers.stop(); realtimeWatchers.stop(); gmgnWatcher.stop();
  clearInterval(eventTimer); clearInterval(heartbeatTimer); clearInterval(outboxTimer);
  for (const client of sseClients) client.end();
  sseClients.clear();
  server.close(() => {
    store.close();
    releaseInstanceLock(lockHandle);
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 500).unref();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (error) => { console.error(error); shutdown(); });
