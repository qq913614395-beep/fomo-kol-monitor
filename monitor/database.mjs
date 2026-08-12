import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { decimal } from "./decimal.mjs";
import { normalizeEvm, normalizeHandle, normalizePerson, normalizeSolana } from "./core.mjs";

const SCHEMA_VERSION = 3;
const MONITORABLE_ADDRESS_ROLES = new Set(["vault", "smart_account", "source_wallet"]);
const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const MAX_INLINE_OBSERVATIONS = 50;

function compactObservation(item) {
  if (!item || typeof item !== "object") return null;
  const compact = {
    source: item.source || item.adapter || item.path || "unknown",
    observedAt: item.observedAt || item.firstObservedAt || item.receivedAt || null,
  };
  if (item.sourceIdentity) compact.sourceIdentity = item.sourceIdentity;
  if (item.finality) compact.finality = item.finality;
  return compact;
}

function mergeObservations(...groups) {
  const result = [];
  const seen = new Set();
  for (const item of groups.flat()) {
    const compact = compactObservation(item);
    if (!compact) continue;
    const identity = `${compact.source}:${compact.sourceIdentity || ""}:${compact.observedAt || ""}:${compact.finality || ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(compact);
  }
  return result.slice(-MAX_INLINE_OBSERVATIONS);
}

function withoutRecursiveObservations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value };
  delete result.observations;
  return result;
}

function materialPayload(value) {
  if (!value || typeof value !== "object") return value;
  const result = { ...value };
  for (const key of ["observations", "observedAt", "receivedAt", "runId", "sourceIdentity", "source"]) delete result[key];
  return result;
}

const schema = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY, handle TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
    twitter TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', desired_state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY, chain TEXT NOT NULL, chain_id TEXT NOT NULL, address TEXT NOT NULL,
    normalized_address TEXT NOT NULL, address_type TEXT NOT NULL DEFAULT 'UNKNOWN', created_at TEXT NOT NULL,
    UNIQUE(chain, normalized_address)
  )`,
  `CREATE TABLE IF NOT EXISTS person_wallets (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), wallet_id TEXT NOT NULL REFERENCES wallets(id),
    verification_state TEXT NOT NULL, desired_state TEXT NOT NULL, source TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1, evidence_json TEXT NOT NULL DEFAULT '[]', verified_at TEXT,
    address_role TEXT NOT NULL DEFAULT 'unknown', valid_from TEXT, valid_to TEXT, last_seen_at TEXT,
    generation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(person_id, wallet_id)
  )`,
  `CREATE TABLE IF NOT EXISTS address_candidates (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), chain TEXT NOT NULL DEFAULT 'unknown',
    chain_id TEXT, address TEXT NOT NULL, normalized_address TEXT NOT NULL, address_role TEXT NOT NULL DEFAULT 'unknown',
    verification_state TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5,
    evidence_json TEXT NOT NULL DEFAULT '[]', request_id TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    valid_from TEXT, valid_to TEXT, promoted_binding_id TEXT REFERENCES person_wallets(id), created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, UNIQUE(person_id, chain, normalized_address, address_role)
  )`,
  `CREATE TABLE IF NOT EXISTS monitor_targets (
    id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL UNIQUE REFERENCES wallets(id), desired_state TEXT NOT NULL,
    runtime_health TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS monitor_subscriptions (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), target_id TEXT NOT NULL REFERENCES monitor_targets(id),
    generation INTEGER NOT NULL, desired_state TEXT NOT NULL, notification_fence TEXT NOT NULL,
    active_from TEXT NOT NULL, active_to TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(person_id, target_id, generation)
  )`,
  `CREATE TABLE IF NOT EXISTS source_cursors (
    target_id TEXT NOT NULL, adapter TEXT NOT NULL, stream_kind TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT 'live',
    cursor_json TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(target_id, adapter, stream_kind, scope_id)
  )`,
  `CREATE TABLE IF NOT EXISTS source_runs (
    id TEXT PRIMARY KEY, adapter TEXT NOT NULL, target_id TEXT, stream_kind TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, result TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT, error_message TEXT, adapter_version TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS source_records (
    id TEXT PRIMARY KEY, source_identity TEXT NOT NULL UNIQUE, target_id TEXT, person_id TEXT,
    adapter TEXT NOT NULL, kind TEXT NOT NULL, chain TEXT NOT NULL, wallet TEXT,
    tx_identity TEXT, occurred_at TEXT, first_observed_at TEXT NOT NULL, validity TEXT NOT NULL,
    origin TEXT NOT NULL, raw_ref TEXT, raw_hash TEXT, payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_sightings (
    id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL REFERENCES source_records(id), run_id TEXT,
    path TEXT NOT NULL, observed_at TEXT NOT NULL, payload_hash TEXT,
    UNIQUE(source_record_id, path, observed_at)
  )`,
  `CREATE TABLE IF NOT EXISTS normalization_jobs (
    id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL REFERENCES source_records(id), status TEXT NOT NULL,
    rule_version TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
    error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_record_id, rule_version)
  )`,
  `CREATE TABLE IF NOT EXISTS canonical_trades (
    id TEXT PRIMARY KEY, stable_source_group_key TEXT NOT NULL UNIQUE, key_aliases_json TEXT NOT NULL DEFAULT '[]',
    confirmation_state TEXT NOT NULL, origin TEXT NOT NULL, finality TEXT NOT NULL,
    chain TEXT NOT NULL, wallet TEXT, tx_identity TEXT NOT NULL, side TEXT,
    token_address TEXT, token_symbol TEXT, token_amount TEXT, quote_token_address TEXT,
    quote_amount TEXT, value_usd TEXT, leg_count INTEGER NOT NULL DEFAULT 0, route_leg_count INTEGER NOT NULL DEFAULT 0,
    source_occurred_at TEXT, first_observed_at TEXT NOT NULL, confirmed_at TEXT, finalized_at TEXT,
    late_detected INTEGER NOT NULL DEFAULT 0, normalization_version TEXT NOT NULL,
    payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trade_observations (
    trade_id TEXT NOT NULL REFERENCES canonical_trades(id), source_record_id TEXT NOT NULL REFERENCES source_records(id),
    PRIMARY KEY(trade_id, source_record_id)
  )`,
  `CREATE TABLE IF NOT EXISTS trade_legs (
    id TEXT PRIMARY KEY, trade_id TEXT NOT NULL REFERENCES canonical_trades(id), leg_index INTEGER NOT NULL,
    token_address TEXT, amount TEXT, quote_address TEXT, quote_amount TEXT, route_order INTEGER,
    payload_json TEXT NOT NULL, UNIQUE(trade_id, leg_index)
  )`,
  `CREATE TABLE IF NOT EXISTS event_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
    entity_id TEXT, payload_version TEXT NOT NULL, occurred_at TEXT NOT NULL, data_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notification_outbox (
    id TEXT PRIMARY KEY, trade_id TEXT NOT NULL REFERENCES canonical_trades(id), channel TEXT NOT NULL,
    recipient TEXT NOT NULL, correction_kind TEXT NOT NULL DEFAULT 'trade', status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT, external_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(trade_id, channel, recipient, correction_kind)
  )`,
  `CREATE TABLE IF NOT EXISTS notification_attempts (
    id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES notification_outbox(id), attempt INTEGER NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, result TEXT NOT NULL, response_code TEXT,
    external_id TEXT, error_message TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id TEXT PRIMARY KEY, target_id TEXT, person_id TEXT, chain TEXT NOT NULL, wallet TEXT NOT NULL,
    window_start TEXT NOT NULL, window_end TEXT NOT NULL, status TEXT NOT NULL,
    source_complete INTEGER NOT NULL, source_count INTEGER NOT NULL, local_count INTEGER NOT NULL,
    matched INTEGER NOT NULL, missing INTEGER NOT NULL, extra INTEGER NOT NULL, mismatched INTEGER NOT NULL,
    adapter_version TEXT, normalization_version TEXT NOT NULL, tolerance_json TEXT NOT NULL,
    created_at TEXT NOT NULL, completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS reconciliation_items (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES reconciliation_runs(id), item_kind TEXT NOT NULL,
    reconciliation_key TEXT NOT NULL, differences_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS repair_jobs (
    id TEXT PRIMARY KEY, target_id TEXT, reconciliation_run_id TEXT NOT NULL REFERENCES reconciliation_runs(id),
    reconciliation_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    reason_json TEXT NOT NULL, next_retry_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(reconciliation_run_id, reconciliation_key)
  )`,
  `CREATE TABLE IF NOT EXISTS chain_verification_jobs (
    id TEXT PRIMARY KEY, trade_id TEXT NOT NULL UNIQUE REFERENCES canonical_trades(id), target_id TEXT,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
    verified_source_record_id TEXT REFERENCES source_records(id), error_code TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_health (
    source_key TEXT PRIMARY KEY, target_id TEXT, state TEXT NOT NULL, last_attempt_at TEXT,
    last_success_at TEXT, last_target_event_at TEXT, head_position TEXT, processed_position TEXT,
    block_lag INTEGER, effective_poll_interval_ms INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0,
    error_code TEXT, error_message TEXT, next_retry_at TEXT, details_json TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fomo_alerts (
    id TEXT PRIMARY KEY, event_identity TEXT NOT NULL UNIQUE, fomo_event_id TEXT,
    event_type TEXT NOT NULL, chain TEXT NOT NULL, network_id TEXT, trader_id TEXT, trader_handle TEXT,
    token_address TEXT, token_symbol TEXT, side TEXT, value_usd TEXT, tx_identity TEXT,
    occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, is_trade_like INTEGER NOT NULL DEFAULT 0,
    match_state TEXT NOT NULL DEFAULT 'unmatched', matched_trade_id TEXT REFERENCES canonical_trades(id),
    payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
    request_id TEXT, idempotency_key TEXT UNIQUE, result_json TEXT, error_code TEXT, error_message TEXT,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_person_wallets_person ON person_wallets(person_id, verification_state, desired_state)`,
  `CREATE INDEX IF NOT EXISTS idx_source_records_target_time ON source_records(target_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_trades_view ON canonical_trades(confirmation_state, origin, source_occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_event_log_type_sequence ON event_log(type, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notification_outbox(status, next_retry_at) WHERE status IN ('pending','retry_wait','delivering')`,
  `CREATE INDEX IF NOT EXISTS idx_reconciliation_target_time ON reconciliation_runs(target_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_repair_jobs_pending ON repair_jobs(status, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS idx_fomo_alerts_time ON fomo_alerts(occurred_at, match_state)`,
  `CREATE INDEX IF NOT EXISTS idx_fomo_alerts_match ON fomo_alerts(matched_trade_id) WHERE matched_trade_id IS NOT NULL`
];

function chainMeta(chain) {
  return ({ solana: ["792703809", "SOLANA"], bsc: ["56", "EOA"], base: ["8453", "ERC4337"], ethereum: ["1", "EOA"] })[chain];
}

function defaultAddressRole(chain, addressType = "") {
  if (chain === "solana") return "source_wallet";
  return String(addressType).toUpperCase() === "ERC4337" ? "smart_account" : "vault";
}

function isMonitorableBinding(binding, at = now()) {
  return binding.verificationState === "verified" && binding.desiredState === "enabled" &&
    MONITORABLE_ADDRESS_ROLES.has(binding.addressRole) && (!binding.validTo || binding.validTo > at);
}

export class MonitorDatabase {
  constructor(file) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.notificationRecipients = [];
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    for (const statement of schema) this.db.exec(statement);
    this.migrateSchema();
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_person_wallets_monitorable ON person_wallets(person_id,address_role,verification_state,desired_state,valid_to)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_address_candidates_person ON address_candidates(person_id,verification_state,last_seen_at)");
    this.db.prepare("INSERT INTO schema_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
    this.db.exec("PRAGMA optimize");
  }

  migrateSchema() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(person_wallets)").all().map((row) => row.name));
    const additions = [
      ["address_role", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["valid_from", "TEXT"],
      ["valid_to", "TEXT"],
      ["last_seen_at", "TEXT"],
      ["generation", "INTEGER NOT NULL DEFAULT 1"],
    ];
    for (const [name, definition] of additions) if (!columns.has(name)) this.db.exec(`ALTER TABLE person_wallets ADD COLUMN ${name} ${definition}`);
    this.db.exec(`UPDATE person_wallets SET address_role=CASE
      WHEN address_role IS NULL OR address_role='unknown' THEN CASE
        WHEN wallet_id IN (SELECT id FROM wallets WHERE chain='solana') THEN 'source_wallet'
        WHEN wallet_id IN (SELECT id FROM wallets WHERE address_type='ERC4337') THEN 'smart_account'
        ELSE 'vault' END ELSE address_role END,
      last_seen_at=COALESCE(last_seen_at,updated_at,created_at)`);
  }

  transaction(task) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = task();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.db.close(); }
  integrityCheck() { return this.db.prepare("PRAGMA quick_check").get().quick_check; }
  scalar(sql, ...params) { return Object.values(this.db.prepare(sql).get(...params) || {})[0]; }

  isEmpty() { return Number(this.scalar("SELECT COUNT(*) FROM people") || 0) === 0; }

  importLegacyState(file) {
    if (!file || !this.isEmpty()) return { imported: false };
    let state;
    try { state = JSON.parse(readFileSync(file, "utf8")); } catch { return { imported: false }; }
    return this.transaction(() => {
      for (const person of state.people || []) this.upsertPerson(person, { inTransaction: true, legacyImport: true });
      for (const event of [...(state.events || [])].reverse()) {
        this.recordEvent({ ...event, historical: true, legacy: true, origin: "legacy", notificationEligible: false }, { inTransaction: true });
      }
      this.db.prepare("INSERT INTO schema_meta(key,value) VALUES('legacy_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(json({ file: path.resolve(file), sha256: hash(readFileSync(file)), importedAt: now(), people: state.people?.length || 0, events: state.events?.length || 0 }));
      return { imported: true, people: state.people?.length || 0, events: state.events?.length || 0 };
    });
  }

  upsertPerson(input, options = {}) {
    const existing = input.id ? this.getPerson(input.id) : this.db.prepare("SELECT id FROM people WHERE handle=? COLLATE NOCASE AND removed_at IS NULL").get(normalizeHandle(input.handle));
    const normalized = normalizePerson(input, existing || {});
    const stamp = now();
    const action = () => {
      this.db.prepare(`INSERT INTO people(id,handle,name,twitter,notes,desired_state,created_at,updated_at,removed_at)
        VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET handle=excluded.handle,name=excluded.name,
        twitter=excluded.twitter,notes=excluded.notes,desired_state=excluded.desired_state,updated_at=excluded.updated_at,removed_at=NULL`)
        .run(normalized.id, normalized.handle, normalized.name, normalized.twitter, String(input.notes || ""), normalized.enabled ? "active" : "paused", normalized.createdAt || stamp, stamp);
      if (normalized.solanaAddress) this.upsertBinding(normalized.id, { chain: "solana", address: normalized.solanaAddress, addressRole: "source_wallet", verificationState: "verified", source: options.legacyImport ? "legacy-import" : "manual" }, { inTransaction: true });
      const explicitEvm = normalizeEvm(input.evmAddress ?? input.evm ?? "");
      if (explicitEvm && input.evmChain && chainMeta(input.evmChain)) {
        this.upsertBinding(normalized.id, { chain: input.evmChain, address: explicitEvm, addressRole: input.addressRole || "vault", verificationState: input.verificationState || "verified", source: options.legacyImport ? "legacy-import" : "manual" }, { inTransaction: true });
      } else if (explicitEvm) {
        this.upsertAddressCandidate(normalized.id, { chain: "unknown", address: explicitEvm, addressRole: "unknown", verificationState: "pending", source: options.legacyImport ? "legacy-import" : "manual-seed", confidence: options.legacyImport ? 0.35 : 0.5, evidence: [{ type: "unscoped-evm-seed", note: "Chain and execution role require verification" }] }, { inTransaction: true });
      }
      for (const [chain, address] of Object.entries(input.evmAddresses || {})) if (chainMeta(chain) && normalizeEvm(address)) {
        this.upsertBinding(normalized.id, { chain, address, addressRole: "vault", verificationState: "verified", source: options.legacyImport ? "legacy-import" : "manual" }, { inTransaction: true });
      }
      this.appendEvent("person.updated", normalized.id, this.getPerson(normalized.id));
      return this.getPerson(normalized.id);
    };
    return options.inTransaction ? action() : this.transaction(action);
  }

  listPeople() {
    return this.db.prepare("SELECT * FROM people WHERE removed_at IS NULL ORDER BY created_at").all().map((row) => this.inflatePerson(row));
  }

  getPerson(id) {
    const row = this.db.prepare("SELECT * FROM people WHERE id=? AND removed_at IS NULL").get(id);
    return row ? this.inflatePerson(row) : null;
  }

  inflatePerson(row) {
    const bindings = this.listBindings(row.id);
    const active = bindings.filter((item) => isMonitorableBinding(item));
    const healths = active.map((item) => item.runtimeHealth).filter(Boolean);
    const monitorState = row.desired_state === "paused" ? "paused" : !active.length ? "unresolved" : healths.some((item) => ["degraded", "down"].includes(item)) ? "degraded" : "active";
    return {
      id: row.id, handle: row.handle, name: row.name, twitter: row.twitter, notes: row.notes,
      enabled: row.desired_state === "active", desiredState: row.desired_state,
      resolutionState: active.length ? bindings.some((item) => item.verificationState === "pending") ? "partial" : "resolved" : "unresolved",
      runtimeHealth: healths.includes("down") ? "down" : healths.includes("degraded") ? "degraded" : active.length ? "healthy" : "unknown",
      monitorState, solanaAddress: active.find((item) => item.chain === "solana")?.address || "",
      evmAddress: active.find((item) => item.chain !== "solana")?.address || "",
      bindings, addressCandidates: this.listAddressCandidates(row.id), createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  removePerson(id) {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE people SET desired_state='removed',removed_at=?,updated_at=? WHERE id=? AND removed_at IS NULL").run(now(), now(), id);
      this.db.prepare("UPDATE monitor_subscriptions SET desired_state='removed',active_to=?,updated_at=? WHERE person_id=? AND active_to IS NULL").run(now(), now(), id);
      if (result.changes) this.appendEvent("person.updated", id, { id, desiredState: "removed" });
      return Boolean(result.changes);
    });
  }

  setPersonState(id, desiredState) {
    return this.transaction(() => {
      const person = this.getPerson(id);
      if (!person) return null;
      const stamp = now();
      this.db.prepare("UPDATE people SET desired_state=?,updated_at=? WHERE id=?").run(desiredState, stamp, id);
      const subscriptions = this.db.prepare("SELECT * FROM monitor_subscriptions WHERE person_id=? AND active_to IS NULL").all(id);
      if (desiredState === "paused") {
        this.db.prepare("UPDATE monitor_subscriptions SET desired_state='paused',active_to=?,updated_at=? WHERE person_id=? AND active_to IS NULL").run(stamp, stamp, id);
      } else {
        for (const binding of this.listBindings(id).filter((item) => isMonitorableBinding(item, stamp))) this.ensureSubscription(id, binding.targetId, stamp);
      }
      const updated = this.getPerson(id);
      this.appendEvent("person.updated", id, updated);
      return { ...updated, previousSubscriptions: subscriptions.length };
    });
  }

  listBindings(personId) {
    return this.db.prepare(`SELECT pw.*,w.chain,w.chain_id,w.address,w.normalized_address,w.address_type,
      mt.id AS target_id,mt.runtime_health FROM person_wallets pw JOIN wallets w ON w.id=pw.wallet_id
      LEFT JOIN monitor_targets mt ON mt.wallet_id=w.id WHERE pw.person_id=? ORDER BY w.chain,w.created_at`).all(personId).map((row) => ({
      id: row.id, personId: row.person_id, walletId: row.wallet_id, targetId: row.target_id,
      chain: row.chain, chainId: row.chain_id, address: row.address, normalizedAddress: row.normalized_address,
      addressType: row.address_type, source: row.source, confidence: row.confidence,
      evidence: parse(row.evidence_json, []), verificationState: row.verification_state,
      desiredState: row.desired_state, verifiedAt: row.verified_at, runtimeHealth: row.runtime_health,
      addressRole: row.address_role || defaultAddressRole(row.chain, row.address_type), validFrom: row.valid_from,
      validTo: row.valid_to, lastSeenAt: row.last_seen_at, generation: Number(row.generation || 1),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  listAllBindings({ limit = 100, cursor = 0 } = {}) {
    const rows = this.db.prepare(`SELECT pw.*,w.chain,w.chain_id,w.address,w.normalized_address,w.address_type,
      mt.id AS target_id,mt.runtime_health FROM person_wallets pw JOIN people p ON p.id=pw.person_id
      JOIN wallets w ON w.id=pw.wallet_id LEFT JOIN monitor_targets mt ON mt.wallet_id=w.id
      WHERE p.removed_at IS NULL ORDER BY pw.created_at LIMIT ? OFFSET ?`).all(limit, cursor);
    return rows.map((row) => ({
      id: row.id, personId: row.person_id, walletId: row.wallet_id, targetId: row.target_id,
      chain: row.chain, chainId: row.chain_id, address: row.address, normalizedAddress: row.normalized_address,
      addressType: row.address_type, source: row.source, confidence: row.confidence,
      evidence: parse(row.evidence_json, []), verificationState: row.verification_state,
      desiredState: row.desired_state, verifiedAt: row.verified_at, runtimeHealth: row.runtime_health,
      addressRole: row.address_role || defaultAddressRole(row.chain, row.address_type), validFrom: row.valid_from,
      validTo: row.valid_to, lastSeenAt: row.last_seen_at, generation: Number(row.generation || 1),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  listAddressCandidates(personId = null, { limit = 200, cursor = 0, state = "" } = {}) {
    const clauses = [];
    const params = [];
    if (personId) { clauses.push("person_id=?"); params.push(personId); }
    if (state) { clauses.push("verification_state=?"); params.push(state); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM address_candidates ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`).all(...params, limit, cursor).map((row) => ({
      id: row.id, personId: row.person_id, chain: row.chain, chainId: row.chain_id, address: row.address,
      normalizedAddress: row.normalized_address, addressRole: row.address_role, verificationState: row.verification_state,
      source: row.source, confidence: row.confidence, evidence: parse(row.evidence_json, []), requestId: row.request_id,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, validFrom: row.valid_from, validTo: row.valid_to,
      promotedBindingId: row.promoted_binding_id, createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  upsertAddressCandidate(personId, input, options = {}) {
    const action = () => {
      const chain = chainMeta(input.chain) ? input.chain : "unknown";
      const normalized = normalizeEvm(input.address) || normalizeSolana(input.address);
      if (!normalized) throw Object.assign(new Error("Invalid candidate address"), { code: "INVALID_ADDRESS", status: 400 });
      const role = input.addressRole || "unknown";
      const stamp = now();
      const existing = this.db.prepare("SELECT * FROM address_candidates WHERE person_id=? AND chain=? AND normalized_address=? AND address_role=?").get(personId, chain, normalized, role);
      const id = existing?.id || input.id || randomUUID();
      const evidence = [...parse(existing?.evidence_json, []), ...(input.evidence || [])];
      const uniqueEvidence = [...new Map(evidence.map((item) => [hash(json(item)), item])).values()].slice(-50);
      this.db.prepare(`INSERT INTO address_candidates(id,person_id,chain,chain_id,address,normalized_address,address_role,verification_state,source,confidence,evidence_json,request_id,first_seen_at,last_seen_at,valid_from,valid_to,promoted_binding_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(person_id,chain,normalized_address,address_role) DO UPDATE SET
        verification_state=CASE WHEN address_candidates.verification_state IN ('verified','rejected') THEN address_candidates.verification_state ELSE excluded.verification_state END,
        source=excluded.source,confidence=MAX(address_candidates.confidence,excluded.confidence),evidence_json=excluded.evidence_json,
        request_id=COALESCE(excluded.request_id,address_candidates.request_id),last_seen_at=excluded.last_seen_at,
        valid_from=COALESCE(address_candidates.valid_from,excluded.valid_from),valid_to=excluded.valid_to,updated_at=excluded.updated_at`)
        .run(id, personId, chain, chainMeta(chain)?.[0] || null, input.address, normalized, role, input.verificationState || "pending", input.source || "resolver", Number(input.confidence ?? 0.5), json(uniqueEvidence), input.requestId || null, existing?.first_seen_at || input.firstSeenAt || stamp, input.lastSeenAt || stamp, input.validFrom || stamp, input.validTo || null, existing?.promoted_binding_id || null, existing?.created_at || stamp, stamp);
      const candidate = this.listAddressCandidates(personId).find((item) => item.id === id);
      this.appendEvent("address.candidate.updated", id, candidate);
      return candidate;
    };
    return options.inTransaction ? action() : this.transaction(action);
  }

  verifyAddressCandidate(personId, candidateId, patch = {}) {
    return this.transaction(() => {
      const candidate = this.listAddressCandidates(personId).find((item) => item.id === candidateId);
      if (!candidate) return null;
      const chain = patch.chain || candidate.chain;
      const addressRole = patch.addressRole || candidate.addressRole;
      if (!chainMeta(chain)) throw Object.assign(new Error("Candidate must have a supported destination chain before verification"), { code: "CANDIDATE_CHAIN_REQUIRED", status: 400 });
      if (!MONITORABLE_ADDRESS_ROLES.has(addressRole)) throw Object.assign(new Error("Only a vault, smart account, or source wallet can become a monitor target"), { code: "CANDIDATE_ROLE_REQUIRED", status: 400 });
      const binding = this.upsertBinding(personId, {
        chain, address: candidate.address, addressRole, addressType: addressRole === "smart_account" ? "ERC4337" : undefined,
        verificationState: "verified", desiredState: "enabled", source: candidate.source,
        confidence: candidate.confidence, evidence: candidate.evidence, validFrom: candidate.validFrom,
        validTo: candidate.validTo, lastSeenAt: candidate.lastSeenAt,
      }, { inTransaction: true });
      const stamp = now();
      this.db.prepare("UPDATE address_candidates SET chain=?,chain_id=?,address_role=?,verification_state='verified',promoted_binding_id=?,updated_at=? WHERE id=? AND person_id=?")
        .run(chain, chainMeta(chain)[0], addressRole, binding.id, stamp, candidateId, personId);
      const updated = this.listAddressCandidates(personId).find((item) => item.id === candidateId);
      this.appendEvent("address.candidate.updated", candidateId, updated);
      return { candidate: updated, binding };
    });
  }

  rejectAddressCandidate(personId, candidateId) {
    return this.transaction(() => {
      const stamp = now();
      const result = this.db.prepare("UPDATE address_candidates SET verification_state='rejected',updated_at=? WHERE id=? AND person_id=?").run(stamp, candidateId, personId);
      if (!result.changes) return null;
      const updated = this.listAddressCandidates(personId).find((item) => item.id === candidateId);
      this.appendEvent("address.candidate.updated", candidateId, updated);
      return updated;
    });
  }

  upsertBinding(personId, input, options = {}) {
    const action = () => {
      const meta = chainMeta(input.chain);
      if (!meta) throw Object.assign(new Error("Unsupported chain"), { code: "UNSUPPORTED_CHAIN" });
      const normalized = input.chain === "solana" ? normalizeSolana(input.address) : normalizeEvm(input.address);
      if (!normalized) throw Object.assign(new Error("Invalid wallet address"), { code: "INVALID_ADDRESS" });
      const stamp = now();
      let wallet = this.db.prepare("SELECT * FROM wallets WHERE chain=? AND normalized_address=?").get(input.chain, normalized);
      if (!wallet) {
        wallet = { id: randomUUID() };
        this.db.prepare("INSERT INTO wallets(id,chain,chain_id,address,normalized_address,address_type,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(wallet.id, input.chain, meta[0], input.address, normalized, input.addressType || meta[1], stamp);
      }
      const targetId = `target_${hash(`${input.chain}:${normalized}`).slice(0, 24)}`;
      this.db.prepare(`INSERT INTO monitor_targets(id,wallet_id,desired_state,runtime_health,created_at,updated_at)
        VALUES(?,?,'enabled','starting',?,?) ON CONFLICT(wallet_id) DO UPDATE SET updated_at=excluded.updated_at`).run(targetId, wallet.id, stamp, stamp);
      const existing = this.db.prepare("SELECT id FROM person_wallets WHERE person_id=? AND wallet_id=?").get(personId, wallet.id);
      const id = existing?.id || randomUUID();
      const verification = input.verificationState || "pending";
      const addressRole = input.addressRole || defaultAddressRole(input.chain, input.addressType || meta[1]);
      this.db.prepare(`INSERT INTO person_wallets(id,person_id,wallet_id,verification_state,desired_state,source,confidence,evidence_json,verified_at,address_role,valid_from,valid_to,last_seen_at,generation,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(person_id,wallet_id) DO UPDATE SET verification_state=excluded.verification_state,
        desired_state=excluded.desired_state,source=excluded.source,confidence=excluded.confidence,evidence_json=excluded.evidence_json,
        verified_at=excluded.verified_at,address_role=excluded.address_role,valid_from=COALESCE(excluded.valid_from,person_wallets.valid_from),
        valid_to=excluded.valid_to,last_seen_at=excluded.last_seen_at,generation=CASE WHEN person_wallets.address_role!=excluded.address_role OR COALESCE(person_wallets.valid_to,'')!=COALESCE(excluded.valid_to,'') THEN person_wallets.generation+1 ELSE person_wallets.generation END,updated_at=excluded.updated_at`)
        .run(id, personId, wallet.id, verification, input.desiredState || "enabled", input.source || "manual", Number(input.confidence ?? (verification === "verified" ? 1 : 0.5)), json(input.evidence || []), verification === "verified" ? stamp : null, addressRole, input.validFrom || stamp, input.validTo || null, input.lastSeenAt || stamp, Number(input.generation || 1), stamp, stamp);
      const person = this.db.prepare("SELECT desired_state FROM people WHERE id=?").get(personId);
      const eligible = verification === "verified" && (input.desiredState || "enabled") === "enabled" && MONITORABLE_ADDRESS_ROLES.has(addressRole) && (!input.validTo || input.validTo > stamp);
      if (eligible && person?.desired_state === "active") this.ensureSubscription(personId, targetId, stamp);
      else this.db.prepare("UPDATE monitor_subscriptions SET desired_state='paused',active_to=?,updated_at=? WHERE person_id=? AND target_id=? AND active_to IS NULL").run(stamp, stamp, personId, targetId);
      this.appendEvent("target.updated", targetId, { personId, targetId, chain: input.chain, wallet: input.address, addressRole, verificationState: verification });
      return this.listBindings(personId).find((item) => item.id === id);
    };
    return options.inTransaction ? action() : this.transaction(action);
  }

  updateBinding(personId, bindingId, patch) {
    return this.transaction(() => {
      const current = this.listBindings(personId).find((item) => item.id === bindingId);
      if (!current) return null;
      const verification = patch.verificationState || current.verificationState;
      const desired = patch.desiredState || current.desiredState;
      const addressRole = patch.addressRole || current.addressRole;
      const validFrom = patch.validFrom === undefined ? current.validFrom : patch.validFrom;
      const validTo = patch.validTo === undefined ? current.validTo : patch.validTo;
      const stamp = now();
      const generation = current.generation + (addressRole !== current.addressRole || validTo !== current.validTo ? 1 : 0);
      this.db.prepare("UPDATE person_wallets SET verification_state=?,desired_state=?,verified_at=?,address_role=?,valid_from=?,valid_to=?,last_seen_at=?,generation=?,updated_at=? WHERE id=? AND person_id=?")
        .run(verification, desired, verification === "verified" ? current.verifiedAt || stamp : null, addressRole, validFrom, validTo, patch.lastSeenAt || current.lastSeenAt || stamp, generation, stamp, bindingId, personId);
      if (verification === "verified" && desired === "enabled" && MONITORABLE_ADDRESS_ROLES.has(addressRole) && (!validTo || validTo > stamp) && this.getPerson(personId)?.desiredState === "active") this.ensureSubscription(personId, current.targetId, stamp);
      else this.db.prepare("UPDATE monitor_subscriptions SET desired_state='paused',active_to=?,updated_at=? WHERE person_id=? AND target_id=? AND active_to IS NULL").run(stamp, stamp, personId, current.targetId);
      const updated = this.listBindings(personId).find((item) => item.id === bindingId);
      this.appendEvent("target.updated", current.targetId, updated);
      return updated;
    });
  }

  removeBinding(personId, bindingId) {
    return this.transaction(() => {
      const current = this.listBindings(personId).find((item) => item.id === bindingId);
      if (!current) return false;
      const stamp = now();
      this.db.prepare("UPDATE monitor_subscriptions SET desired_state='removed',active_to=?,updated_at=? WHERE person_id=? AND target_id=? AND active_to IS NULL").run(stamp, stamp, personId, current.targetId);
      const result = this.db.prepare("DELETE FROM person_wallets WHERE id=? AND person_id=?").run(bindingId, personId);
      this.appendEvent("target.updated", current.targetId, { removed: true, personId, bindingId });
      return Boolean(result.changes);
    });
  }

  ensureSubscription(personId, targetId, fence = now()) {
    const active = this.db.prepare("SELECT * FROM monitor_subscriptions WHERE person_id=? AND target_id=? AND active_to IS NULL").get(personId, targetId);
    if (active) {
      this.db.prepare("UPDATE monitor_subscriptions SET desired_state='active',updated_at=? WHERE id=?").run(now(), active.id);
      return active.id;
    }
    const generation = Number(this.scalar("SELECT COALESCE(MAX(generation),0)+1 FROM monitor_subscriptions WHERE person_id=? AND target_id=?", personId, targetId));
    const id = randomUUID();
    this.db.prepare("INSERT INTO monitor_subscriptions(id,person_id,target_id,generation,desired_state,notification_fence,active_from,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, personId, targetId, generation, "active", fence, fence, now(), now());
    return id;
  }

  activeTargets() {
    return this.db.prepare(`SELECT DISTINCT mt.id AS target_id,w.id AS wallet_id,w.chain,w.chain_id,w.address,w.normalized_address,w.address_type
      FROM monitor_targets mt JOIN wallets w ON w.id=mt.wallet_id JOIN monitor_subscriptions ms ON ms.target_id=mt.id
      WHERE ms.desired_state='active' AND ms.active_to IS NULL
      AND EXISTS (SELECT 1 FROM person_wallets pwe WHERE pwe.person_id=ms.person_id AND pwe.wallet_id=w.id
        AND pwe.verification_state='verified' AND pwe.desired_state='enabled'
        AND pwe.address_role IN ('vault','smart_account','source_wallet') AND (pwe.valid_to IS NULL OR pwe.valid_to>?))`).all(now()).map((row) => ({
      id: row.target_id, walletId: row.wallet_id, chain: row.chain, chainId: row.chain_id,
      address: row.address, normalizedAddress: row.normalized_address, addressType: row.address_type,
      people: this.db.prepare("SELECT p.* FROM monitor_subscriptions ms JOIN people p ON p.id=ms.person_id WHERE ms.target_id=? AND ms.desired_state='active' AND ms.active_to IS NULL").all(row.target_id).map((p) => this.inflatePerson(p)),
    }));
  }

  sourceIdentity(event) {
    const chain = event.chain || "unknown";
    const tx = event.signature || event.txHash || event.userOperationHash || event.key || hash(json(event));
    const adapter = event.source || "unknown";
    const wallet = event.wallet || event.maker || event.sender || "";
    return event.sourceIdentity || `${adapter}:${chain}:${wallet}:${tx}:${event.logIndex ?? ""}`;
  }

  recordEvent(event, options = {}) {
    const action = () => {
      const observedAt = event.observedAt || event.receivedAt || now();
      const sourceIdentity = this.sourceIdentity(event);
      let source = this.db.prepare("SELECT * FROM source_records WHERE source_identity=?").get(sourceIdentity);
      const sourcePayload = withoutRecursiveObservations(event);
      const payloadHash = hash(json(sourcePayload));
      if (!source) {
        const id = event.sourceRecordId || randomUUID();
        this.db.prepare(`INSERT INTO source_records(id,source_identity,target_id,person_id,adapter,kind,chain,wallet,tx_identity,occurred_at,first_observed_at,validity,origin,raw_ref,raw_hash,payload_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, sourceIdentity, event.targetId || null, event.personId || null, event.source || "unknown", event.kind || "activity", event.chain || "unknown", event.wallet || event.maker || event.sender || null, event.signature || event.txHash || event.userOperationHash || null, event.timestamp || null, observedAt, event.validity || "observed", event.origin || (event.historical ? "legacy" : "live"), event.rawRef || null, event.rawHash || payloadHash, json(sourcePayload));
        source = this.db.prepare("SELECT * FROM source_records WHERE id=?").get(id);
      }
      this.db.prepare("INSERT OR IGNORE INTO source_sightings(id,source_record_id,run_id,path,observed_at,payload_hash) VALUES(?,?,?,?,?,?)")
        .run(randomUUID(), source.id, event.runId || null, event.source || "unknown", observedAt, payloadHash);
      this.db.prepare("INSERT OR IGNORE INTO normalization_jobs(id,source_record_id,status,rule_version,created_at,updated_at) VALUES(?,?,'succeeded','1.0',?,?)")
        .run(randomUUID(), source.id, observedAt, observedAt);
      if (event.kind !== "trade") {
        const txIdentity = event.signature || event.txHash || event.userOperationHash || null;
        if (txIdentity) this.db.prepare(`UPDATE chain_verification_jobs SET status='verified',verified_source_record_id=?,updated_at=?
          WHERE trade_id IN (SELECT id FROM canonical_trades WHERE chain=? AND tx_identity=?)`).run(source.id, observedAt, event.chain || "unknown", txIdentity);
        this.appendEvent("trade.pending", source.id, { ...event, id: source.id, confirmationState: "pending", origin: event.origin || "live", finality: event.finality || "observed" });
        return { record: { ...event, id: source.id }, isNew: !event.existing, isUpdated: false };
      }
      const walletIdentity = String(event.wallet || event.maker || event.sender || "");
      const normalizedWallet = event.chain === "solana" ? walletIdentity : walletIdentity.toLowerCase();
      const txIdentity = String(event.txHash || event.signature || event.userOperationHash || "");
      const normalizedTx = event.chain === "solana" ? txIdentity : txIdentity.toLowerCase();
      const tokenIdentity = String(event.token?.address || event.tokenAddress || "").toLowerCase();
      const derivedStableKey = normalizedTx && tokenIdentity && event.side
        ? `trade:${event.chain}:${normalizedWallet}:${normalizedTx}:${tokenIdentity}:${String(event.side).toLowerCase()}`
        : "";
      const stableKey = derivedStableKey || event.stableSourceGroupKey || event.dedupeKey || event.key || `${event.chain}:${normalizedTx}:${event.tradeOrdinal || 0}`;
      const existing = this.db.prepare("SELECT * FROM canonical_trades WHERE stable_source_group_key=?").get(stableKey);
      const tradeId = existing?.id || event.id || randomUUID();
      const previous = parse(existing?.payload_json, {});
      const incomingOrigin = event.origin || (event.historical || event.legacy ? "legacy" : "live");
      const origin = ["live", "gap_recovery"].includes(existing?.origin) ? existing.origin : incomingOrigin;
      const incomingConfirmation = event.confirmationState || (event.state === "hint" ? "pending" : "confirmed");
      const confirmation = existing?.confirmation_state === "confirmed" ? "confirmed" : incomingConfirmation;
      const incomingWins = !existing || incomingConfirmation === "confirmed" || existing.confirmation_state !== "confirmed";
      const authoritative = incomingWins ? { ...previous, ...event } : { ...event, ...previous };
      const payload = {
        ...authoritative, id: tradeId,
        stableSourceGroupKey: stableKey,
        state: confirmation === "confirmed" ? "confirmed" : "hint",
        confirmationState: confirmation, origin, finality: event.finality || previous.finality || "observed",
        historical: !["live", "gap_recovery"].includes(origin),
        notificationEligible: ["live", "gap_recovery"].includes(origin) && event.notificationEligible !== false,
        notificationStatus: ["live", "gap_recovery"].includes(origin) ? (event.notificationStatus || "pending") : "skipped",
        confirmedAt: existing?.confirmation_state === "confirmed"
          ? (previous.confirmedAt || existing.confirmed_at || event.confirmedAt || observedAt)
          : (event.confirmedAt || previous.confirmedAt || (confirmation === "confirmed" ? observedAt : undefined)),
        tokenAmount: authoritative.tokenAmount == null ? previous.tokenAmount : decimal(authoritative.tokenAmount),
        quoteAmount: authoritative.quoteAmount == null ? previous.quoteAmount : decimal(authoritative.quoteAmount),
        valueUsd: authoritative.valueUsd == null ? previous.valueUsd : decimal(authoritative.valueUsd),
        token: authoritative.token || previous.token
          ? { ...(previous.token || {}), ...(authoritative.token || {}) }
          : undefined,
        quoteToken: authoritative.quoteToken || previous.quoteToken
          ? { ...(previous.quoteToken || {}), ...(authoritative.quoteToken || {}) }
          : undefined,
        observations: mergeObservations(previous.observations || [], event.observations || [], [{
          source: event.source || "unknown",
          sourceIdentity,
          observedAt,
          finality: event.finality,
        }]),
        normalizationVersion: "1.0",
      };
      const materiallyChanged = !existing || hash(json(materialPayload(previous))) !== hash(json(materialPayload(payload)));
      this.db.prepare(`INSERT INTO canonical_trades(id,stable_source_group_key,key_aliases_json,confirmation_state,origin,finality,chain,wallet,tx_identity,side,token_address,token_symbol,token_amount,quote_token_address,quote_amount,value_usd,leg_count,route_leg_count,source_occurred_at,first_observed_at,confirmed_at,finalized_at,late_detected,normalization_version,payload_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(stable_source_group_key) DO UPDATE SET confirmation_state=excluded.confirmation_state,finality=excluded.finality,
        side=COALESCE(excluded.side,canonical_trades.side),token_address=COALESCE(excluded.token_address,canonical_trades.token_address),
        token_symbol=COALESCE(excluded.token_symbol,canonical_trades.token_symbol),token_amount=COALESCE(excluded.token_amount,canonical_trades.token_amount),
        quote_token_address=COALESCE(excluded.quote_token_address,canonical_trades.quote_token_address),quote_amount=COALESCE(excluded.quote_amount,canonical_trades.quote_amount),
        value_usd=COALESCE(excluded.value_usd,canonical_trades.value_usd),leg_count=MAX(canonical_trades.leg_count,excluded.leg_count),
        route_leg_count=MAX(canonical_trades.route_leg_count,excluded.route_leg_count),confirmed_at=COALESCE(canonical_trades.confirmed_at,excluded.confirmed_at),
        finalized_at=COALESCE(excluded.finalized_at,canonical_trades.finalized_at),payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
        .run(tradeId, stableKey, json([...(parse(existing?.key_aliases_json, []) || []), ...(event.keyAliases || []), event.key, event.dedupeKey].filter(Boolean)), confirmation, origin, payload.finality, payload.chain || "unknown", payload.wallet || payload.maker || payload.sender || null, payload.txHash || payload.signature || payload.userOperationHash || stableKey, payload.side || null, payload.token?.address || payload.tokenAddress || null, payload.token?.symbol || payload.tokenSymbol || null, payload.tokenAmount ?? null, payload.quoteToken?.address || payload.quoteTokenAddress || null, payload.quoteAmount ?? null, payload.valueUsd ?? null, Number(payload.legCount || 0), Number(payload.routeLegCount || payload.legCount || 0), payload.timestamp || null, existing?.first_observed_at || observedAt, confirmation === "confirmed" ? payload.confirmedAt || existing?.confirmed_at || observedAt : null, payload.finalizedAt || null, payload.lateDetected ? 1 : 0, "1.0", json(payload), existing?.created_at || observedAt, observedAt);
      this.db.prepare("INSERT OR IGNORE INTO trade_observations(trade_id,source_record_id) VALUES(?,?)").run(tradeId, source.id);
      for (const related of this.db.prepare("SELECT id FROM source_records WHERE chain=? AND tx_identity=?").all(event.chain || "unknown", event.txHash || event.signature || event.userOperationHash || stableKey)) {
        this.db.prepare("INSERT OR IGNORE INTO trade_observations(trade_id,source_record_id) VALUES(?,?)").run(tradeId, related.id);
      }
      if (/^gmgn/.test(event.source || "")) {
        const verified = this.db.prepare(`SELECT id FROM source_records WHERE chain=? AND tx_identity=? AND adapter NOT LIKE 'gmgn%' ORDER BY first_observed_at LIMIT 1`).get(event.chain || "unknown", event.txHash || event.signature || event.userOperationHash || stableKey);
        this.db.prepare(`INSERT INTO chain_verification_jobs(id,trade_id,target_id,status,verified_source_record_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(trade_id) DO UPDATE SET status=excluded.status,verified_source_record_id=excluded.verified_source_record_id,updated_at=excluded.updated_at`)
          .run(randomUUID(), tradeId, event.targetId || null, verified ? "verified" : "queued", verified?.id || null, observedAt, observedAt);
      } else {
        this.db.prepare("UPDATE chain_verification_jobs SET status='verified',verified_source_record_id=?,updated_at=? WHERE trade_id=?").run(source.id, observedAt, tradeId);
      }
      const routeLegs = event.routeLegs || event.gmgn?.routeLegs || [];
      routeLegs.forEach((leg, index) => this.db.prepare("INSERT OR REPLACE INTO trade_legs(id,trade_id,leg_index,token_address,amount,quote_address,quote_amount,route_order,payload_json) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(`${tradeId}:${index}`, tradeId, index, leg.tokenAddress || leg.token?.address || null, leg.amount == null ? null : decimal(leg.amount), leg.quoteAddress || leg.quoteToken?.address || null, leg.quoteAmount == null ? null : decimal(leg.quoteAmount), leg.routeOrder ?? index, json(leg)));
      const becameConfirmed = confirmation === "confirmed" && existing?.confirmation_state !== "confirmed";
      const eventType = becameConfirmed ? "trade.confirmed" : existing ? "trade.updated" : "trade.pending";
      if (materiallyChanged || becameConfirmed) this.appendEvent(eventType, tradeId, payload);
      const eligible = confirmation === "confirmed" && ["live", "gap_recovery"].includes(origin) && event.notificationEligible !== false && !event.test;
      if (eligible && (!existing || becameConfirmed)) this.createNotificationIntents(tradeId);
      return { record: payload, isNew: !existing, isUpdated: Boolean(existing) && materiallyChanged };
    };
    return options.inTransaction ? action() : this.transaction(action);
  }

  createNotificationIntents(tradeId) {
    const stamp = now();
    const recipients = [{ channel: "browser", recipient: "local-browser" }, ...this.notificationRecipients];
    for (const item of recipients) {
      const id = randomUUID();
      const key = hash(`${tradeId}:${item.channel}:${item.recipient}:trade`);
      const result = this.db.prepare(`INSERT OR IGNORE INTO notification_outbox(id,trade_id,channel,recipient,correction_kind,status,idempotency_key,created_at,updated_at)
        VALUES(?,?,?,?,'trade','pending',?,?,?)`).run(id, tradeId, item.channel, item.recipient, key, stamp, stamp);
      if (result.changes) this.appendEvent("notification.pending", id, { id, tradeId, channel: item.channel, status: "pending" });
    }
  }

  listTrades(view = "live", { limit = 100, cursor = 0, chain = "" } = {}) {
    if (view === "pending") {
      const rows = this.db.prepare(`SELECT * FROM source_records WHERE kind!='trade' AND validity='observed' ${chain ? "AND chain=?" : ""} ORDER BY first_observed_at DESC LIMIT ? OFFSET ?`).all(...(chain ? [chain] : []), limit, cursor);
      return rows.map((row) => ({ ...parse(row.payload_json, {}), id: row.id, confirmationState: "pending", origin: row.origin, firstObservedAt: row.first_observed_at }));
    }
    const origins = view === "history" ? ["legacy", "startup_backfill", "manual_backfill"] : ["live", "gap_recovery"];
    const placeholders = origins.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM canonical_trades WHERE origin IN (${placeholders}) ${chain ? "AND chain=?" : ""} ORDER BY COALESCE(source_occurred_at,created_at) DESC LIMIT ? OFFSET ?`).all(...origins, ...(chain ? [chain] : []), limit, cursor);
    return rows.map((row) => ({ ...parse(row.payload_json, {}), id: row.id, confirmationState: row.confirmation_state, origin: row.origin, finality: row.finality, tokenAmount: row.token_amount, quoteAmount: row.quote_amount, valueUsd: row.value_usd }));
  }

  getTrade(id) {
    const row = this.db.prepare("SELECT * FROM canonical_trades WHERE id=?").get(id);
    if (!row) return null;
    const legs = this.db.prepare("SELECT payload_json FROM trade_legs WHERE trade_id=? ORDER BY leg_index").all(id).map((item) => parse(item.payload_json, {}));
    const observations = this.db.prepare(`SELECT sr.* FROM trade_observations t JOIN source_records sr ON sr.id=t.source_record_id WHERE t.trade_id=?`).all(id).map((item) => ({ ...parse(item.payload_json, {}), sourceIdentity: item.source_identity, firstObservedAt: item.first_observed_at }));
    return { ...parse(row.payload_json, {}), id, routeLegs: legs, observations };
  }

  appendEvent(type, entityId, data) {
    const id = randomUUID();
    const occurredAt = now();
    const result = this.db.prepare("INSERT INTO event_log(id,type,entity_id,payload_version,occurred_at,data_json) VALUES(?,?,?,'1.0',?,?)")
      .run(id, type, entityId || null, occurredAt, json(data));
    return { id, sequence: Number(result.lastInsertRowid), type, payloadVersion: "1.0", occurredAt, entityId, data };
  }

  eventsAfter(sequence = 0, limit = 500) {
    return this.db.prepare("SELECT * FROM event_log WHERE sequence>? ORDER BY sequence LIMIT ?").all(Number(sequence || 0), limit).map((row) => ({
      id: row.id, sequence: row.sequence, type: row.type, payloadVersion: row.payload_version,
      occurredAt: row.occurred_at, entityId: row.entity_id, data: parse(row.data_json, {}),
    }));
  }
  eventBounds() { return this.db.prepare("SELECT COALESCE(MIN(sequence),0) AS min,COALESCE(MAX(sequence),0) AS max FROM event_log").get(); }

  createOperation(kind, { idempotencyKey = null, requestId = null } = {}) {
    if (idempotencyKey) {
      const existing = this.db.prepare("SELECT * FROM operations WHERE idempotency_key=?").get(idempotencyKey);
      if (existing) return this.inflateOperation(existing);
    }
    const id = randomUUID(); const stamp = now();
    this.db.prepare("INSERT INTO operations(id,kind,status,progress,request_id,idempotency_key,created_at,updated_at) VALUES(?,?,'queued',0,?,?,?,?)")
      .run(id, kind, requestId, idempotencyKey, stamp, stamp);
    this.appendEvent("operation.updated", id, { id, kind, status: "queued", progress: 0 });
    return this.getOperation(id);
  }

  updateOperation(id, patch) {
    const current = this.getOperation(id); if (!current) return null;
    const stamp = now();
    const status = patch.status || current.status;
    this.db.prepare(`UPDATE operations SET status=?,progress=?,result_json=?,error_code=?,error_message=?,
      started_at=COALESCE(started_at,?),finished_at=?,updated_at=? WHERE id=?`).run(status, patch.progress ?? current.progress, json(patch.result ?? current.result), patch.errorCode || null, patch.errorMessage || null, status === "running" ? stamp : null, ["succeeded", "failed", "cancelled"].includes(status) ? stamp : null, stamp, id);
    const updated = this.getOperation(id); this.appendEvent("operation.updated", id, updated); return updated;
  }
  getOperation(id) { const row = this.db.prepare("SELECT * FROM operations WHERE id=?").get(id); return row ? this.inflateOperation(row) : null; }
  inflateOperation(row) { return { id: row.id, kind: row.kind, status: row.status, progress: row.progress, result: parse(row.result_json), errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, updatedAt: row.updated_at }; }
  listOperations({ limit = 100, cursor = 0 } = {}) { return this.db.prepare("SELECT * FROM operations ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, cursor).map((row) => this.inflateOperation(row)); }

  listRelayEvidence({ limit = 100, cursor = 0 } = {}) {
    return this.db.prepare("SELECT * FROM source_records WHERE adapter LIKE 'relay%' ORDER BY first_observed_at DESC LIMIT ? OFFSET ?").all(limit, cursor).map((row) => ({
      id: row.id, sourceIdentity: row.source_identity, targetId: row.target_id, personId: row.person_id,
      adapter: row.adapter, chain: row.chain, wallet: row.wallet, txIdentity: row.tx_identity,
      occurredAt: row.occurred_at, firstObservedAt: row.first_observed_at, validity: row.validity,
      origin: row.origin, rawRef: row.raw_ref, rawHash: row.raw_hash, data: parse(row.payload_json, {}),
    }));
  }

  listNotificationIntents({ channel = "browser", status = "pending", limit = 50 } = {}) {
    const expired = now();
    const rows = status === "pending"
      ? this.db.prepare(`SELECT n.*,c.payload_json FROM notification_outbox n JOIN canonical_trades c ON c.id=n.trade_id
        WHERE n.channel=? AND (n.status='pending' OR (n.status='delivering' AND n.lease_until<?)) ORDER BY n.created_at LIMIT ?`).all(channel, expired, limit)
      : this.db.prepare(`SELECT n.*,c.payload_json FROM notification_outbox n JOIN canonical_trades c ON c.id=n.trade_id
        WHERE n.channel=? AND n.status=? ORDER BY n.created_at LIMIT ?`).all(channel, status, limit);
    return rows.map((row) => ({
      id: row.id, tradeId: row.trade_id, channel: row.channel, recipient: row.recipient, status: row.status,
      attempts: row.attempts, createdAt: row.created_at, trade: parse(row.payload_json, {}),
    }));
  }

  claimNotification(id, owner, leaseMs = 30000) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM notification_outbox WHERE id=?").get(id);
      const expiredDelivery = row?.status === "delivering" && row.lease_until && row.lease_until < now();
      if (!row || (!["pending", "retry_wait"].includes(row.status) && !expiredDelivery)) return null;
      const until = new Date(Date.now() + leaseMs).toISOString();
      const result = this.db.prepare("UPDATE notification_outbox SET status='delivering',lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND (status IN ('pending','retry_wait') OR (status='delivering' AND lease_until<?))").run(owner, until, now(), id, now());
      if (!result.changes) return null;
      const payload = this.listNotificationById(id); this.appendEvent("notification.updated", id, payload); return payload;
    });
  }

  listNotificationById(id) {
    const row = this.db.prepare("SELECT * FROM notification_outbox WHERE id=?").get(id);
    return row ? { id: row.id, tradeId: row.trade_id, channel: row.channel, recipient: row.recipient, status: row.status, leaseOwner: row.lease_owner, leaseUntil: row.lease_until, attempts: row.attempts, lastError: row.last_error } : null;
  }

  finishNotification(id, { status, externalId = null, error = null, owner = null } = {}) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM notification_outbox WHERE id=?").get(id); if (!row || (owner && row.lease_owner !== owner)) return null;
      this.db.prepare("UPDATE notification_outbox SET status=?,external_id=?,last_error=?,lease_owner=NULL,lease_until=NULL,attempts=attempts+1,updated_at=? WHERE id=?")
        .run(status, externalId, error, now(), id);
      this.db.prepare("INSERT INTO notification_attempts(id,intent_id,attempt,started_at,finished_at,result,external_id,error_message) VALUES(?,?,?,?,?,?,?,?)")
        .run(randomUUID(), id, row.attempts + 1, row.updated_at, now(), status, externalId, error);
      const updated = this.listNotificationById(id); this.appendEvent("notification.updated", id, updated); return updated;
    });
  }

  upsertHealth(sourceKey, detail = {}) {
    const stamp = now();
    const state = detail.health || detail.state || "unknown";
    this.db.prepare(`INSERT INTO source_health(source_key,target_id,state,last_attempt_at,last_success_at,last_target_event_at,head_position,processed_position,block_lag,effective_poll_interval_ms,consecutive_failures,error_code,error_message,next_retry_at,details_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET state=excluded.state,last_attempt_at=excluded.last_attempt_at,
      last_success_at=COALESCE(excluded.last_success_at,source_health.last_success_at),last_target_event_at=COALESCE(excluded.last_target_event_at,source_health.last_target_event_at),
      head_position=COALESCE(excluded.head_position,source_health.head_position),processed_position=COALESCE(excluded.processed_position,source_health.processed_position),
      block_lag=excluded.block_lag,effective_poll_interval_ms=excluded.effective_poll_interval_ms,consecutive_failures=excluded.consecutive_failures,
      error_code=excluded.error_code,error_message=excluded.error_message,next_retry_at=excluded.next_retry_at,details_json=excluded.details_json,updated_at=excluded.updated_at`)
      .run(sourceKey, detail.targetId || null, state, detail.lastCheckedAt || stamp, ["healthy", "connected"].includes(state) ? stamp : null, detail.lastTargetEventAt || null, detail.headBlockOrSlot || detail.headBlock || null, detail.processedBlockOrSlot || detail.toBlock || null, detail.blockLag ?? null, detail.effectivePollIntervalMs ?? null, detail.consecutiveFailures || 0, detail.errorCode || null, detail.errorMessage || (String(state).startsWith("error") ? String(state) : null), detail.nextRetryAt || null, json(detail), stamp);
    this.appendEvent("health.updated", sourceKey, { source: sourceKey, ...detail, state });
  }
  listHealth() { return this.db.prepare("SELECT * FROM source_health ORDER BY source_key").all().map((row) => ({ source: row.source_key, state: row.state, lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, lastTargetEventAt: row.last_target_event_at, headBlockOrSlot: row.head_position, processedBlockOrSlot: row.processed_position, blockLag: row.block_lag, effectivePollIntervalMs: row.effective_poll_interval_ms, consecutiveFailures: row.consecutive_failures, errorCode: row.error_code, errorMessage: row.error_message, nextRetryAt: row.next_retry_at, ...parse(row.details_json, {}) })); }

  matchFomoAlert(alert) {
    let candidates = [];
    if (alert.txIdentity && alert.chain !== "unknown") {
      candidates = this.db.prepare("SELECT id,value_usd FROM canonical_trades WHERE chain=? AND tx_identity=? AND confirmation_state='confirmed' LIMIT 3").all(alert.chain, alert.txIdentity);
    }
    if (!candidates.length && alert.isTradeLike && alert.chain !== "unknown" && alert.side && alert.tokenAddress) {
      const occurred = new Date(alert.occurredAt).getTime();
      const start = new Date(occurred - 120_000).toISOString();
      const end = new Date(occurred + 120_000).toISOString();
      const tokenPredicate = alert.chain === "solana" ? "token_address=?" : "lower(token_address)=lower(?)";
      candidates = this.db.prepare(`SELECT id,value_usd FROM canonical_trades
        WHERE chain=? AND side=? AND ${tokenPredicate} AND confirmation_state='confirmed'
          AND COALESCE(source_occurred_at,created_at) BETWEEN ? AND ? LIMIT 4`)
        .all(alert.chain, alert.side, alert.tokenAddress, start, end);
      if (alert.valueUsd && candidates.length) {
        const expected = Number(alert.valueUsd);
        candidates = candidates.filter((candidate) => {
          const actual = Number(candidate.value_usd);
          if (!Number.isFinite(expected) || !Number.isFinite(actual)) return true;
          return Math.abs(expected - actual) <= Math.max(1, expected * 0.03);
        });
      }
    }
    return candidates.length === 1 ? { state: "matched", tradeId: candidates[0].id } : candidates.length > 1 ? { state: "ambiguous", tradeId: null } : { state: "unmatched", tradeId: null };
  }

  insertFomoAlert(alert) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM fomo_alerts WHERE event_identity=?").get(alert.eventIdentity);
      if (existing) {
        this.db.prepare("UPDATE fomo_alerts SET updated_at=? WHERE id=?").run(now(), existing.id);
        return { inserted: false, alert: this.inflateFomoAlert({ ...existing, updated_at: now() }) };
      }
      const stamp = now();
      const match = this.matchFomoAlert(alert);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO fomo_alerts(id,event_identity,fomo_event_id,event_type,chain,network_id,trader_id,trader_handle,
        token_address,token_symbol,side,value_usd,tx_identity,occurred_at,received_at,is_trade_like,match_state,matched_trade_id,payload_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, alert.eventIdentity, alert.fomoEventId || null, alert.eventType, alert.chain || "unknown", alert.networkId || null,
        alert.traderId || null, alert.traderHandle || null, alert.tokenAddress || null, alert.tokenSymbol || null,
        alert.side || null, alert.valueUsd || null, alert.txIdentity || null, alert.occurredAt, alert.receivedAt,
        alert.isTradeLike ? 1 : 0, match.state, match.tradeId, json(alert.payload), stamp, stamp,
      );
      const saved = this.inflateFomoAlert(this.db.prepare("SELECT * FROM fomo_alerts WHERE id=?").get(id));
      this.appendEvent("fomo.alert.received", id, {
        id, eventIdentity: saved.eventIdentity, eventType: saved.eventType, chain: saved.chain,
        traderHandle: saved.traderHandle, tokenAddress: saved.tokenAddress, tokenSymbol: saved.tokenSymbol,
        side: saved.side, valueUsd: saved.valueUsd, occurredAt: saved.occurredAt,
        matchState: saved.matchState, matchedTradeId: saved.matchedTradeId,
      });
      return { inserted: true, alert: saved };
    });
  }

  inflateFomoAlert(row) {
    return row ? {
      id: row.id, eventIdentity: row.event_identity, fomoEventId: row.fomo_event_id, eventType: row.event_type,
      chain: row.chain, networkId: row.network_id, traderId: row.trader_id, traderHandle: row.trader_handle,
      tokenAddress: row.token_address, tokenSymbol: row.token_symbol, side: row.side, valueUsd: row.value_usd,
      txIdentity: row.tx_identity, occurredAt: row.occurred_at, receivedAt: row.received_at,
      isTradeLike: Boolean(row.is_trade_like), matchState: row.match_state, matchedTradeId: row.matched_trade_id,
      payload: parse(row.payload_json, {}), createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  listFomoAlerts({ limit = 100, cursor = 0, matchState = "" } = {}) {
    const rows = matchState
      ? this.db.prepare("SELECT * FROM fomo_alerts WHERE match_state=? ORDER BY occurred_at DESC LIMIT ? OFFSET ?").all(matchState, limit, cursor)
      : this.db.prepare("SELECT * FROM fomo_alerts ORDER BY occurred_at DESC LIMIT ? OFFSET ?").all(limit, cursor);
    return rows.map((row) => this.inflateFomoAlert(row));
  }

  reconcilePendingFomoAlerts(limit = 200) {
    const rows = this.db.prepare("SELECT * FROM fomo_alerts WHERE is_trade_like=1 AND match_state IN ('unmatched','ambiguous') ORDER BY occurred_at DESC LIMIT ?").all(limit);
    let matched = 0;
    for (const row of rows) {
      const alert = this.inflateFomoAlert(row);
      const result = this.matchFomoAlert(alert);
      if (result.state !== "matched") continue;
      this.db.prepare("UPDATE fomo_alerts SET match_state='matched',matched_trade_id=?,updated_at=? WHERE id=?").run(result.tradeId, now(), row.id);
      this.appendEvent("fomo.alert.matched", row.id, { id: row.id, matchedTradeId: result.tradeId, eventIdentity: row.event_identity });
      matched += 1;
    }
    return matched;
  }

  fomoBridgeSummary(windowMs = 86_400_000) {
    const since = new Date(Date.now() - windowMs).toISOString();
    const total = Number(this.scalar("SELECT COUNT(*) FROM fomo_alerts WHERE occurred_at>=?", since) || 0);
    const matched = Number(this.scalar("SELECT COUNT(*) FROM fomo_alerts WHERE occurred_at>=? AND match_state='matched'", since) || 0);
    const appOnly = Number(this.scalar("SELECT COUNT(*) FROM fomo_alerts WHERE occurred_at>=? AND is_trade_like=1 AND match_state IN ('unmatched','ambiguous')", since) || 0);
    const chainOnly = Number(this.scalar(`SELECT COUNT(*) FROM canonical_trades c WHERE c.confirmation_state='confirmed'
      AND c.origin IN ('live','gap_recovery') AND COALESCE(c.source_occurred_at,c.created_at)>=?
      AND NOT EXISTS (SELECT 1 FROM fomo_alerts f WHERE f.matched_trade_id=c.id)`, since) || 0);
    const latest = this.db.prepare("SELECT occurred_at,received_at FROM fomo_alerts ORDER BY received_at DESC LIMIT 1").get();
    return { windowHours: Math.round(windowMs / 3_600_000), total, matched, appOnly, chainOnly, lastEventAt: latest?.occurred_at || null, lastReceivedAt: latest?.received_at || null };
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key=?").get(key);
    return row ? parse(row.value_json, fallback) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(key, json(value), now());
    return value;
  }

  deleteSetting(key) { return this.db.prepare("DELETE FROM app_settings WHERE key=?").run(key).changes > 0; }

  saveReconciliation(input) {
    return this.transaction(() => {
      const id = input.id || randomUUID(); const stamp = now();
      this.db.prepare(`INSERT INTO reconciliation_runs(id,target_id,person_id,chain,wallet,window_start,window_end,status,source_complete,source_count,local_count,matched,missing,extra,mismatched,adapter_version,normalization_version,tolerance_json,created_at,completed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.targetId || null, input.personId || null, input.chain, input.wallet, input.windowStart, input.windowEnd, input.status, input.sourceComplete ? 1 : 0, input.sourceCount || 0, input.localCount || 0, input.matched || 0, input.missing || 0, input.extra || 0, input.mismatched || 0, input.adapterVersion || null, input.normalizationVersion || "1.0", json(input.tolerance || { valueUsd: "max(0.01,0.1%)" }), stamp, ["closed", "failed", "incomplete"].includes(input.status) ? stamp : null);
      for (const item of input.items || []) this.db.prepare("INSERT INTO reconciliation_items(id,run_id,item_kind,reconciliation_key,differences_json,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), id, item.kind, item.key, json(item.differences || {}), stamp);
      for (const item of (input.items || []).filter((entry) => entry.kind === "missing")) this.db.prepare(`INSERT OR IGNORE INTO repair_jobs(id,target_id,reconciliation_run_id,reconciliation_key,status,reason_json,created_at,updated_at)
        VALUES(?,?,?,?,'queued',?,?,?)`).run(randomUUID(), input.targetId || null, id, item.key, json(item.differences || {}), stamp, stamp);
      const run = this.listReconciliations().find((item) => item.id === id); this.appendEvent("reconciliation.completed", id, run); return run;
    });
  }
  listReconciliations(limit = 100) { return this.db.prepare("SELECT * FROM reconciliation_runs ORDER BY created_at DESC LIMIT ?").all(limit).map((row) => ({ id: row.id, targetId: row.target_id, personId: row.person_id, chain: row.chain, wallet: row.wallet, windowStart: row.window_start, windowEnd: row.window_end, status: row.status, sourceComplete: Boolean(row.source_complete), sourceCount: row.source_count, localCount: row.local_count, matched: row.matched, missing: row.missing, extra: row.extra, mismatched: row.mismatched, checkedAt: row.completed_at || row.created_at, items: this.db.prepare("SELECT item_kind AS kind,reconciliation_key AS key,differences_json FROM reconciliation_items WHERE run_id=?").all(row.id).map((item) => ({ ...item, differences: parse(item.differences_json, {}) })) })); }

  statusSummary() {
    const people = this.listPeople(); const targets = this.activeTargets(); const bounds = this.eventBounds();
    return { running: true, storage: "sqlite", schemaVersion: SCHEMA_VERSION, integrity: this.integrityCheck(), people: people.length, activePeople: people.filter((p) => p.monitorState === "active").length, unresolvedPeople: people.filter((p) => p.monitorState === "unresolved").length, activeTargets: targets.length, confirmedTrades24h: Number(this.scalar("SELECT COUNT(*) FROM canonical_trades WHERE confirmation_state='confirmed' AND origin IN ('live','gap_recovery') AND COALESCE(source_occurred_at,created_at)>=?", new Date(Date.now() - 86400000).toISOString()) || 0), pending: Number(this.scalar("SELECT COUNT(*) FROM source_records WHERE kind!='trade' AND validity='observed'") || 0), asOfEventId: Number(bounds.max || 0) };
  }
}
