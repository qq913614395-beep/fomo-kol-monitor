import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addDecimals, compareDecimals, decimal } from "../monitor/decimal.mjs";
import { Store } from "../monitor/store.mjs";

const SOL = "498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ";
const EVM = "0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28";

test("exact decimal arithmetic never uses binary floating point", () => {
  assert.equal(addDecimals(["675.10039149522", "1580.44443691023"]), "2255.54482840545");
  assert.equal(addDecimals(["1397102.475115", "3350274.24577"]), "4747376.720885");
  assert.equal(decimal("1.2300"), "1.23");
  assert.equal(compareDecimals("1.000", "1"), 0);
});

test("legacy migration keeps an unscoped EVM seed pending instead of cloning it across chains", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-db-"));
  const legacy = path.join(directory, "legacy.json");
  await writeFile(legacy, JSON.stringify({ people: [{ id: "p1", handle: "Alice", twitter: "alice", solanaAddress: SOL, evmAddress: EVM, enabled: true }], events: [{ id: "e1", key: "trade:old", dedupeKey: "trade:old", personId: "p1", source: "gmgn-portfolio", kind: "trade", state: "confirmed", chain: "solana", txHash: "sig-old", side: "sell", valueUsd: 12.34, tokenAmount: 100, token: { address: "mint", symbol: "OLD" }, timestamp: "2026-01-01T00:00:00.000Z", notificationEligible: true }], cursors: {}, meta: { schemaVersion: 2 } }), "utf8");
  const previous = process.env.LEGACY_STATE_PATH;
  process.env.LEGACY_STATE_PATH = legacy;
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const person = store.getPerson("p1");
    assert.equal(person.handle, "alice");
    assert.equal(person.bindings.length, 1);
    assert.equal(person.bindings[0].chain, "solana");
    assert.equal(person.addressCandidates.length, 1);
    assert.equal(person.addressCandidates[0].chain, "unknown");
    assert.equal(person.addressCandidates[0].verificationState, "pending");
    assert.equal(store.activeTargets().length, 1);
    const [trade] = store.database.listTrades("history", { limit: 10 });
    assert.equal(trade.origin, "legacy");
    assert.equal(trade.valueUsd, "12.34");
    assert.equal(trade.notificationEligible, false);
    assert.equal(store.database.scalar("SELECT COUNT(*) FROM notification_outbox"), 0);
    assert.equal(store.database.integrityCheck(), "ok");
  } finally {
    if (previous == null) delete process.env.LEGACY_STATE_PATH; else process.env.LEGACY_STATE_PATH = previous;
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("one physical wallet can serve multiple KOL subscriptions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const a = await store.upsertPerson({ handle: "a" });
    const b = await store.upsertPerson({ handle: "b" });
    await store.upsertBinding(a.id, { chain: "base", address: EVM, addressRole: "smart_account", verificationState: "verified" });
    await store.upsertBinding(b.id, { chain: "base", address: EVM, addressRole: "smart_account", verificationState: "verified" });
    assert.equal(store.activeTargets().length, 1);
    const shared = store.activeTargets().find((target) => target.chain === "base");
    assert.deepEqual(shared.people.map((person) => person.id).sort(), [a.id, b.id].sort());
    await store.setPersonState(a.id, "paused");
    assert.equal(store.activeTargets().find((target) => target.chain === "base").people.length, 1);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("only verified monitorable address roles become targets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const person = await store.upsertPerson({ handle: "cluster", evmAddress: EVM });
    assert.equal(store.activeTargets().length, 0);
    const [candidate] = person.addressCandidates;
    assert.equal(candidate.addressRole, "unknown");
    await assert.rejects(() => store.verifyAddressCandidate(person.id, candidate.id, {}), /supported destination chain/);
    const verified = await store.verifyAddressCandidate(person.id, candidate.id, { chain: "bsc", addressRole: "vault" });
    assert.equal(verified.binding.addressRole, "vault");
    assert.equal(store.activeTargets().length, 1);
    await store.upsertBinding(person.id, { chain: "base", address: "0x1111111111111111111111111111111111111111", addressRole: "deposit", verificationState: "verified" });
    assert.equal(store.activeTargets().length, 1);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("live confirmed trade creates one browser intent and claim is exclusive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const person = await store.upsertPerson({ handle: "kol", solanaAddress: SOL });
    const event = { key: "trade:solana:sig:mint:buy", dedupeKey: "trade:solana:sig:mint:buy", personId: person.id, source: "gmgn-portfolio", kind: "trade", state: "confirmed", chain: "solana", txHash: "sig", side: "buy", tokenAmount: "1.25", valueUsd: "10.10", token: { address: "mint", symbol: "T" }, timestamp: new Date(Date.now() + 1000).toISOString(), origin: "live", notificationEligible: true };
    const first = await store.addOrMergeEvent(event);
    await store.addOrMergeEvent(event);
    assert.equal(store.database.scalar("SELECT COUNT(*) FROM canonical_trades"), 1);
    assert.equal(store.database.scalar("SELECT COUNT(*) FROM notification_outbox"), 1);
    const [intent] = store.database.listNotificationIntents({ channel: "browser", status: "pending" });
    assert.ok(store.database.claimNotification(intent.id, "tab-a"));
    assert.equal(store.database.claimNotification(intent.id, "tab-b"), null);
    const acked = store.database.finishNotification(intent.id, { status: "delivered" });
    assert.equal(acked.status, "delivered");
    assert.equal(first.record.valueUsd, "10.1");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("operations and durable event replay survive page refresh", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const before = store.database.eventBounds().max;
    const operation = store.database.createOperation("reconciliation", { idempotencyKey: "same-key" });
    const duplicate = store.database.createOperation("reconciliation", { idempotencyKey: "same-key" });
    assert.equal(operation.id, duplicate.id);
    store.database.updateOperation(operation.id, { status: "succeeded", progress: 100, result: { ok: true } });
    assert.equal(store.database.getOperation(operation.id).result.ok, true);
    assert.ok(store.database.eventsAfter(before).some((event) => event.type === "operation.updated"));
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("confirmed trade fields cannot be downgraded by a later hint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const base = { source: "gmgn-portfolio", kind: "trade", chain: "solana", wallet: SOL, txHash: "sig-priority", side: "sell", token: { address: "mint", symbol: "RIGHT" }, tokenAmount: "2", valueUsd: "25", origin: "live", notificationEligible: false };
    const confirmed = await store.addOrMergeEvent({ ...base, state: "confirmed" });
    await store.addOrMergeEvent({ ...base, source: "rpc-hint", sourceIdentity: "hint-late", state: "hint", tokenAmount: "999", valueUsd: "999", token: { address: "mint", symbol: "WRONG" } });
    const trade = store.database.getTrade(confirmed.record.id);
    assert.equal(trade.confirmationState, "confirmed");
    assert.equal(trade.token.symbol, "RIGHT");
    assert.equal(trade.tokenAmount, "2");
    assert.equal(trade.valueUsd, "25");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("repeated trade sightings and market updates keep payloads bounded", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const base = {
      source: "gmgn-portfolio", kind: "trade", state: "confirmed", chain: "solana",
      wallet: SOL, txHash: "sig-bounded", side: "buy", token: { address: "mint-bounded", symbol: "BOUND" },
      tokenAmount: "1", valueUsd: "10", origin: "live", notificationEligible: false,
      observations: [{ source: "gmgn-portfolio", observedAt: "2026-08-04T00:00:00.000Z" }],
    };
    const created = await store.addOrMergeEvent(base);
    const initialEvents = store.database.scalar("SELECT COUNT(*) FROM event_log");
    for (let index = 0; index < 300; index += 1) {
      await store.addOrMergeEvent(base);
      await store.updateEvent(created.record.stableSourceGroupKey, {
        token: { ...base.token, marketCap: 1234, liquidityUsd: 567 },
        marketEnrichedAt: "2026-08-04T00:00:01.000Z",
      });
    }
    const row = store.database.db.prepare("SELECT payload_json FROM canonical_trades WHERE id=?").get(created.record.id);
    const payload = JSON.parse(row.payload_json);
    assert.ok(payload.observations.length <= 50);
    assert.ok(Buffer.byteLength(row.payload_json, "utf8") < 20_000);
    assert.ok(store.database.scalar("SELECT MAX(LENGTH(payload_json)) FROM source_records") < 20_000);
    assert.ok(store.database.scalar("SELECT MAX(LENGTH(data_json)) FROM event_log") < 20_000);
    assert.ok(store.database.scalar("SELECT COUNT(*) FROM event_log") <= initialEvents + 2);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("missing reconciliation identities create durable repair jobs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    store.database.saveReconciliation({ targetId: "target-1", chain: "solana", wallet: SOL, windowStart: "2026-08-01T00:00:00.000Z", windowEnd: "2026-08-01T01:00:00.000Z", status: "closed", sourceComplete: true, sourceCount: 1, localCount: 0, matched: 0, missing: 1, extra: 0, mismatched: 0, items: [{ kind: "missing", key: "trade-key", differences: { expected: { valueUsd: "10" } } }] });
    assert.equal(store.database.scalar("SELECT COUNT(*) FROM repair_jobs WHERE status='queued'"), 1);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("GMGN cursor keys survive save and reload without a trailing-colon mismatch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-store-"));
  const databaseFile = path.join(directory, "monitor.sqlite3");
  let store;
  try {
    store = new Store(directory, { databaseFile });
    await store.load();
    store.state.cursors.gmgn["550e8400-e29b-41d4-a716-446655440000"] = {
      watermarkTimestamp: 123,
      seen: ["fingerprint"],
    };
    await store.save();
    store.close();
    store = new Store(directory, { databaseFile });
    await store.load();
    assert.equal(store.state.cursors.gmgn["550e8400-e29b-41d4-a716-446655440000"].watermarkTimestamp, 123);
    assert.equal(store.state.cursors.gmgn["550e8400-e29b-41d4-a716-446655440000:"], undefined);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
