import { spawn } from "node:child_process";
import path from "node:path";
import { addDecimals, decimal } from "./decimal.mjs";

const CHAIN_MAP = { sol: "solana", bsc: "bsc", base: "base", eth: "ethereum" };
const ADDRESS_FIELD = { sol: "solanaAddress", bsc: "evmAddress", base: "evmAddress", eth: "evmAddress" };

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isoTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return new Date().toISOString();
  return new Date(number < 1_000_000_000_000 ? number * 1000 : number).toISOString();
}

function canonicalHash(chain, value) {
  return chain === "solana" ? String(value || "") : String(value || "").toLowerCase();
}

export function parseGmgnOutput(output) {
  const value = String(output || "").trim();
  if (!value) return { activities: [], next: "" };
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") throw new Error("GMGN_SCHEMA_INVALID: root must be an object");
    return parsed;
  } catch {}
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error("GMGN CLI did not return JSON");
}

export function portfolioActivityFingerprint(item) {
  return [
    item.tx_hash,
    item.event_type,
    item.token?.address,
    item.token_amount,
    item.quote_amount,
    item.cost_usd,
  ].map((value) => String(value || "")).join(":");
}

export function tradeReconciliationKey(trade) {
  const chain = trade.chain || "unknown";
  const wallet = chain === "solana" ? String(trade.wallet || trade.maker || "") : String(trade.wallet || trade.maker || "").toLowerCase();
  const tx = canonicalHash(chain, trade.txHash || trade.signature || "");
  const token = String(trade.token?.address || trade.tokenAddress || "").toLowerCase();
  const side = String(trade.side || "").toLowerCase();
  return `${chain}:${wallet}:${tx}:${token}:${side}`;
}

export function reconcileTradeSets(sourceTrades, localTrades) {
  const source = new Map(sourceTrades.map((trade) => [tradeReconciliationKey(trade), trade]));
  const local = new Map(localTrades.map((trade) => [tradeReconciliationKey(trade), trade]));
  const items = [];
  let matched = 0;
  let mismatched = 0;
  for (const [key, expected] of source) {
    const actual = local.get(key);
    if (!actual) {
      items.push({ kind: "missing", key, differences: { expected: { side: expected.side, tokenAddress: expected.token?.address, tokenAmount: expected.tokenAmount, quoteAmount: expected.quoteAmount, valueUsd: expected.valueUsd } } });
      continue;
    }
    const differences = {};
    for (const field of ["tokenAmount", "quoteAmount", "valueUsd"]) {
      const expectedValue = expected[field] == null ? null : decimal(expected[field]);
      const actualValue = actual[field] == null ? null : decimal(actual[field]);
      if (expectedValue !== actualValue) differences[field] = { expected: expectedValue, actual: actualValue };
    }
    if (Object.keys(differences).length) {
      mismatched += 1;
      items.push({ kind: "mismatched", key, differences });
    } else matched += 1;
  }
  for (const [key, actual] of local) if (!source.has(key)) items.push({ kind: "extra", key, differences: { actual: { side: actual.side, tokenAddress: actual.token?.address, tokenAmount: actual.tokenAmount, quoteAmount: actual.quoteAmount, valueUsd: actual.valueUsd } } });
  return {
    sourceCount: source.size,
    localCount: local.size,
    matched,
    missing: items.filter((item) => item.kind === "missing").length,
    extra: items.filter((item) => item.kind === "extra").length,
    mismatched,
    items,
  };
}

export function aggregatePortfolioActivities(activities, person, gmgnChain, options = {}) {
  const chain = CHAIN_MAP[gmgnChain] || gmgnChain;
  const transactionGroups = new Map();
  for (const item of activities || []) {
    const txHash = String(item.tx_hash || "").trim();
    const side = String(item.event_type || "").toLowerCase();
    const tokenAddress = String(item.token?.address || "").trim();
    if (!txHash || !tokenAddress || !["buy", "sell"].includes(side)) continue;
    const groupKey = `${canonicalHash(chain, txHash)}:${side}`;
    const current = transactionGroups.get(groupKey) || {
      txHash,
      side,
      rows: [],
      timestamp: numeric(item.timestamp),
    };
    current.rows.push(item);
    current.timestamp = Math.min(current.timestamp || numeric(item.timestamp), numeric(item.timestamp) || current.timestamp);
    transactionGroups.set(groupKey, current);
  }

  const selectedGroups = [];
  for (const transaction of transactionGroups.values()) {
    const quoteAddresses = new Set(transaction.rows.map((item) =>
      String(item.quote_address || item.quote_token?.token_address || "").toLowerCase(),
    ).filter(Boolean));
    const tokenAddresses = [...new Set(transaction.rows.map((item) => String(item.token?.address || "")))];
    const terminalTokens = tokenAddresses.filter((address) => !quoteAddresses.has(address.toLowerCase()));
    const selectedTokens = terminalTokens.length ? terminalTokens : tokenAddresses;
    for (const tokenAddress of selectedTokens) {
      selectedGroups.push({
        ...transaction,
        tokenAddress,
        routeRows: transaction.rows,
        rows: transaction.rows.filter((item) => String(item.token?.address || "") === tokenAddress),
      });
    }
  }

  return selectedGroups.map((group) => {
    const first = group.rows[0];
    const tokenAmount = addDecimals(group.rows.map((item) => item.token_amount || "0"));
    const quoteAmount = addDecimals(group.rows.map((item) => item.quote_amount || "0"));
    const valueUsd = addDecimals(group.rows.map((item) => item.cost_usd || "0"));
    const fullPosition = group.rows.some((item) => Number(item.is_open_or_close) === 1);
    const observedAt = options.observedAt || new Date().toISOString();
    const historical = Boolean(options.historical);
    const normalizedTx = canonicalHash(chain, group.txHash);
    const tradeWallet = first.wallet || person.wallet || person[ADDRESS_FIELD[gmgnChain]] || "";
    const normalizedWallet = chain === "solana" ? tradeWallet : tradeWallet.toLowerCase();
    const stableKey = `trade:${chain}:${normalizedWallet}:${normalizedTx}:${group.tokenAddress.toLowerCase()}:${group.side}`;
    return {
      key: stableKey,
      dedupeKey: stableKey,
      stableSourceGroupKey: stableKey,
      correlationKey: `${chain}:${normalizedTx}`,
      personId: person.id,
      kolIds: person.kolIds || [person.id],
      targetId: person.targetId,
      kind: "trade",
      type: "TRADE",
      state: historical ? "historical" : "confirmed",
      stage: "TRADE_CONFIRMED",
      chain,
      source: "gmgn-portfolio",
      sources: ["gmgn-portfolio"],
      observations: [{ source: "gmgn-portfolio", observedAt }],
      txHash: group.txHash,
      wallet: tradeWallet,
      maker: tradeWallet,
      side: group.side,
      direction: group.side === "buy" ? "IN" : "OUT",
      tokenAmount,
      quoteAmount,
      valueUsd,
      legCount: group.rows.length,
      routeLegCount: group.routeRows.length,
      routeLegs: group.routeRows.map((item, index) => ({
        routeOrder: index,
        tokenAddress: item.token?.address || "",
        tokenSymbol: item.token?.symbol || "",
        amount: decimal(item.token_amount || "0"),
        quoteAddress: item.quote_address || item.quote_token?.token_address || "",
        quoteAmount: decimal(item.quote_amount || "0"),
        valueUsd: decimal(item.cost_usd || "0"),
      })),
      token: {
        address: group.tokenAddress,
        symbol: first.token?.symbol || "",
        name: first.token?.symbol || "",
        imageUrl: first.token?.logo || "",
        priceUsd: numeric(first.price_usd) || undefined,
      },
      quoteToken: {
        address: first.quote_address || first.quote_token?.token_address || "",
        symbol: first.quote_token?.symbol || "",
        imageUrl: first.quote_token?.logo || "",
      },
      positionAction: fullPosition
        ? group.side === "buy" ? "FULL_OPEN" : "FULL_CLOSE"
        : group.side === "buy" ? "ADD" : "REDUCE",
      gmgn: {
        mode: "portfolio-activity",
        launchpad: first.launchpad || "",
        fullPosition,
      },
      timestamp: isoTimestamp(group.timestamp),
      confirmedAt: observedAt,
      historical,
      notificationEligible: !historical,
      notificationStatus: historical ? "skipped" : "pending",
      activityFingerprints: group.rows.map(portfolioActivityFingerprint),
    };
  }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function runCommand(command, args, timeoutMs, maxOutputBytes = 8_000_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`GMGN CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) child.kill();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxOutputBytes) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `GMGN CLI exited ${code}`).trim()));
    });
  });
}

function defaultCliCommand(configuredPath = "") {
  if (configuredPath && !configuredPath.toLowerCase().endsWith(".cmd")) return { command: configuredPath, prefix: [] };
  if (process.platform === "win32" && process.env.APPDATA) {
    const cmd = configuredPath || path.join(process.env.APPDATA, "npm", "gmgn-cli.cmd");
    return { command: process.execPath, prefix: [path.join(path.dirname(cmd), "node_modules", "gmgn-cli", "dist", "index.js")] };
  }
  return { command: configuredPath || "gmgn-cli", prefix: [] };
}

class StartRateLimiter {
  constructor({ concurrency = 4, perSecond = 8 } = {}) {
    this.concurrency = concurrency;
    this.minGapMs = Math.ceil(1000 / perSecond);
    this.active = 0;
    this.queue = [];
    this.lastStartedAt = 0;
    this.timer = null;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    if (this.active >= this.concurrency || !this.queue.length || this.timer) return;
    const waitMs = Math.max(0, this.minGapMs - (Date.now() - this.lastStartedAt));
    if (waitMs) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, waitMs);
      this.timer.unref?.();
      return;
    }
    const item = this.queue.shift();
    this.active += 1;
    this.lastStartedAt = Date.now();
    Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
      this.active -= 1;
      this.drain();
    });
    this.drain();
  }
}

function targetId(chain, wallet) {
  return `${chain}:${chain === "sol" ? wallet : wallet.toLowerCase()}`;
}

export class GmgnWatcher {
  constructor({ config, store, emit, report, runner = runCommand }) {
    this.config = config;
    this.store = store;
    this.emit = emit;
    this.report = report;
    this.runner = runner;
    const cli = defaultCliCommand(config.gmgnCliPath);
    this.command = cli.command;
    this.commandPrefix = cli.prefix;
    this.limiter = new StartRateLimiter({ concurrency: config.gmgnConcurrency || 4, perSecond: config.gmgnRequestsPerSecond || 8 });
    this.targets = new Map();
    this.reconciliation = new Map();
    this.syncTimer = null;
    this.stopped = true;
  }

  targetList() {
    if (typeof this.store.activeTargets === "function") {
      const gmgnChain = { solana: "sol", bsc: "bsc", base: "base", ethereum: "eth" };
      return this.store.activeTargets().filter((target) => gmgnChain[target.chain]).map((target) => {
        const person = target.people[0];
        return {
          id: target.id,
          chain: gmgnChain[target.chain],
          wallet: target.address,
          person: { ...person, kolIds: target.people.map((item) => item.id) },
        };
      });
    }
    const result = [];
    for (const person of this.store.listPeople().filter((item) => item.enabled)) {
      for (const chain of this.config.gmgnChains) {
        const wallet = person[ADDRESS_FIELD[chain]];
        if (wallet) result.push({ id: targetId(chain, wallet), chain, wallet, person });
      }
    }
    return result;
  }

  start() {
    if (!this.config.enableGmgn) {
      this.report("gmgn", "disabled", { transport: "gmgn-cli", health: "disabled" });
      return;
    }
    this.stopped = false;
    this.refreshTargets();
    this.syncTimer = setInterval(() => this.refreshTargets(), this.config.subscriptionRefreshMs);
    this.syncTimer.unref?.();
  }

  refreshTargets() {
    if (this.stopped) return;
    const desired = this.targetList();
    const desiredIds = new Set(desired.map((item) => item.id));
    for (const [id, target] of this.targets) {
      if (!desiredIds.has(id)) {
        clearTimeout(target.timer);
        this.targets.delete(id);
      }
    }
    desired.forEach((item, index) => {
      if (this.targets.has(item.id)) {
        Object.assign(this.targets.get(item.id), item);
        return;
      }
      const target = { ...item, timer: null, running: false, failures: 0, lastTargetEventAt: "" };
      this.targets.set(item.id, target);
      this.schedule(target, index * 180);
    });
  }

  effectiveIntervalMs() {
    const targetCount = Math.max(1, this.targets.size);
    return Math.max(this.config.gmgnPollIntervalMs, Math.ceil(targetCount / (this.config.gmgnRequestsPerSecond || 8)) * 1000);
  }

  schedule(target, delay = this.effectiveIntervalMs()) {
    if (this.stopped || !this.targets.has(target.id)) return;
    clearTimeout(target.timer);
    target.timer = setTimeout(() => this.pollTarget(target), delay);
    target.timer.unref?.();
  }

  async commandPage(target, cursor = "") {
    const args = [
      "portfolio", "activity", "--chain", target.chain, "--wallet", target.wallet,
      "--limit", String(this.config.gmgnLimit), "--raw",
    ];
    if (cursor) args.splice(args.length - 1, 0, "--cursor", cursor);
    const output = await this.limiter.run(() => this.runner(this.command, [...this.commandPrefix, ...args], this.config.gmgnCommandTimeoutMs));
    const payload = parseGmgnOutput(output);
    if (!Array.isArray(payload.activities)) throw new Error("GMGN_SCHEMA_INVALID: activities must be an array");
    for (const item of payload.activities) {
      if (!item || typeof item !== "object" || !item.tx_hash || !item.event_type) throw new Error("GMGN_SCHEMA_INVALID: activity identity fields are missing");
    }
    return { activities: payload.activities, next: payload.next || "" };
  }

  async fetchWindow(target, cursorState) {
    const rows = [];
    let cursor = "";
    let complete = false;
    const watermark = Number(cursorState?.watermarkTimestamp || 0);
    for (let page = 0; page < this.config.gmgnMaxPages; page += 1) {
      const payload = await this.commandPage(target, cursor);
      rows.push(...payload.activities);
      const oldest = payload.activities.reduce((min, item) => Math.min(min, numeric(item.timestamp) || min), Number.MAX_SAFE_INTEGER);
      if (!payload.next || (watermark && oldest < watermark - this.config.gmgnLookbackSeconds)) {
        complete = true;
        break;
      }
      cursor = payload.next;
    }
    return { rows, complete, nextCursor: cursor };
  }

  async pollTarget(target, { forceHistorical = false } = {}) {
    if (this.stopped || target.running) return;
    target.running = true;
    const source = `gmgn_${target.chain}`;
    const started = Date.now();
    let nextDelay = this.effectiveIntervalMs();
    try {
      const cursorState = this.store.state.cursors.gmgn[target.id];
      const firstRun = !cursorState || typeof cursorState !== "object";
      const window = await this.fetchWindow(target, firstRun ? null : cursorState);
      const activities = window.rows;
      const observedAt = new Date().toISOString();
      const known = new Set(Array.isArray(cursorState?.seen) ? cursorState.seen : []);
      const watermark = Number(cursorState?.watermarkTimestamp || 0);
      const fresh = firstRun || forceHistorical
        ? activities
        : activities.filter((item) => {
          const timestamp = numeric(item.timestamp);
          return timestamp >= watermark - this.config.gmgnLookbackSeconds && !known.has(portfolioActivityFingerprint(item));
        });
      const historical = firstRun || forceHistorical;
      const events = aggregatePortfolioActivities(fresh, target.person, target.chain, { historical, observedAt });
      let added = 0;
      for (const event of events) {
        const stored = await this.emit(event, target.person);
        if (stored) added += 1;
      }
      const newestTimestamp = activities.reduce((max, item) => Math.max(max, numeric(item.timestamp)), watermark);
      const seen = [...new Set([
        ...activities.map(portfolioActivityFingerprint),
        ...(Array.isArray(cursorState?.seen) ? cursorState.seen : []),
      ])].slice(0, 1000);
      this.store.state.cursors.gmgn[target.id] = { watermarkTimestamp: newestTimestamp, seen, updatedAt: observedAt };
      await this.store.save();
      if (events.length) target.lastTargetEventAt = events.at(-1)?.timestamp || observedAt;
      else if (activities.length) target.lastTargetEventAt = isoTimestamp(activities[0].timestamp);
      target.failures = 0;
      const recentSourceTrades = aggregatePortfolioActivities(activities, target.person, target.chain, { historical: true, observedAt });
      const sourceTxs = new Set(recentSourceTrades.map((event) => canonicalHash(event.chain, event.txHash)));
      const normalizedTargetWallet = target.chain === "sol" ? target.wallet : target.wallet.toLowerCase();
      const localTrades = this.store.state.events.filter((event) => {
        const eventWallet = target.chain === "sol" ? String(event.wallet || event.maker || "") : String(event.wallet || event.maker || "").toLowerCase();
        return event.chain === (CHAIN_MAP[target.chain] || target.chain) && event.kind === "trade" && eventWallet === normalizedTargetWallet && sourceTxs.has(canonicalHash(event.chain, event.txHash));
      });
      const comparison = reconcileTradeSets(recentSourceTrades, localTrades);
      const reconciliation = {
        personId: target.person.id,
        personName: target.person.name,
        chain: CHAIN_MAP[target.chain] || target.chain,
        wallet: target.wallet,
        sourceTransactions: comparison.sourceCount,
        localTransactions: comparison.localCount,
        matched: comparison.matched,
        missing: comparison.missing,
        extra: comparison.extra,
        mismatched: comparison.mismatched,
        items: comparison.items,
        status: window.complete ? "closed" : "incomplete",
        sourceComplete: window.complete,
        checkedAt: observedAt,
      };
      this.reconciliation.set(target.id, reconciliation);
      if (this.store.database?.saveReconciliation) {
        this.store.database.saveReconciliation({
          targetId: target.id,
          personId: target.person.id,
          chain: reconciliation.chain,
          wallet: target.wallet,
          windowStart: new Date(Date.now() - this.config.gmgnLookbackSeconds * 1000).toISOString(),
          windowEnd: observedAt,
          status: window.complete ? "closed" : "incomplete",
          sourceComplete: window.complete,
          sourceCount: comparison.sourceCount,
          localCount: comparison.localCount,
          matched: comparison.matched,
          missing: reconciliation.missing,
          extra: comparison.extra,
          mismatched: comparison.mismatched,
          items: comparison.items,
          adapterVersion: "gmgn-cli-1.5.6",
        });
      }
      this.report(source, "connected", {
        transport: "gmgn-portfolio",
        health: "healthy",
        monitoredTargets: [...this.targets.values()].filter((item) => item.chain === target.chain).length,
        targetWallet: target.wallet,
        lastCheckedAt: observedAt,
        lastTargetEventAt: target.lastTargetEventAt,
        matched: added,
        effectivePollIntervalMs: this.effectiveIntervalMs(),
        durationMs: Date.now() - started,
      });
    } catch (error) {
      target.failures += 1;
      const message = error.message || String(error);
      const needsAuth = /GMGN_API_KEY|API key|not configured|unauthorized/i.test(message);
      const rateLimited = /429|RATE_LIMIT/i.test(message);
      const schemaInvalid = /GMGN_SCHEMA_INVALID|JSON/i.test(message);
      nextDelay = needsAuth ? 60_000 : rateLimited ? 300_000 : Math.min(60_000, this.effectiveIntervalMs() * (2 ** Math.min(4, target.failures)));
      this.report(source, needsAuth ? "needs API key" : `error: ${message}`, {
        transport: "gmgn-portfolio",
        health: needsAuth ? "unconfigured" : "degraded",
        targetWallet: target.wallet,
        lastCheckedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        errorCode: needsAuth ? "GMGN_AUTH_REQUIRED" : rateLimited ? "GMGN_RATE_LIMITED" : schemaInvalid ? "GMGN_SCHEMA_INVALID" : /timed out|timeout/i.test(message) ? "GMGN_TIMEOUT" : "GMGN_QUERY_FAILED",
        errorMessage: message,
        consecutiveFailures: target.failures,
        nextRetryAt: new Date(Date.now() + nextDelay).toISOString(),
      });
    } finally {
      target.running = false;
      this.schedule(target, nextDelay);
    }
  }

  async backfillPerson(person) {
    const targets = this.targetList().filter((target) => (target.person.kolIds || [target.person.id]).includes(person.id));
    const results = [];
    for (const target of targets) {
      const { rows: activities } = await this.fetchWindow(target, null);
      const observedAt = new Date().toISOString();
      const events = aggregatePortfolioActivities(activities, person, target.chain, { historical: true, observedAt });
      let added = 0;
      for (const event of events) if (await this.emit(event, person)) added += 1;
      results.push({ chain: target.chain, scanned: activities.length, transactions: events.length, added });
    }
    this.store.pruneGmgnRouteIntermediates?.();
    await this.store.save();
    return { added: results.reduce((sum, item) => sum + item.added, 0), results };
  }

  getReconciliation() {
    return [...this.reconciliation.values()].sort((a, b) => a.personName.localeCompare(b.personName) || a.chain.localeCompare(b.chain));
  }

  stop() {
    this.stopped = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    for (const target of this.targets.values()) clearTimeout(target.timer);
    this.targets.clear();
  }
}
