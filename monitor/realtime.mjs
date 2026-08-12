import {
  USER_OPERATION_EVENT,
  addressTopic,
  classifyDirectEvmTransaction,
  classifySolanaTransaction,
  decodeUserOperationReceipt,
} from "./core.mjs";
import { chainRpc, rpc } from "./watchers.mjs";

export function deriveWebSocketUrl(httpUrl, explicitUrl = "") {
  if (explicitUrl) return explicitUrl;
  if (!httpUrl) return "";
  try {
    const url = new URL(httpUrl);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return "";
    return url.toString();
  } catch {
    return "";
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function retry(task, attempts = 4, delayMs = 250) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await task();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await wait(delayMs * (attempt + 1));
  }
  if (lastError) throw lastError;
  return null;
}

class JsonRpcSocket {
  constructor({ url, subscriptions, onState }) {
    this.url = url;
    this.subscriptions = subscriptions;
    this.onState = onState;
    this.socket = null;
    this.stopped = true;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    if (typeof globalThis.WebSocket !== "function") {
      this.onState("unavailable: Node WebSocket support is missing");
      return;
    }
    this.onState("connecting");
    const socket = new globalThis.WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      this.reconnectDelay = 1000;
      this.onState("connected");
      for (const subscription of this.subscriptions()) {
        const id = this.nextId++;
        this.pending.set(id, subscription.onEvent);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: subscription.method, params: subscription.params }));
      }
    });
    socket.addEventListener("message", async (event) => {
      try {
        const payload = JSON.parse(typeof event.data === "string" ? event.data : await event.data.text());
        if (payload.id && this.pending.has(payload.id)) {
          const handler = this.pending.get(payload.id);
          this.pending.delete(payload.id);
          if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
          this.handlers.set(payload.result, handler);
          return;
        }
        const subscriptionId = payload.params?.subscription;
        const handler = this.handlers.get(subscriptionId);
        if (handler) Promise.resolve(handler(payload.params?.result)).catch((error) => this.onState(`event error: ${error.message}`));
      } catch (error) {
        this.onState(`message error: ${error.message}`);
      }
    });
    socket.addEventListener("error", () => this.onState("connection error"));
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.pending.clear();
      this.handlers.clear();
      this.socket = null;
      if (this.stopped) return;
      this.onState(`reconnecting in ${this.reconnectDelay}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectTimer.unref?.();
      this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
    });
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close();
    this.pending.clear();
    this.handlers.clear();
  }
}

export class RealtimeWatchers {
  constructor({ config, store, emit, report }) {
    this.config = config;
    this.store = store;
    this.emit = emit;
    this.report = report;
    this.sockets = new Map();
    this.fingerprint = "";
    this.syncTimer = null;
    this.stopped = true;
  }

  start() {
    if (!this.config.enableRpcWebsocket) {
      this.report("websocket", "disabled", { transport: "websocket" });
      return;
    }
    this.stopped = false;
    this.sync();
    this.syncTimer = setInterval(() => this.sync(), this.config.subscriptionRefreshMs);
    this.syncTimer.unref?.();
  }

  sync() {
    if (this.stopped) return;
    const targets = this.store.activeTargets();
    const nextFingerprint = JSON.stringify(targets.map((target) => [target.id, target.chain, target.normalizedAddress, target.people.map((person) => person.id).sort()]));
    if (nextFingerprint === this.fingerprint) return;
    this.fingerprint = nextFingerprint;
    for (const socket of this.sockets.values()) socket.stop();
    this.sockets.clear();
    this.startSolana(targets.filter((target) => target.chain === "solana").map(actorForTarget));
    for (const chain of this.config.evmChains.filter((item) => item.rpcUrl)) {
      this.startEvm(chain, targets.filter((target) => target.chain === chain.key).map(actorForTarget));
    }
  }

  startSolana(people) {
    const url = deriveWebSocketUrl(this.config.solanaRpcHttp, this.config.solanaRpcWs);
    if (!url || people.length === 0) {
      this.report("solana_ws", people.length ? "not configured" : "waiting for address", { transport: "websocket" });
      return;
    }
    const socket = new JsonRpcSocket({
      url,
      subscriptions: () => people.map((person) => ({
        method: "logsSubscribe",
        params: [{ mentions: [person.solanaAddress] }, { commitment: "confirmed" }],
        onEvent: (result) => this.handleSolana(result?.value?.signature, person),
      })),
      onState: (state) => this.report("solana_ws", state, { transport: "websocket", url: new URL(url).host }),
    });
    this.sockets.set("solana", socket);
    socket.start();
  }

  async handleSolana(signature, person) {
    if (!signature) return;
    const transaction = await retry(() => rpc(this.config.solanaRpcHttp, "getTransaction", [signature, {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    }], 5000));
    if (!transaction) throw new Error(`transaction unavailable for ${signature}`);
    const event = classifySolanaTransaction(transaction, person.solanaAddress, signature);
    if (event.type === "ACTIVITY") return;
    await this.emit({
      ...event,
      personId: person.id,
      kolIds: person.kolIds || [person.id],
      targetId: person.targetId,
      wallet: person.solanaAddress,
      source: "solana-ws",
      sources: ["solana-ws"],
      dedupeKey: `solana:${person.solanaAddress}:${signature}`,
    }, person);
    this.report("solana_ws", "connected", { transport: "websocket", lastEventAt: new Date().toISOString() });
  }

  startEvm(chain, people) {
    const url = deriveWebSocketUrl(chain.rpcUrl, chain.wsUrl);
    const source = `${chain.key}_ws`;
    if (!url || people.length === 0) {
      this.report(source, people.length ? "not configured" : "waiting for address", { transport: "websocket" });
      return;
    }
    const personByTopic = new Map(people.map((person) => [addressTopic(person.evmAddress).toLowerCase(), person]));
    const personByAddress = new Map(people.map((person) => [person.evmAddress.toLowerCase(), person]));
    const addressTopics = [...personByTopic.keys()];
    const socket = new JsonRpcSocket({
      url,
      subscriptions: () => [
        {
          method: "eth_subscribe",
          params: ["newHeads"],
          onEvent: (header) => this.handleEvmBlock(chain, header, personByAddress),
        },
        ...this.config.entryPointAddresses.map((entryPoint) => ({
          method: "eth_subscribe",
          params: ["logs", {
            address: entryPoint,
            topics: [USER_OPERATION_EVENT, null, addressTopics.length === 1 ? addressTopics[0] : addressTopics],
          }],
          onEvent: (log) => this.handleEvm(chain, log, personByTopic),
        })),
      ],
      onState: (state) => this.report(source, state, { transport: "websocket", url: new URL(url).host }),
    });
    this.sockets.set(chain.key, socket);
    socket.start();
  }

  async handleEvmBlock(chain, header, personByAddress) {
    if (!header?.hash) return;
    const block = await retry(() => chainRpc(chain, "eth_getBlockByHash", [header.hash, true], 7000));
    if (!block) throw new Error(`block unavailable for ${header.hash}`);
    const timestamp = block.timestamp
      ? new Date(Number.parseInt(block.timestamp, 16) * 1000).toISOString()
      : new Date().toISOString();
    const matches = (block.transactions || []).filter((transaction) =>
      personByAddress.has(String(transaction.from || "").toLowerCase()),
    );
    for (const transaction of matches) {
      const person = personByAddress.get(String(transaction.from).toLowerCase());
      const receipt = await retry(() => chainRpc(chain, "eth_getTransactionReceipt", [transaction.hash], 7000));
      if (!receipt) continue;
      const event = classifyDirectEvmTransaction(transaction, receipt, person, chain, timestamp);
      if (!event) continue;
      await this.emit({
        ...event,
        personId: person.id,
        kolIds: person.kolIds || [person.id],
        targetId: person.targetId,
        wallet: person.evmAddress,
        dedupeKey: `${chain.key}:${person.evmAddress.toLowerCase()}:${transaction.hash.toLowerCase()}`,
      }, person);
      this.report(`${chain.key}_ws`, "connected", {
        transport: "websocket",
        health: "healthy",
        monitoredTargets: personByAddress.size,
        lastCheckedAt: new Date().toISOString(),
        lastTargetEventAt: timestamp,
        lastEventAt: new Date().toISOString(),
      });
    }
  }

  async handleEvm(chain, log, personByTopic) {
    const person = personByTopic.get(String(log?.topics?.[2] || "").toLowerCase());
    if (!person || !log.transactionHash) return;
    const [receipt, block] = await Promise.all([
      retry(() => chainRpc(chain, "eth_getTransactionReceipt", [log.transactionHash], 5000)),
      retry(() => chainRpc(chain, "eth_getBlockByNumber", [log.blockNumber, false], 5000)),
    ]);
    if (!receipt) throw new Error(`receipt unavailable for ${log.transactionHash}`);
    const event = decodeUserOperationReceipt(receipt, log, person, chain);
    await this.emit({
      ...event,
      timestamp: block?.timestamp ? new Date(Number.parseInt(block.timestamp, 16) * 1000).toISOString() : event.timestamp,
      personId: person.id,
      kolIds: person.kolIds || [person.id],
      targetId: person.targetId,
      wallet: person.evmAddress,
      source: `${chain.key}-ws`,
      sources: [`${chain.key}-ws`],
      observations: [{ source: `${chain.key}-ws`, observedAt: new Date().toISOString() }],
      dedupeKey: `${chain.key}:${person.evmAddress.toLowerCase()}:${log.transactionHash.toLowerCase()}`,
    }, person);
    this.report(`${chain.key}_ws`, "connected", { transport: "websocket", lastEventAt: new Date().toISOString() });
  }

  stop() {
    this.stopped = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    for (const socket of this.sockets.values()) socket.stop();
    this.sockets.clear();
  }
}
