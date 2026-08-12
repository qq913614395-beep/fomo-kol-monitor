import { absoluteDecimal, compareDecimals, decimal } from "./decimal.mjs";

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

const DEX_CHAIN_BY_EVENT = {
  solana: "solana",
  base: "base",
  bnb: "bsc",
  bsc: "bsc",
  ethereum: "ethereum",
};

const DEX_CHAIN_BY_ID = {
  56: "bsc",
  143: "monad",
  8453: "base",
  792703809: "solana",
};

function isTokenAddress(value) {
  return SOLANA_RE.test(String(value || "")) || EVM_RE.test(String(value || ""));
}

function normalizedAddress(value) {
  return EVM_RE.test(String(value || "")) ? String(value).toLowerCase() : String(value || "");
}

export function selectEventToken(event) {
  const destinationToken = event?.destination?.token;
  if (isTokenAddress(destinationToken)) {
    return {
      address: destinationToken,
      chain: DEX_CHAIN_BY_ID[event.destination.chainId] || DEX_CHAIN_BY_EVENT[event.chain],
      amountRaw: event.destination.amount || "",
      direction: "IN",
    };
  }

  const directToken = event?.token?.address;
  if (isTokenAddress(directToken)) {
    return {
      address: directToken,
      chain: DEX_CHAIN_BY_EVENT[event.chain],
      amountUi: event.amountUi,
      direction: event.direction,
    };
  }

  const transfers = event?.transfers || [];
  const transfer = transfers.find((item) => item.direction === "IN" && isTokenAddress(item.token)) ||
    transfers.find((item) => isTokenAddress(item.token));
  if (transfer) {
    return {
      address: transfer.token,
      chain: DEX_CHAIN_BY_EVENT[event.chain],
      amountRaw: transfer.amount || "",
      direction: transfer.direction,
    };
  }

  const deltas = event?.tokenDeltas || [];
  const delta = deltas.find((item) => compareDecimals(item.delta, "0") > 0 && isTokenAddress(item.token)) ||
    deltas.find((item) => isTokenAddress(item.token));
  if (delta) {
    return {
      address: delta.token,
      chain: "solana",
      amountUi: absoluteDecimal(delta.delta),
      direction: compareDecimals(delta.delta, "0") >= 0 ? "IN" : "OUT",
    };
  }

  const originToken = event?.origin?.token;
  if (isTokenAddress(originToken)) {
    return {
      address: originToken,
      chain: DEX_CHAIN_BY_ID[event.origin.chainId] || DEX_CHAIN_BY_EVENT[event.chain],
      amountRaw: event.origin.amount || "",
      direction: "OUT",
    };
  }
  return null;
}

export function pickDexPair(pairs, address, preferredChain = "") {
  const target = normalizedAddress(address);
  const candidates = (pairs || []).filter((pair) => {
    const base = normalizedAddress(pair?.baseToken?.address);
    const quote = normalizedAddress(pair?.quoteToken?.address);
    return base === target || quote === target;
  });
  const sameChain = candidates.filter((pair) => !preferredChain || pair.chainId === preferredChain);
  const pool = sameChain.length ? sameChain : candidates;
  return pool.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0] || null;
}

export function metricsFromPair(pair, address) {
  if (!pair) return null;
  const target = normalizedAddress(address);
  const baseMatches = normalizedAddress(pair?.baseToken?.address) === target;
  const asset = baseMatches ? pair.baseToken : pair.quoteToken;
  return {
    address,
    symbol: asset?.symbol || "",
    name: asset?.name || "",
    imageUrl: pair?.info?.imageUrl || "",
    pairUrl: pair?.url || "",
    dexId: pair?.dexId || "",
    chainId: pair?.chainId || "",
    priceUsd: Number(pair?.priceUsd || 0) || 0,
    marketCap: Number(pair?.marketCap || pair?.fdv || 0) || 0,
    liquidityUsd: Number(pair?.liquidity?.usd || 0) || 0,
  };
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${method} returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || method);
  return payload.result;
}

export class EventEnricher {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
    this.decimals = new Map();
  }

  async tokenMetrics(candidate) {
    const key = `${candidate.chain || "any"}:${normalizedAddress(candidate.address)}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const base = this.config.dexScreenerApiBase.replace(/\/$/, "");
    const response = await fetch(`${base}/latest/dex/tokens/${encodeURIComponent(candidate.address)}`, {
      headers: { "user-agent": "FomoKolMonitor/0.2" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`DexScreener returned ${response.status}`);
    const payload = await response.json();
    const value = metricsFromPair(pickDexPair(payload.pairs, candidate.address, candidate.chain), candidate.address);
    this.cache.set(key, { value, expiresAt: Date.now() + this.config.tokenCacheTtlMs });
    return value;
  }

  async evmDecimals(address, event) {
    const key = normalizedAddress(address);
    if (this.decimals.has(key)) return this.decimals.get(key);
    const chainId = event?.destination?.chainId || event?.chainId;
    const chain = this.config.evmChains.find((item) => item.chainId === chainId || item.key === event.chain);
    if (!chain?.rpcUrl) return 18;
    const encoded = await rpc(chain.rpcUrl, "eth_call", [{ to: address, data: "0x313ce567" }, "latest"]);
    const value = Number.parseInt(encoded || "0x12", 16);
    const decimals = Number.isFinite(value) && value >= 0 && value <= 36 ? value : 18;
    this.decimals.set(key, decimals);
    return decimals;
  }

  async solanaDecimals(address) {
    const key = `solana:${address}`;
    if (this.decimals.has(key)) return this.decimals.get(key);
    if (!this.config.solanaRpcHttp) return 9;
    const supply = await rpc(this.config.solanaRpcHttp, "getTokenSupply", [address, { commitment: "confirmed" }]);
    const value = Number(supply?.value?.decimals);
    const decimals = Number.isFinite(value) && value >= 0 && value <= 18 ? value : 9;
    this.decimals.set(key, decimals);
    return decimals;
  }

  async enrich(event) {
    if (!this.config.enableTokenEnrichment) return event;
    const candidate = selectEventToken(event);
    if (!candidate) return event;
    const metrics = await this.tokenMetrics(candidate);
    if (!metrics) return event;
    let amountUi = candidate.amountUi;
    if (amountUi == null && candidate.amountRaw && EVM_RE.test(candidate.address)) {
      const decimals = await this.evmDecimals(candidate.address, event);
      amountUi = Number(candidate.amountRaw) / (10 ** decimals);
    }
    if (amountUi == null && candidate.amountRaw && SOLANA_RE.test(candidate.address)) {
      const decimals = await this.solanaDecimals(candidate.address);
      amountUi = Number(candidate.amountRaw) / (10 ** decimals);
    }
    const valueUsd = Number.isFinite(amountUi) && metrics.priceUsd ? Math.abs(amountUi) * metrics.priceUsd : 0;
    const authoritativeTrade = event.kind === "trade" && ["confirmed", "historical"].includes(event.state);
    return {
      ...event,
      token: {
        ...metrics,
        ...(authoritativeTrade ? event.token : {}),
        marketCap: metrics.marketCap,
        liquidityUsd: metrics.liquidityUsd,
        pairUrl: metrics.pairUrl,
      },
      direction: event.direction || candidate.direction,
      amountUi: authoritativeTrade ? event.tokenAmount : Number.isFinite(Number(amountUi)) ? decimal(amountUi) : undefined,
      valueUsd: authoritativeTrade ? event.valueUsd : Number.isFinite(valueUsd) ? decimal(valueUsd) : "0",
    };
  }
}
