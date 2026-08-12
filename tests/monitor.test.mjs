import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  USER_OPERATION_EVENT,
  addressTopic,
  classifySolanaTransaction,
  classifyDirectEvmTransaction,
  decodeUserOperationReceipt,
  normalizeRelayRequest,
  normalizePerson,
  parseFomoscanHtml,
  parseImport,
} from "../monitor/core.mjs";
import { counterpartFromRequests } from "../monitor/resolver.mjs";
import { metricsFromPair, pickDexPair, selectEventToken } from "../monitor/enricher.mjs";
import { GmgnWatcher, aggregatePortfolioActivities, gmgnChildEnvironment, parseGmgnOutput, portfolioActivityFingerprint, reconcileTradeSets } from "../monitor/gmgn.mjs";
import { deriveWebSocketUrl } from "../monitor/realtime.mjs";
import { Store } from "../monitor/store.mjs";
import { getLogsAdaptive, mapConcurrent } from "../monitor/watchers.mjs";

const SOL = "498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ";
const EVM = "0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28";

test("large target polling is bounded by the configured concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapConcurrent(Array.from({ length: 40 }, (_, index) => index), 4, async (value) => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });
  assert.equal(maximum, 4);
  assert.equal(results.length, 40);
  assert.equal(results.every((item) => item.status === "fulfilled"), true);
});

test("imports CSV watchlists", () => {
  const rows = parseImport(`handle,twitter,solanaAddress,evmAddress\nfrankdegods,@frankdegods,${SOL},${EVM}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handle, "frankdegods");
  assert.equal(rows[0].evmAddress, EVM);
});

test("extracts public wallet links", () => {
  const parsed = parseFomoscanHtml(`<a href="https://solscan.io/account/${SOL}">sol</a><a href="https://etherscan.io/address/${EVM}">evm</a>`);
  assert.deepEqual(parsed, { solanaAddress: SOL, evmAddress: EVM });
});

test("pairs Solana and EVM through a fomo Relay request", () => {
  const result = counterpartFromRequests({ solanaAddress: SOL, evmAddress: "" }, [{ id: "r1", referrer: "fomo", user: SOL, recipient: EVM, protocol: { deposit: { origin: { chainId: 792703809 } }, settlement: { destination: { fills: [{ chainId: 56, transactionId: "0xtx" }] } } } }]);
  assert.equal(result.evmAddress, EVM);
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.candidates.map(({ chain, addressRole }) => ({ chain, addressRole })), [{ chain: "bsc", addressRole: "vault" }]);
});

test("keeps resolver evidence when a person is updated", () => {
  const existing = { id: "p1", handle: "frankdegods", evidence: [] };
  const evidence = [{ type: "relay-fomo-request", requestId: "r1" }];
  const updated = normalizePerson({ ...existing, evidence }, existing);
  assert.deepEqual(updated.evidence, evidence);
});

test("uses the handle when an optional display name is empty", () => {
  const person = normalizePerson({ name: "", handle: "frankdegods" });
  assert.equal(person.name, "frankdegods");
});

test("classifies Relay DepositToken as an early intent", () => {
  const transaction = {
    blockTime: 1785762283,
    transaction: { message: {
      accountKeys: [{ pubkey: SOL, signer: true }],
      instructions: [{ programId: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2" }],
    } },
    meta: {
      logMessages: ["Program log: Instruction: DepositToken"],
      preTokenBalances: [{ owner: SOL, mint: "USDC", uiTokenAmount: { uiAmountString: "2500", decimals: 6 } }],
      postTokenBalances: [{ owner: SOL, mint: "USDC", uiTokenAmount: { uiAmountString: "0", decimals: 6 } }],
    },
  };
  const event = classifySolanaTransaction(transaction, SOL, "sig");
  assert.equal(event.type, "RELAY_INTENT");
  assert.equal(event.stage, "INTENT_SEEN");
  assert.equal(event.tokenDeltas[0].delta, "-2500");
});

test("normalizes a Relay route and destination token", () => {
  const request = {
    id: "r1", status: "success", referrer: "fomo", user: SOL, recipient: EVM,
    createdAt: "2026-08-03T13:04:44.785Z", updatedAt: "2026-08-03T13:04:52.157Z",
    protocol: {
      deposit: { origin: { chainId: 792703809, currency: "USDC", amount: "2500000000", transactionId: "sig" } },
      settlement: { destination: { fills: [{ chainId: 56, transactionId: "0xtarget" }] } },
    },
    data: { outTxs: [{ chainId: 56, stateChanges: [{ address: EVM, change: { balanceDiff: "100", data: { tokenAddress: "0xtoken" } } }] }] },
  };
  const event = normalizeRelayRequest(request, { id: "p1" });
  assert.equal(event.stage, "SETTLED");
  assert.equal(event.destination.token, "0xtoken");
});

test("isolates ERC-4337 transfers around a UserOperationEvent", () => {
  const sender = addressTopic(EVM);
  const receipt = {
    transactionHash: "0xabc", status: "0x1",
    logs: [
      { logIndex: "0x1", address: "0xtoken", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", addressTopic("0x1111111111111111111111111111111111111111"), sender], data: "0x64" },
      { logIndex: "0x2", topics: [USER_OPERATION_EVENT, "0xhash", sender] },
    ],
  };
  const event = decodeUserOperationReceipt(receipt, receipt.logs[1], { evmAddress: EVM }, { key: "bnb", chainId: 56 });
  assert.equal(event.transfers.length, 1);
  assert.equal(event.transfers[0].direction, "IN");
  assert.equal(event.transfers[0].amount, "100");
});

test("selects the destination token for Relay enrichment", () => {
  const selected = selectEventToken({
    chain: "relay",
    destination: { chainId: 56, token: EVM, amount: "1000000000000000000" },
  });
  assert.equal(selected.address, EVM);
  assert.equal(selected.chain, "bsc");
});

test("selects a GMGN trade token for market enrichment", () => {
  const selected = selectEventToken({
    chain: "bnb",
    direction: "IN",
    token: { address: EVM, symbol: "MEME" },
  });
  assert.deepEqual(selected, { address: EVM, chain: "bsc", amountUi: undefined, direction: "IN" });
});

test("picks the deepest matching DexScreener pair and exposes market metrics", () => {
  const pairs = [
    { chainId: "base", baseToken: { address: EVM, symbol: "TEST", name: "Test" }, quoteToken: { address: "0x1111111111111111111111111111111111111111" }, liquidity: { usd: 100 }, priceUsd: "0.5", fdv: 1000, url: "low" },
    { chainId: "base", baseToken: { address: EVM, symbol: "TEST", name: "Test" }, quoteToken: { address: "0x1111111111111111111111111111111111111111" }, liquidity: { usd: 5000 }, priceUsd: "0.5", marketCap: 2000, url: "high" },
  ];
  const pair = pickDexPair(pairs, EVM, "base");
  const metrics = metricsFromPair(pair, EVM);
  assert.equal(pair.url, "high");
  assert.equal(metrics.symbol, "TEST");
  assert.equal(metrics.marketCap, 2000);
});

test("aggregates exact-wallet GMGN portfolio activity legs", () => {
  const payload = parseGmgnOutput(`gmgn-cli\n${JSON.stringify({ activities: [
    {
      wallet: SOL, chain: "sol", tx_hash: "sig", timestamp: 1785773506, event_type: "sell",
      token: { address: "Fvvj98QtaA3RjVgeQn79NokiMaLgBRje1Q9bXetwpump", symbol: "Nongwan" },
      token_amount: "1397102.475115", quote_amount: "9.181291874", cost_usd: "675.10039149522",
      price_usd: "0.000483214655701026", is_open_or_close: 1,
    },
    {
      wallet: SOL, chain: "sol", tx_hash: "sig", timestamp: 1785773506, event_type: "sell",
      token: { address: "Fvvj98QtaA3RjVgeQn79NokiMaLgBRje1Q9bXetwpump", symbol: "Nongwan" },
      token_amount: "3350274.24577", quote_amount: "21.493872391", cost_usd: "1580.44443691023",
      price_usd: "0.00047173584040065", is_open_or_close: 1,
    },
  ] })}`);
  const [event] = aggregatePortfolioActivities(payload.activities, { id: "p1", solanaAddress: SOL }, "sol", { observedAt: "2026-08-03T16:11:58.000Z" });
  assert.equal(event.chain, "solana");
  assert.equal(event.direction, "OUT");
  assert.equal(event.valueUsd, "2255.54482840545");
  assert.equal(event.tokenAmount, "4747376.720885");
  assert.equal(event.token.symbol, "Nongwan");
  assert.equal(event.positionAction, "FULL_CLOSE");
  assert.equal(event.legCount, 2);
  assert.notEqual(portfolioActivityFingerprint(payload.activities[0]), portfolioActivityFingerprint(payload.activities[1]));
});

test("reconciliation compares stable identities and exact economic fields", () => {
  const source = [{ chain: "solana", wallet: SOL, txHash: "sig", side: "sell", token: { address: "mint" }, tokenAmount: "4747376.720885", quoteAmount: "30.675164265", valueUsd: "2255.54482840545" }];
  const exact = reconcileTradeSets(source, [{ ...source[0], valueUsd: "2255.5448284054500" }]);
  assert.deepEqual({ matched: exact.matched, missing: exact.missing, extra: exact.extra, mismatched: exact.mismatched }, { matched: 1, missing: 0, extra: 0, mismatched: 0 });
  const wrong = reconcileTradeSets(source, [{ ...source[0], tokenAmount: "1" }]);
  assert.equal(wrong.mismatched, 1);
  assert.deepEqual(wrong.items[0].differences.tokenAmount, { expected: "4747376.720885", actual: "1" });
});

test("detects a direct EVM vault transaction without ERC-4337", () => {
  const walletTopic = addressTopic(EVM);
  const token = "0x1111111111111111111111111111111111111111";
  const receipt = {
    transactionHash: "0xtrade",
    logs: [{
      address: token,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", addressTopic("0x2222222222222222222222222222222222222222"), walletTopic],
      data: "0x64",
    }],
  };
  const transaction = { hash: "0xtrade", from: EVM, to: "0x3333333333333333333333333333333333333333", input: "0xabcdef12", value: "0x10" };
  const event = classifyDirectEvmTransaction(transaction, receipt, { id: "p1", evmAddress: EVM }, { key: "bnb", chainId: 56 }, "2026-08-03T15:24:58.000Z");
  assert.equal(event.state, "hint");
  assert.equal(event.probableSide, "buy");
  assert.equal(event.sender, EVM);
});

test("removes intermediate route assets from an exact-wallet trade", () => {
  const rows = [
    { wallet: EVM, tx_hash: "0xroute", timestamp: 1785770698, event_type: "buy", token: { address: "0xintermediate", symbol: "NVDAB" }, quote_address: "0xusdt", token_amount: "5.6", quote_amount: "1167.9", cost_usd: "1167.9" },
    { wallet: EVM, tx_hash: "0xroute", timestamp: 1785770698, event_type: "buy", token: { address: "0xfinal", symbol: "JACKET" }, quote_address: "0xintermediate", token_amount: "165490", quote_amount: "5.6", cost_usd: "1163.1" },
  ];
  const events = aggregatePortfolioActivities(rows, { id: "p1", evmAddress: EVM }, "bsc");
  assert.equal(events.length, 1);
  assert.equal(events[0].token.symbol, "JACKET");
  assert.equal(events[0].valueUsd, "1163.1");
  assert.equal(events[0].routeLegCount, 2);
});

test("GMGN watcher queries each imported wallet through portfolio activity", async () => {
  const calls = [];
  const emitted = [];
  const person = { id: "p1", name: "frank", enabled: true, solanaAddress: SOL, evmAddress: EVM };
  const store = {
    state: { cursors: { gmgn: {} }, events: [] },
    listPeople: () => [person],
    save: async () => {},
  };
  const watcher = new GmgnWatcher({
    config: {
      gmgnCliPath: "gmgn-cli", gmgnChains: ["sol"], gmgnLimit: 20, gmgnMaxPages: 2,
      gmgnLookbackSeconds: 600, gmgnConcurrency: 1, gmgnRequestsPerSecond: 8,
      gmgnCommandTimeoutMs: 1000, gmgnPollIntervalMs: 5000, subscriptionRefreshMs: 15000,
    },
    store,
    emit: async (event) => { emitted.push(event); return event; },
    report: () => {},
    runner: async (_command, args) => {
      calls.push(args);
      return JSON.stringify({ activities: [{
        wallet: SOL, chain: "sol", tx_hash: "sig", timestamp: 1785773506, event_type: "buy",
        token: { address: "mint", symbol: "MEME" }, token_amount: "10", quote_amount: "1", cost_usd: "100",
      }], next: "" });
    },
  });
  const result = await watcher.backfillPerson(person);
  assert.deepEqual(calls[0].slice(0, 6), ["portfolio", "activity", "--chain", "sol", "--wallet", SOL]);
  assert.equal(result.added, 1);
  assert.equal(emitted[0].historical, true);
});

test("derives websocket URLs but preserves explicit provider URLs", () => {
  assert.equal(deriveWebSocketUrl("https://api.mainnet-beta.solana.com"), "wss://api.mainnet-beta.solana.com/");
  assert.equal(deriveWebSocketUrl("https://mainnet.base.org", "wss://paid.example/ws"), "wss://paid.example/ws");
});

test("splits EVM log ranges when a provider rejects a large query", async () => {
  let calls = 0;
  const logs = await getLogsAdaptive(async (filter) => {
    calls += 1;
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    if (to > from) throw new Error("limit exceeded");
    return [{ blockNumber: filter.fromBlock }];
  }, { address: "0xentry" }, 10n, 13n);
  assert.equal(logs.length, 4);
  assert.ok(calls > 4);
});

test("an incomplete GMGN window keeps its watermark and resumes pagination", async () => {
  const pages = [];
  const emitted = [];
  const person = { id: "p1", name: "large-wallet", enabled: true, solanaAddress: SOL };
  const store = {
    state: { cursors: { gmgn: { "target:sol": { watermarkTimestamp: 100, seen: [] } } }, events: [] },
    activeTargets: () => [{ id: "target:sol", chain: "solana", address: SOL, people: [person] }],
    save: async () => {},
  };
  const watcher = new GmgnWatcher({
    config: { gmgnCliPath: "gmgn-cli", gmgnChains: ["sol"], gmgnLimit: 1, gmgnMaxPages: 1, gmgnLookbackSeconds: 60, gmgnConcurrency: 1, gmgnRequestsPerSecond: 8, gmgnCommandTimeoutMs: 1000, gmgnPollIntervalMs: 5000, subscriptionRefreshMs: 15000 },
    store,
    emit: async (event) => { emitted.push(event); return event; },
    report: () => {},
    runner: async (_command, args) => {
      const cursorIndex = args.indexOf("--cursor");
      const cursor = cursorIndex >= 0 ? args[cursorIndex + 1] : "";
      pages.push(cursor);
      return JSON.stringify({ activities: [{ wallet: SOL, tx_hash: cursor ? "sig-old" : "sig-new", timestamp: cursor ? 110 : 200, event_type: "buy", token: { address: "mint", symbol: "MEME" }, token_amount: "1", quote_amount: "1", cost_usd: "1" }], next: cursor ? "" : "page-2" });
    },
  });
  watcher.stopped = false;
  watcher.targets.set("target:sol", { id: "target:sol", chain: "sol", wallet: SOL, person, running: false, failures: 0, timer: null });
  await watcher.pollTarget(watcher.targets.get("target:sol"));
  assert.equal(store.state.cursors.gmgn["target:sol"].watermarkTimestamp, 100);
  assert.equal(store.state.cursors.gmgn["target:sol"].continuationCursor, "page-2");
  await watcher.pollTarget(watcher.targets.get("target:sol"));
  assert.deepEqual(pages, ["", "page-2"]);
  assert.equal(store.state.cursors.gmgn["target:sol"].watermarkTimestamp, 200);
  assert.equal(store.state.cursors.gmgn["target:sol"].continuationCursor, undefined);
  assert.equal(emitted.length, 2);
});

test("GMGN child processes receive only an explicit non-secret environment", () => {
  const environment = gmgnChildEnvironment({
    PATH: "bin", APPDATA: "app", GMGN_API_KEY: "gmgn", MONITOR_MASTER_KEY: "master",
    TELEGRAM_BOT_TOKEN: "telegram", WEBHOOK_URL: "https://secret.test", BNB_RPC_HTTP: "https://rpc-key.test",
  });
  assert.deepEqual(environment, { PATH: "bin", APPDATA: "app", GMGN_API_KEY: "gmgn" });
});

test("a new target only suppresses activity before its notification fence", async () => {
  const emitted = [];
  const person = { id: "p-fence", name: "fenced-wallet", enabled: true, solanaAddress: SOL };
  const store = {
    state: { cursors: { gmgn: {} }, events: [] },
    activeTargets: () => [], save: async () => {},
    subscriptionFence: () => new Date(150 * 1000).toISOString(),
  };
  const watcher = new GmgnWatcher({
    config: { gmgnCliPath: "gmgn-cli", gmgnChains: ["sol"], gmgnLimit: 10, gmgnMaxPages: 1, gmgnLookbackSeconds: 60, gmgnConcurrency: 1, gmgnRequestsPerSecond: 8, gmgnCommandTimeoutMs: 1000, gmgnPollIntervalMs: 5000, subscriptionRefreshMs: 15000 },
    store, emit: async (event) => { emitted.push(event); return event; }, report: () => {},
    runner: async () => JSON.stringify({ activities: [
      { wallet: SOL, tx_hash: "sig-before", timestamp: 140, event_type: "buy", token: { address: "mint-old", symbol: "OLD" }, token_amount: "1", quote_amount: "1", cost_usd: "1" },
      { wallet: SOL, tx_hash: "sig-after", timestamp: 160, event_type: "buy", token: { address: "mint-new", symbol: "NEW" }, token_amount: "1", quote_amount: "1", cost_usd: "1" },
    ], next: "" }),
  });
  watcher.stopped = false;
  const target = { id: "target:fence", chain: "sol", wallet: SOL, person, running: false, failures: 0, timer: null };
  watcher.targets.set(target.id, target);
  await watcher.pollTarget(target);
  assert.equal(emitted.find((event) => event.txHash === "sig-before").historical, true);
  assert.equal(emitted.find((event) => event.txHash === "sig-after").historical, false);
  assert.equal(emitted.find((event) => event.txHash === "sig-after").notificationEligible, true);
});

test("merges GMGN enrichment with an existing chain event by transaction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-store-"));
  let store;
  try {
    store = new Store(directory);
    await store.load();
    await store.addOrMergeEvent({
      key: "solana:sig", dedupeKey: "solana:sig", personId: "p1", source: "solana-ws",
      kind: "activity", state: "hint", chain: "solana",
      txHash: "sig", timestamp: new Date().toISOString(),
    });
    const merged = await store.addOrMergeEvent({
      key: "trade:solana:sig:mint:buy", dedupeKey: "trade:solana:sig:mint:buy", correlationKey: "solana:sig",
      personId: "p1", source: "gmgn", kind: "trade", state: "confirmed", chain: "solana", side: "buy",
      txHash: "sig", token: { address: "mint", symbol: "MEME" }, timestamp: new Date().toISOString(), notificationEligible: false,
    });
    assert.equal(merged.isNew, true);
    const trade = store.database.getTrade(merged.record.id);
    assert.equal(trade.token.symbol, "MEME");
    assert.equal(trade.observations.length, 2);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical trades are always marked skipped and never notification eligible", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-store-"));
  let store;
  try {
    store = new Store(directory);
    await store.load();
    const result = await store.addOrMergeEvent({
      key: "gmgn:solana:old", dedupeKey: "solana:old:p1", personId: "p1",
      kind: "trade", state: "historical", historical: true,
      notificationStatus: "pending", notificationEligible: true,
      source: "gmgn-portfolio", txHash: "old", timestamp: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(result.record.notificationStatus, "skipped");
    assert.equal(result.record.notificationEligible, false);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite remains valid across repeated cursor commits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-store-"));
  let store;
  try {
    store = new Store(directory);
    await store.load();
    for (let index = 0; index < 12; index += 1) {
      store.state.cursors.solana.wallet = `sig-${index}`;
      await store.save();
      assert.equal(store.database.integrityCheck(), "ok");
    }
    assert.equal(store.database.scalar("SELECT COUNT(*) FROM source_cursors"), 1);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
