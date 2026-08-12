import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decimal } from "./decimal.mjs";
import { protectSecret, unprotectSecret } from "./secrets.mjs";

const NETWORKS = new Map([
  ["792703809", "solana"],
  ["56", "bsc"],
  ["8453", "base"],
  ["1", "ethereum"],
]);

const BUY_TYPES = new Set(["swap_buy", "multi_user_buy", "large_buy", "buy"]);
const SELL_TYPES = new Set(["swap_sell", "single_user_sell", "multi_user_sell", "large_sell", "sell"]);
const MAX_CLOCK_SKEW_MS = 60_000;

function at(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function first(value, paths) {
  for (const path of paths) {
    const candidate = at(value, path);
    if (candidate !== undefined && candidate !== null && candidate !== "") return candidate;
  }
  return undefined;
}

function text(value, max = 500) {
  if (value === undefined || value === null) return null;
  return String(value).trim().slice(0, max) || null;
}

function amount(value) {
  if (value === undefined || value === null || value === "") return null;
  try { return decimal(String(value)); } catch { return null; }
}

function iso(value, fallback) {
  if (!value) return fallback;
  const numeric = typeof value === "number" || /^\d{10,13}$/.test(String(value)) ? Number(value) : null;
  const time = new Date(numeric != null ? (numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : value);
  return Number.isNaN(time.getTime()) ? fallback : time.toISOString();
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function normalizeFomoAlert(input, receivedAt = new Date().toISOString()) {
  const payload = input?.payload && typeof input.payload === "object" ? input.payload : input;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("FOMO alert payload must be an object"), { code: "INVALID_FOMO_ALERT" });
  const eventType = (text(first(payload, [["type"], ["eventType"], ["body", "type"]]), 80) || "unknown").toLowerCase();
  const networkId = text(first(payload, [["networkId"], ["token", "networkId"], ["body", "networkId"], ["body", "token", "networkId"], ["authorTrade", "networkId"]]), 32);
  const rawChain = (text(first(payload, [["chain"], ["body", "chain"]]), 32) || "").toLowerCase();
  const chain = NETWORKS.get(String(networkId || "")) || ({ sol: "solana", bnb: "bsc", bnbchain: "bsc", eth: "ethereum" })[rawChain] || rawChain || "unknown";
  const side = BUY_TYPES.has(eventType) ? "buy" : SELL_TYPES.has(eventType) ? "sell" : null;
  const tokenAddress = text(first(payload, [
    ["tokenAddress"], ["token", "address"], ["body", "tokenAddress"], ["body", "token", "address"],
    ["body", "token", "tokenAddress"], ["authorTrade", "tokenAddress"], ["authorTrade", "token", "address"],
  ]), 160);
  const tokenSymbol = text(first(payload, [
    ["tokenSymbol"], ["token", "symbol"], ["body", "tokenSymbol"], ["body", "token", "symbol"],
    ["authorTrade", "tokenSymbol"], ["authorTrade", "token", "symbol"],
  ]), 80);
  const traderHandle = text(first(payload, [
    ["userHandle"], ["traderHandle"], ["body", "userHandle"], ["body", "trader", "userHandle"],
    ["authorTrade", "userHandle"], ["user", "userHandle"],
  ]), 160);
  const traderId = text(first(payload, [["userId"], ["traderId"], ["body", "userId"], ["authorTrade", "userId"]]), 160);
  const valueUsd = amount(first(payload, [["usdAmount"], ["valueUsd"], ["body", "totalVolume"], ["body", "usdAmount"], ["authorTrade", "usdValue"]]));
  const txIdentity = text(first(payload, [
    ["txHash"], ["transactionHash"], ["signature"], ["body", "txHash"], ["body", "transactionHash"],
    ["body", "signature"], ["authorTrade", "txHash"], ["authorTrade", "signature"],
  ]), 220);
  const fomoEventId = text(first(payload, [["id"], ["eventId"], ["feedId"]]), 220);
  const occurredAt = iso(first(payload, [["createdAt"], ["occurredAt"], ["timestamp"], ["body", "createdAt"]]), receivedAt);
  const economicIdentity = JSON.stringify({ eventType, chain, side, tokenAddress, traderHandle, valueUsd, occurredAt, txIdentity });
  const eventIdentity = `fomo-web:${fomoEventId || "no-id"}:${hash(economicIdentity)}`;
  return {
    eventIdentity,
    fomoEventId,
    eventType,
    chain,
    networkId,
    traderId,
    traderHandle,
    tokenAddress,
    tokenSymbol,
    side,
    valueUsd,
    txIdentity,
    occurredAt,
    receivedAt: iso(receivedAt, new Date().toISOString()),
    isTradeLike: Boolean(side && tokenAddress),
    payload,
  };
}

export function createBridgeSignature(secret, timestamp, rawBody) {
  let key;
  try { key = Buffer.from(secret, "base64url"); } catch { key = Buffer.from(String(secret)); }
  if (!key.length) key = Buffer.from(String(secret));
  return createHmac("sha256", key).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyBridgeSignature({ secret, timestamp, rawBody, signature, nowMs = Date.now() }) {
  const parsed = Number(timestamp);
  if (!secret || !Number.isFinite(parsed) || Math.abs(nowMs - parsed) > MAX_CLOCK_SKEW_MS) return false;
  const expected = Buffer.from(createBridgeSignature(secret, timestamp, rawBody), "hex");
  let received;
  try { received = Buffer.from(String(signature || ""), "hex"); } catch { return false; }
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export class FomoBridgeSecretStore {
  constructor(file, testSecret = "") {
    this.file = path.resolve(file);
    this.secret = testSecret || "";
    this.updatedAt = null;
    this.testSecret = testSecret || "";
  }

  async load() {
    if (this.testSecret) return this.status();
    try {
      const record = JSON.parse(await readFile(this.file, "utf8"));
      this.secret = await unprotectSecret(record.encrypted);
      this.updatedAt = record.updatedAt || null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.status();
  }

  status() { return { configured: Boolean(this.secret), updatedAt: this.updatedAt, secretMask: this.secret ? `${this.secret.slice(0, 4)}***${this.secret.slice(-4)}` : "" }; }
  getSecret() { return this.secret; }

  async pair() {
    const secret = randomBytes(32).toString("base64url");
    this.secret = secret;
    this.updatedAt = new Date().toISOString();
    if (!this.testSecret) {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, JSON.stringify({ encrypted: await protectSecret(secret), updatedAt: this.updatedAt }, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    }
    return { ...this.status(), secret };
  }

  async revoke() {
    this.secret = "";
    this.updatedAt = null;
    if (!this.testSecret) await rm(this.file, { force: true });
    return this.status();
  }
}
