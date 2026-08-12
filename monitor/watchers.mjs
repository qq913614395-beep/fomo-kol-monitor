import {
  USER_OPERATION_EVENT,
  addressTopic,
  classifyDirectEvmTransaction,
  classifySolanaTransaction,
  decodeUserOperationReceipt,
  normalizeRelayRequest,
} from "./core.mjs";
import { fetchRelayRequests } from "./resolver.mjs";

export async function rpc(url, method, params, timeoutMs = 12_000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  return payload.result;
}

export async function chainRpc(chain, method, params, timeoutMs = 12_000) {
  try {
    return await rpc(chain.rpcUrl, method, params, timeoutMs);
  } catch (error) {
    if (!chain.fallbackRpcUrl || chain.fallbackRpcUrl === chain.rpcUrl) throw error;
    return rpc(chain.fallbackRpcUrl, method, params, timeoutMs);
  }
}

export async function mapConcurrent(items, concurrency, task) {
  const source = Array.from(items || []);
  const results = new Array(source.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), source.length) }, async () => {
    while (cursor < source.length) {
      const index = cursor++;
      try { results[index] = { status: "fulfilled", value: await task(source[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  });
  await Promise.all(workers);
  return results;
}

function evmBlockTime(block) {
  if (!block?.timestamp) return new Date().toISOString();
  return new Date(Number.parseInt(block.timestamp, 16) * 1000).toISOString();
}

function hexBlock(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function canonicalRelayDestination(event, personId) {
  const chain = ({ 1: "eth", 56: "bnb", 143: "monad", 8453: "base", 792703809: "solana" })[event.destination.chainId];
  const hash = event.destination.txHash;
  if (!chain || !hash) return "";
  return `${chain}:${chain === "solana" ? hash : String(hash).toLowerCase()}:${personId}`;
}

function actorForTarget(target) {
  const primary = target.people?.[0] || {};
  return {
    ...primary,
    id: primary.id,
    targetId: target.id,
    kolIds: (target.people || []).map((person) => person.id),
    wallet: target.address,
    solanaAddress: target.chain === "solana" ? target.address : "",
    evmAddress: target.chain === "solana" ? "" : target.address,
  };
}

export async function getLogsAdaptive(rpcCall, filter, from, to) {
  try {
    return await rpcCall({ ...filter, fromBlock: hexBlock(from), toBlock: hexBlock(to) });
  } catch (error) {
    if (from >= to) throw error;
    const middle = (from + to) / 2n;
    const [left, right] = await Promise.all([
      getLogsAdaptive(rpcCall, filter, from, middle),
      getLogsAdaptive(rpcCall, filter, middle + 1n, to),
    ]);
    return [...left, ...right];
  }
}

export class Watchers {
  constructor({ config, store, emit, status, report }) {
    this.config = config;
    this.store = store;
    this.emit = emit;
    this.status = status;
    this.report = report || ((source, value) => { this.status.sources[source] = value; });
    this.timers = new Set();
    this.failures = new Map();
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.schedule("solana_poll", 0, this.config.pollIntervalMs, () => this.pollSolana());
    this.config.evmChains.filter((chain) => chain.rpcUrl).forEach((chain, index) => {
      this.schedule(`${chain.key}_poll`, 300 + index * 350, this.config.evmPollIntervalMs, () => this.pollEvm(chain));
    });
    this.schedule("relay", 700, this.config.relayPollIntervalMs, () => this.pollRelay());
  }

  schedule(source, delay, interval, task) {
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      if (this.stopped) return;
      const started = Date.now();
      try {
        const detail = await task();
        this.status.lastPollAt = new Date().toISOString();
        this.failures.set(source, 0);
        this.report(source, "connected", { transport: "poll", durationMs: Date.now() - started, consecutiveFailures: 0, errorCode: null, errorMessage: null, nextRetryAt: null, ...detail });
      } catch (error) {
        const message = error.message || String(error);
        const failures = (this.failures.get(source) || 0) + 1;
        this.failures.set(source, failures);
        const errorCode = /429|rate limit/i.test(message) ? "RPC_RATE_LIMITED" : /timeout|aborted/i.test(message) ? "RPC_TIMEOUT" : "COLLECTOR_FAILED";
        this.status.error = message;
        this.status.lastErrorAt = new Date().toISOString();
        this.report(source, `error: ${message}`, { transport: "poll", health: "degraded", durationMs: Date.now() - started, errorCode, errorMessage: message, consecutiveFailures: failures, nextRetryAt: new Date(Date.now() + interval).toISOString() });
      } finally {
        if (!this.stopped) this.schedule(source, interval, interval, task);
      }
    }, delay);
    timer.unref?.();
    this.timers.add(timer);
  }

  async poll() {
    const results = await Promise.allSettled([
      this.pollSolana(),
      ...this.config.evmChains.filter((chain) => chain.rpcUrl).map((chain) => this.pollEvm(chain)),
      this.pollRelay(),
    ]);
    this.status.lastPollAt = new Date().toISOString();
    return results;
  }

  async pollSolanaPerson(person) {
    const address = person.solanaAddress;
    if (!address) return 0;
    let cursor = this.store.state.cursors.solana[address];
    let before;
    const fresh = [];
    let newest = "";
    let cursorFound = false;
    let reachedHistoryEnd = false;
    for (let page = 0; page < this.config.solanaMaxPages; page += 1) {
      const options = { limit: this.config.solanaPageSize };
      if (before) options.before = before;
      const signatures = await rpc(this.config.solanaRpcHttp, "getSignaturesForAddress", [address, options]);
      if (!signatures?.length) {
        reachedHistoryEnd = true;
        break;
      }
      newest ||= signatures[0].signature;
      if (!cursor && !this.config.backfillOnFirstRun) {
        this.store.state.cursors.solana[address] = newest;
        return 0;
      }
      let found = false;
      for (const item of signatures) {
        if (item.signature === cursor) {
          found = true;
          cursorFound = true;
          break;
        }
        if (!item.err) fresh.push(item);
      }
      if (found || signatures.length < this.config.solanaPageSize) {
        if (!found) reachedHistoryEnd = true;
        break;
      }
      before = signatures.at(-1)?.signature;
    }
    // The page cap is a safety limit, not permission to skip the unscanned
    // part of the signature stream.  Keep the old cursor so the next poll can
    // retry with a larger window (or after operator intervention).
    if (cursor && !cursorFound && !reachedHistoryEnd) {
      throw new Error(`SOLANA_CURSOR_GAP: did not reach ${cursor} within ${this.config.solanaMaxPages} pages for ${address}`);
    }
    for (const item of fresh.reverse()) {
      const transaction = await rpc(this.config.solanaRpcHttp, "getTransaction", [item.signature, {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      }]);
      if (!transaction) throw new Error(`getTransaction returned null for ${item.signature}`);
      const event = classifySolanaTransaction(transaction, address, item.signature);
      if (event.type !== "ACTIVITY") {
        await this.emit({
          ...event,
          personId: person.id,
          kolIds: person.kolIds || [person.id],
          targetId: person.targetId,
          wallet: address,
          source: "solana-poll",
          sources: ["solana-poll"],
          dedupeKey: `solana:${address}:${item.signature}`,
        }, person);
      }
    }
    if (newest) this.store.state.cursors.solana[address] = newest;
    return fresh.length;
  }

  async pollSolana() {
    if (!this.config.solanaRpcHttp) return { monitored: 0 };
    const people = this.store.activeTargets().filter((target) => target.chain === "solana").map(actorForTarget);
    const results = await mapConcurrent(people, this.config.rpcConcurrency || 8, (person) => this.pollSolanaPerson(person));
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length) throw new Error(errors.map((result) => result.reason?.message || result.reason).join("; "));
    await this.store.save();
    return { monitored: people.length, eventsFound: results.reduce((sum, result) => sum + (result.value || 0), 0) };
  }

  async pollEvm(chain) {
    const people = this.store.activeTargets().filter((target) => target.chain === chain.key).map(actorForTarget);
    const latest = BigInt(await chainRpc(chain, "eth_blockNumber", []));
    const cursorState = this.store.state.cursors.evm[chain.key];
    let existing = typeof cursorState === "object" ? cursorState.blockNumber : cursorState;
    let previousHash = typeof cursorState === "object" ? cursorState.blockHash : "";
    let reorgDetected = false;
    if (!existing || people.length === 0) {
      const head = await chainRpc(chain, "eth_getBlockByNumber", [hexBlock(latest), false]);
      this.store.state.cursors.evm[chain.key] = { blockNumber: latest.toString(), blockHash: head?.hash || "" };
      await this.store.save();
      return { monitored: people.length, block: latest.toString(), eventsFound: 0 };
    }
    if (previousHash) {
      const cursorBlock = await chainRpc(chain, "eth_getBlockByNumber", [hexBlock(BigInt(existing)), false]);
      if (!cursorBlock || String(cursorBlock.hash).toLowerCase() !== String(previousHash).toLowerCase()) {
        existing = (BigInt(existing) > 12n ? BigInt(existing) - 12n : 0n).toString();
        const rewindBlock = await chainRpc(chain, "eth_getBlockByNumber", [hexBlock(BigInt(existing)), false]);
        previousHash = rewindBlock?.hash || "";
        reorgDetected = true;
      }
    }
    const from = BigInt(existing) + 1n;
    if (from > latest) return { monitored: people.length, block: latest.toString(), eventsFound: 0 };
    const configuredRange = BigInt(this.config.evmMaxBlockRange);
    const to = from + configuredRange - 1n < latest ? from + configuredRange - 1n : latest;
    const personByTopic = new Map(people.map((person) => [addressTopic(person.evmAddress).toLowerCase(), person]));
    const personByAddress = new Map(people.map((person) => [person.evmAddress.toLowerCase(), person]));
    const topics = [...personByTopic.keys()];
    const blocks = new Map();
    let directEvents = 0;
    for (let blockNumber = from; blockNumber <= to; blockNumber += 1n) {
      const number = hexBlock(blockNumber);
      const block = await chainRpc(chain, "eth_getBlockByNumber", [number, true]);
      if (!block) throw new Error(`block unavailable for ${number}`);
      if (previousHash && String(block.parentHash || "").toLowerCase() !== String(previousHash).toLowerCase()) throw new Error(`EVM_REORG_CONTINUITY: ${chain.key} block ${number} does not extend the processed hash`);
      blocks.set(number, block);
      previousHash = block.hash || previousHash;
      const timestamp = evmBlockTime(block);
      for (const transaction of block.transactions || []) {
        const person = personByAddress.get(String(transaction.from || "").toLowerCase());
        if (!person) continue;
        const receipt = await chainRpc(chain, "eth_getTransactionReceipt", [transaction.hash]);
        if (!receipt) continue;
        const event = classifyDirectEvmTransaction(transaction, receipt, person, chain, timestamp);
        if (!event) continue;
        await this.emit({
          ...event,
          personId: person.id,
          kolIds: person.kolIds || [person.id],
          targetId: person.targetId,
          wallet: person.evmAddress,
          source: `${chain.key}-poll`,
          sources: [`${chain.key}-poll`],
          observations: [{ source: `${chain.key}-poll`, observedAt: new Date().toISOString() }],
        }, person);
        directEvents += 1;
      }
    }
    // Some public RPCs reject an address array even for a single block. Query
    // each supported EntryPoint independently, then merge the ordered logs.
    // A failed EntryPoint scan makes the whole range incomplete. Direct
    // transactions emitted above are idempotent and can safely be replayed;
    // advancing here would permanently skip UserOperations in this range.
    const logGroups = await Promise.all(this.config.entryPointAddresses.map((entryPoint) => getLogsAdaptive(
      (nextFilter) => chainRpc(chain, "eth_getLogs", [nextFilter]),
      {
        address: entryPoint,
        topics: [USER_OPERATION_EVENT, null, topics.length === 1 ? topics[0] : topics],
      },
      from,
      to,
    )));
    const logs = logGroups.flat().sort((a, b) => {
      const blockDelta = Number.parseInt(a.blockNumber || "0x0", 16) - Number.parseInt(b.blockNumber || "0x0", 16);
      return blockDelta || Number.parseInt(a.logIndex || "0x0", 16) - Number.parseInt(b.logIndex || "0x0", 16);
    });
    for (const log of logs || []) {
      const person = personByTopic.get(String(log.topics?.[2] || "").toLowerCase());
      if (!person) continue;
      const [receipt, block] = await Promise.all([
        chainRpc(chain, "eth_getTransactionReceipt", [log.transactionHash]),
        blocks.has(log.blockNumber)
          ? blocks.get(log.blockNumber)
          : chainRpc(chain, "eth_getBlockByNumber", [log.blockNumber, false]).then((value) => {
            blocks.set(log.blockNumber, value);
            return value;
          }),
      ]);
      if (!receipt) throw new Error(`receipt unavailable for ${log.transactionHash}`);
      const event = decodeUserOperationReceipt(receipt, log, person, chain);
      await this.emit({
        ...event,
        timestamp: evmBlockTime(block),
        personId: person.id,
        kolIds: person.kolIds || [person.id],
        targetId: person.targetId,
        wallet: person.evmAddress,
        source: `${chain.key}-poll`,
        sources: [`${chain.key}-poll`],
        observations: [{ source: `${chain.key}-poll`, observedAt: new Date().toISOString() }],
        dedupeKey: `${chain.key}:${person.evmAddress.toLowerCase()}:${log.transactionHash.toLowerCase()}`,
      }, person);
    }
    // Advance only after the complete block range was fetched and processed.
    this.store.state.cursors.evm[chain.key] = { blockNumber: to.toString(), blockHash: previousHash };
    await this.store.save();
    return {
      monitored: people.length,
      fromBlock: from.toString(),
      toBlock: to.toString(),
      blockLag: Number(latest - to),
      eventsFound: directEvents + (logs?.length || 0),
      directEvents,
      entrypointError: "",
      reorgDetected,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async pollRelayAddress(address, person) {
    const requests = await fetchRelayRequests(this.config, address, this.config.relayPageSize);
    const fomo = requests.filter((request) => String(request.referrer).toLowerCase() === "fomo");
    const cursor = this.store.state.cursors.relay[address];
    if (!cursor && !this.config.backfillOnFirstRun) {
      this.store.state.cursors.relay[address] = fomo[0]?.id || "initialized";
      return 0;
    }
    const fresh = [];
    for (const request of fomo) {
      if (request.id === cursor) break;
      fresh.push(request);
    }
    for (const request of fresh.reverse()) {
      const event = normalizeRelayRequest(request, person);
      await this.emit({
        ...event,
        source: "relay",
        sources: ["relay"],
        dedupeKey: canonicalRelayDestination(event, person.id),
      }, person);
    }
    if (fomo[0]?.id) this.store.state.cursors.relay[address] = fomo[0].id;
    return fresh.length;
  }

  async pollRelay() {
    const entries = this.store.activeTargets().map((target) => ({ address: target.address, person: actorForTarget(target) }));
    const results = await mapConcurrent(entries, this.config.relayConcurrency || 4, ({ address, person }) => this.pollRelayAddress(address, person));
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length) throw new Error(errors.map((result) => result.reason?.message || result.reason).join("; "));
    await this.store.save();
    return { monitored: entries.length, eventsFound: results.reduce((sum, result) => sum + (result.value || 0), 0) };
  }

  async backfillPerson(person, limit = 10) {
    const addresses = [...new Set((person.bindings || []).filter((binding) => binding.verificationState === "verified" && binding.desiredState === "enabled").map((binding) => binding.address))];
    let added = 0;
    let scanned = 0;
    const errors = [];
    for (const address of addresses) {
      try {
        const requests = await fetchRelayRequests(this.config, address, Math.max(1, Math.min(limit, 25)));
        const fomo = requests.filter((request) => String(request.referrer).toLowerCase() === "fomo").slice(0, limit);
        scanned += fomo.length;
        for (const request of fomo.reverse()) {
          const stored = await this.emit({
            ...normalizeRelayRequest(request, person),
            historical: true,
            source: "relay-backfill",
            sources: ["relay-backfill"],
          }, person);
          if (stored) added += 1;
        }
        this.report("relay", "connected", { transport: "backfill" });
      } catch (error) {
        errors.push(error.message);
        this.report("relay", `error: ${error.message}`, { transport: "backfill" });
      }
    }
    return { added, scanned, errors };
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
