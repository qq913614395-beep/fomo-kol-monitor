import path from "node:path";
import { MonitorDatabase } from "./database.mjs";

function legacyCursorKey(group, key) {
  if (group === "gmgn") {
    return { targetId: String(key).replace(/:$/, ""), adapter: "gmgn", streamKind: "activity" };
  }
  if (group === "solana") return { targetId: `solana:${key}`, adapter: "solana-rpc", streamKind: "signatures" };
  if (group === "evm") return { targetId: `evm:${key}`, adapter: "evm-rpc", streamKind: "blocks" };
  return { targetId: `relay:${key}`, adapter: "relay", streamKind: "requests" };
}

export class Store {
  constructor(dataDir, options = {}) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.resolve(options.legacyStateFile || process.env.LEGACY_STATE_PATH || path.join(this.dataDir, "state.json"));
    this.databaseFile = path.resolve(options.databaseFile || process.env.DATABASE_PATH || path.join(this.dataDir, "monitor.sqlite3"));
    this.database = null;
    this.state = { people: [], events: [], cursors: { solana: {}, evm: {}, relay: {}, gmgn: {} }, meta: { schemaVersion: 3 } };
  }

  async load() {
    this.database = new MonitorDatabase(this.databaseFile);
    const migration = this.database.importLegacyState(this.file);
    this.refreshState();
    this.state.meta = { schemaVersion: 3, storage: "sqlite", databaseFile: this.databaseFile, migration };
    return this.state;
  }

  refreshState() {
    this.state.people = this.database.listPeople();
    this.state.events = [
      ...this.database.listTrades("live", { limit: 750 }),
      ...this.database.listTrades("history", { limit: 500 }),
      ...this.database.listTrades("pending", { limit: 250 }),
    ].sort((a, b) => String(b.timestamp || b.firstObservedAt || "").localeCompare(String(a.timestamp || a.firstObservedAt || ""))).slice(0, 1500);
    const rows = this.database.db.prepare("SELECT * FROM source_cursors").all();
    this.state.cursors = { solana: {}, evm: {}, relay: {}, gmgn: {} };
    for (const row of rows) {
      const payload = JSON.parse(row.cursor_json);
      if (row.adapter === "gmgn") this.state.cursors.gmgn[String(row.target_id).replace(/:$/, "")] = payload;
      else if (row.adapter === "solana-rpc") this.state.cursors.solana[row.target_id.replace(/^solana:/, "")] = payload.cursor ?? payload;
      else if (row.adapter === "evm-rpc") this.state.cursors.evm[row.target_id.replace(/^evm:/, "")] = payload.cursor ?? payload;
      else if (row.adapter === "relay") this.state.cursors.relay[row.target_id.replace(/^relay:/, "")] = payload.cursor ?? payload;
    }
  }

  async save() {
    const stamp = new Date().toISOString();
    this.database.transaction(() => {
      for (const [group, entries] of Object.entries(this.state.cursors || {})) {
        for (const [key, value] of Object.entries(entries || {})) {
          const info = legacyCursorKey(group, key);
          this.database.db.prepare(`INSERT INTO source_cursors(target_id,adapter,stream_kind,scope_id,cursor_json,updated_at)
            VALUES(?,?,?,'live',?,?) ON CONFLICT(target_id,adapter,stream_kind,scope_id)
            DO UPDATE SET cursor_json=excluded.cursor_json,updated_at=excluded.updated_at`)
            .run(info.targetId, info.adapter, info.streamKind, JSON.stringify(typeof value === "object" ? value : { cursor: value }), stamp);
        }
      }
    });
  }

  close() { this.database?.close(); }
  listPeople() { return this.database.listPeople(); }
  getPerson(id) { return this.database.getPerson(id); }

  async upsertPerson(input) {
    const person = this.database.upsertPerson(input);
    this.refreshState();
    return person;
  }

  async removePerson(id) {
    const removed = this.database.removePerson(id);
    this.refreshState();
    return removed;
  }

  async setPersonState(id, state) {
    const person = this.database.setPersonState(id, state);
    this.refreshState();
    return person;
  }

  listBindings(id) { return this.database.listBindings(id); }
  listAddressCandidates(id, options) { return this.database.listAddressCandidates(id, options); }
  async upsertBinding(id, input) { const result = this.database.upsertBinding(id, input); this.refreshState(); return result; }
  async updateBinding(id, bindingId, patch) { const result = this.database.updateBinding(id, bindingId, patch); this.refreshState(); return result; }
  async removeBinding(id, bindingId) { const result = this.database.removeBinding(id, bindingId); this.refreshState(); return result; }
  async upsertAddressCandidate(id, input) { const result = this.database.upsertAddressCandidate(id, input); this.refreshState(); return result; }
  async verifyAddressCandidate(id, candidateId, patch) { const result = this.database.verifyAddressCandidate(id, candidateId, patch); this.refreshState(); return result; }
  async rejectAddressCandidate(id, candidateId) { const result = this.database.rejectAddressCandidate(id, candidateId); this.refreshState(); return result; }
  activeTargets() { return this.database.activeTargets(); }
  subscriptionFence(personId, targetId) {
    return this.database.db.prepare(`SELECT notification_fence FROM monitor_subscriptions
      WHERE person_id=? AND target_id=? AND desired_state='active' AND active_to IS NULL
      ORDER BY generation DESC LIMIT 1`).get(personId, targetId)?.notification_fence || "";
  }

  async addEvent(event) { const result = await this.addOrMergeEvent(event); return result.isNew ? result.record : null; }
  async addOrMergeEvent(event) {
    const result = this.database.recordEvent(event);
    this.refreshState();
    return result;
  }

  async updateEvent(key, patch) {
    const row = this.database.db.prepare("SELECT * FROM canonical_trades WHERE stable_source_group_key=?").get(key);
    if (!row) return null;
    const existing = JSON.parse(row.payload_json);
    const existingFields = { ...existing };
    const patchFields = { ...(patch || {}) };
    delete existingFields.observations;
    delete patchFields.observations;
    const result = this.database.recordEvent({
      ...existingFields,
      ...patchFields,
      id: row.id,
      stableSourceGroupKey: key,
      source: "market-enrichment",
      sourceIdentity: `update:${row.id}:market-enrichment`,
      observations: [],
      observedAt: new Date().toISOString(),
      kind: "trade",
      notificationEligible: false,
    });
    this.refreshState();
    return result.record;
  }

  listEvents(limit = 100) { return this.state.events.slice(0, Math.max(1, Math.min(Number(limit) || 100, 500))); }
  pruneGmgnRouteIntermediates() { return 0; }
}
