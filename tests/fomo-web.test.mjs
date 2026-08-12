import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBridgeSignature, normalizeFomoAlert, verifyBridgeSignature } from "../monitor/fomo-web.mjs";
import { protectSecret, unprotectSecret } from "../monitor/secrets.mjs";
import { Store } from "../monitor/store.mjs";

const SOL = "498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ";
const SECRET = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";

test("normalizes trading activity without collapsing different cards that share an id", () => {
  const first = normalizeFomoAlert({ id: "shared-trade", type: "SWAP_BUY", networkId: 792703809, token: { address: "MintA", symbol: "AAA" }, userHandle: "alice", usdAmount: "12.3400", createdAt: 1785801600 });
  const second = normalizeFomoAlert({ id: "shared-trade", type: "swap_buy", networkId: 792703809, token: { address: "MintA", symbol: "AAA" }, userHandle: "bob", usdAmount: "12.34", createdAt: 1785801600 });
  assert.equal(first.chain, "solana");
  assert.equal(first.side, "buy");
  assert.equal(first.valueUsd, "12.34");
  assert.equal(first.occurredAt, "2026-08-04T00:00:00.000Z");
  assert.notEqual(first.eventIdentity, second.eventIdentity);
  assert.equal(first.isTradeLike, true);
});

test("bridge HMAC accepts the exact body only inside the clock window", () => {
  const timestamp = 1_785_801_600_000;
  const rawBody = JSON.stringify({ kind: "alerts", alerts: [{ id: "a" }] });
  const signature = createBridgeSignature(SECRET, timestamp, rawBody);
  assert.equal(verifyBridgeSignature({ secret: SECRET, timestamp, rawBody, signature, nowMs: timestamp + 30_000 }), true);
  assert.equal(verifyBridgeSignature({ secret: SECRET, timestamp, rawBody: `${rawBody} `, signature, nowMs: timestamp }), false);
  assert.equal(verifyBridgeSignature({ secret: SECRET, timestamp, rawBody, signature, nowMs: timestamp + 60_001 }), false);
});

test("portable server secrets use authenticated AES-256-GCM", async () => {
  const previous = process.env.MONITOR_MASTER_KEY;
  process.env.MONITOR_MASTER_KEY = SECRET;
  try {
    const encrypted = await protectSecret("server-secret");
    assert.match(encrypted, /^aesgcm:/);
    assert.equal(await unprotectSecret(encrypted), "server-secret");
    const replacement = encrypted.endsWith("A") ? "B" : "A";
    await assert.rejects(() => unprotectSecret(`${encrypted.slice(0, -1)}${replacement}`));
  } finally {
    if (previous == null) delete process.env.MONITOR_MASTER_KEY; else process.env.MONITOR_MASTER_KEY = previous;
  }
});

test("FOMO evidence is idempotent, matches confirmed trades, and never creates notifications", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-web-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const person = await store.upsertPerson({ handle: "kol", solanaAddress: SOL });
    const occurredAt = new Date().toISOString();
    await store.addOrMergeEvent({ source: "gmgn-portfolio", sourceIdentity: "sig-match", kind: "trade", state: "confirmed", chain: "solana", wallet: SOL, txHash: "sig-match", side: "buy", token: { address: "MintExact", symbol: "EXACT" }, tokenAmount: "2", valueUsd: "10.10", timestamp: occurredAt, origin: "live", personId: person.id, notificationEligible: false });
    const beforeNotifications = Number(store.database.scalar("SELECT COUNT(*) FROM notification_outbox"));
    const alert = normalizeFomoAlert({ id: "card-1", type: "swap_buy", networkId: "792703809", tokenAddress: "MintExact", tokenSymbol: "EXACT", userHandle: "kol", usdAmount: "10.1", txHash: "sig-match", createdAt: occurredAt });
    const inserted = store.database.insertFomoAlert(alert);
    const duplicate = store.database.insertFomoAlert(alert);
    assert.equal(inserted.inserted, true);
    assert.equal(inserted.alert.matchState, "matched");
    assert.equal(duplicate.inserted, false);
    assert.equal(store.database.scalar("SELECT COUNT(*) FROM fomo_alerts"), 1);
    assert.equal(store.database.scalar("SELECT COUNT(*) FROM notification_outbox"), beforeNotifications);
    assert.equal(store.database.fomoBridgeSummary().matched, 1);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("FOMO-only evidence remains unmatched and ambiguous candidates are not guessed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-web-db-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    const person = await store.upsertPerson({ handle: "kol", solanaAddress: SOL });
    const occurredAt = new Date().toISOString();
    for (const txHash of ["sig-a", "sig-b"]) await store.addOrMergeEvent({ source: "gmgn-portfolio", sourceIdentity: txHash, kind: "trade", state: "confirmed", chain: "solana", wallet: SOL, txHash, side: "sell", token: { address: "CaseSensitiveMint", symbol: "CASE" }, tokenAmount: "1", valueUsd: "20", timestamp: occurredAt, origin: "live", personId: person.id, notificationEligible: false });
    const ambiguous = store.database.insertFomoAlert(normalizeFomoAlert({ id: "ambiguous", type: "swap_sell", networkId: 792703809, tokenAddress: "CaseSensitiveMint", usdAmount: "20", createdAt: occurredAt }));
    const caseMismatch = store.database.insertFomoAlert(normalizeFomoAlert({ id: "case-mismatch", type: "swap_sell", networkId: 792703809, tokenAddress: "casesensitivemint", usdAmount: "20", createdAt: occurredAt }));
    assert.equal(ambiguous.alert.matchState, "ambiguous");
    assert.equal(caseMismatch.alert.matchState, "unmatched");
    assert.equal(store.database.scalar("SELECT COUNT(*) FROM notification_outbox"), 0);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
