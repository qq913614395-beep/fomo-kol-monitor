import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../monitor/store.mjs";
import { Watchers } from "../monitor/watchers.mjs";

const SOL = "498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ";

function response(result) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
}

test("Solana page-cap gap leaves the previous cursor untouched", async () => {
  const originalFetch = globalThis.fetch;
  const cursors = { solana: { [SOL]: "old-watermark" }, evm: {}, relay: {}, gmgn: {} };
  let saves = 0;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.method, "getSignaturesForAddress");
    const before = request.params[1].before || "first";
    return response(Array.from({ length: 2 }, (_, index) => ({ signature: `${before}-${index}`, err: null })));
  };
  try {
    const watchers = new Watchers({
      config: { solanaRpcHttp: "https://rpc.invalid", solanaPageSize: 2, solanaMaxPages: 2 },
      store: { state: { cursors }, save: async () => { saves += 1; } },
      emit: async () => {}, status: { sources: {} }, report: () => {},
    });
    await assert.rejects(
      watchers.pollSolanaPerson({ id: "p1", solanaAddress: SOL }),
      /SOLANA_CURSOR_GAP/,
    );
    assert.equal(cursors.solana[SOL], "old-watermark");
    assert.equal(saves, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EVM catch-up starts immediately after the durable cursor instead of jumping", async () => {
  const originalFetch = globalThis.fetch;
  const requestedBlocks = [];
  const wallet = "0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28";
  const store = {
    state: { cursors: { solana: {}, evm: { bsc: { blockNumber: "700", blockHash: "0xhash700" } }, relay: {}, gmgn: {} } },
    activeTargets: () => [{ id: "target", chain: "bsc", address: wallet, people: [{ id: "p1" }] }],
    save: async () => {},
  };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === "eth_blockNumber") return response("0x3e8"); // 1000
    if (request.method === "eth_getLogs") return response([]);
    if (request.method === "eth_getBlockByNumber") {
      const number = request.params[0];
      requestedBlocks.push(number);
      if (number === "0x2bc") return response({ number, hash: "0xhash700" });
      const height = BigInt(number);
      return response({ number, hash: `0xhash${height}`, parentHash: height === 701n ? "0xhash700" : `0xhash${height - 1n}`, timestamp: "0x1", transactions: [] });
    }
    throw new Error(`unexpected ${request.method}`);
  };
  try {
    const watchers = new Watchers({
      config: { evmMaxCatchupBlocks: 200, evmMaxBlockRange: 2, entryPointAddresses: [] },
      store, emit: async () => {}, status: { sources: {} }, report: () => {},
    });
    const result = await watchers.pollEvm({ key: "bsc", rpcUrl: "https://rpc.invalid", chainId: 56 });
    assert.equal(result.fromBlock, "701");
    assert.equal(result.toBlock, "702");
    assert.ok(requestedBlocks.includes("0x2bd"));
    assert.equal(store.state.cursors.evm.bsc.blockNumber, "702");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired external delivery leases are listed and can be reclaimed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-lease-"));
  let store;
  try {
    store = new Store(directory, { databaseFile: path.join(directory, "monitor.sqlite3") });
    await store.load();
    store.database.notificationRecipients = [{ channel: "webhook", recipient: "test" }];
    const person = await store.upsertPerson({ handle: "lease-kol", solanaAddress: SOL });
    await store.addOrMergeEvent({
      personId: person.id, kind: "trade", state: "confirmed", source: "gmgn-portfolio",
      chain: "solana", wallet: SOL, txHash: "lease-sig", side: "buy",
      token: { address: "mint", symbol: "T" }, origin: "live", notificationEligible: true,
    });
    const [intent] = store.database.listDeliverableNotifications();
    assert.equal(intent.channel, "webhook");
    assert.ok(store.database.claimNotification(intent.id, "worker-a", 1));
    store.database.db.prepare("UPDATE notification_outbox SET lease_until=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", intent.id);
    assert.equal(store.database.listDeliverableNotifications()[0].id, intent.id);
    const reclaimed = store.database.claimNotification(intent.id, "worker-b");
    assert.equal(reclaimed.leaseOwner, "worker-b");
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
