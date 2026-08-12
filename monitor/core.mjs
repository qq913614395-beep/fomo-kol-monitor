import { randomUUID } from "node:crypto";
import { absoluteDecimal, addDecimals, compareDecimals } from "./decimal.mjs";

export const RELAY_SOLANA_PROGRAM =
  "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
export const ENTRYPOINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
export const ENTRYPOINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
export const USER_OPERATION_EVENT =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
export const TRANSFER_EVENT =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

export function normalizeHandle(value = "") {
  return String(value).trim().replace(/^@/, "").toLowerCase();
}

export function normalizeEvm(value = "") {
  const trimmed = String(value).trim();
  return EVM_RE.test(trimmed) ? trimmed.toLowerCase() : "";
}

export function normalizeSolana(value = "") {
  const trimmed = String(value).trim();
  return SOLANA_RE.test(trimmed) ? trimmed : "";
}

export function normalizePerson(input = {}, existing = {}) {
  const handle = normalizeHandle(input.handle ?? input.fomoHandle ?? existing.handle);
  const twitter = normalizeHandle(input.twitter ?? existing.twitter ?? handle);
  const inputName = String(input.name ?? "").trim();
  const existingName = String(existing.name ?? "").trim();
  const now = new Date().toISOString();
  const solanaAddress = normalizeSolana(input.solanaAddress ?? input.solana ?? existing.solanaAddress);
  const evmAddress = normalizeEvm(input.evmAddress ?? input.evm ?? existing.evmAddress);
  const enabled = input.enabled ?? existing.enabled ?? true;
  return {
    id: existing.id || input.id || randomUUID(),
    name: inputName || (existingName && existingName !== "Unnamed" ? existingName : "") || handle || "Unnamed",
    handle,
    twitter,
    solanaAddress,
    evmAddress,
    enabled,
    monitorState: !enabled ? "paused" : solanaAddress || evmAddress ? "active" : "unresolved",
    priority: Math.max(1, Math.min(3, Number(input.priority ?? existing.priority ?? 1) || 1)),
    evidence: Array.isArray(input.evidence)
      ? input.evidence
      : Array.isArray(existing.evidence)
        ? existing.evidence
        : [],
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const ERC20_TRANSFER_FROM_SELECTOR = "0x23b872dd";
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

export function classifyDirectEvmTransaction(transaction, receipt, person, chain, timestamp) {
  const wallet = normalizeEvm(person.evmAddress);
  if (!wallet || normalizeEvm(transaction?.from) !== wallet) return null;
  const walletTopic = addressTopic(wallet).toLowerCase();
  const transfers = (receipt?.logs || [])
    .filter((log) => String(log.topics?.[0] || "").toLowerCase() === TRANSFER_EVENT)
    .filter((log) => {
      const from = String(log.topics?.[1] || "").toLowerCase();
      const to = String(log.topics?.[2] || "").toLowerCase();
      return from === walletTopic || to === walletTopic;
    })
    .map((log) => ({
      token: String(log.address || "").toLowerCase(),
      direction: String(log.topics?.[2] || "").toLowerCase() === walletTopic ? "IN" : "OUT",
      amount: BigInt(log.data || "0x0").toString(),
    }));
  const selector = String(transaction.input || "").slice(0, 10).toLowerCase();
  const simpleTokenCall = [ERC20_TRANSFER_SELECTOR, ERC20_TRANSFER_FROM_SELECTOR, ERC20_APPROVE_SELECTOR].includes(selector);
  const incoming = transfers.filter((item) => item.direction === "IN");
  const outgoing = transfers.filter((item) => item.direction === "OUT");
  const nativeValue = BigInt(transaction.value || "0x0");
  const candidateTrade = !simpleTokenCall && (
    (incoming.length > 0 && outgoing.length > 0) ||
    (incoming.length > 0 && nativeValue > 0n) ||
    outgoing.length > 0
  );
  if (!candidateTrade) return null;
  const txHash = transaction.hash || receipt?.transactionHash;
  const chainKey = chain.key || chain;
  const observedAt = new Date().toISOString();
  return {
    key: `hint:${chainKey}:${String(txHash).toLowerCase()}:${person.id}:direct`,
    dedupeKey: `hint:${chainKey}:${String(txHash).toLowerCase()}:${person.id}:direct`,
    correlationKey: `${chainKey}:${String(txHash).toLowerCase()}:${person.id}`,
    personId: person.id,
    kind: "activity",
    type: "EVM_TRANSACTION",
    state: "hint",
    stage: "CHAIN_HINT",
    chain: chainKey,
    chainId: chain.chainId,
    txHash,
    sender: wallet,
    recipient: transaction.to || "",
    transfers,
    nativeValue: nativeValue.toString(),
    probableSide: incoming.length ? "buy" : "sell",
    source: `${chainKey}-ws`,
    sources: [`${chainKey}-ws`],
    observations: [{ source: `${chainKey}-ws`, observedAt }],
    timestamp: timestamp || observedAt,
    notificationEligible: false,
  };
}

function splitCsvLine(line) {
  const result = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && quoted) {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

export function parseImport(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed.people || [parsed];
    return rows.map((row) => normalizePerson(row));
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = splitCsvLine(lines[0]).map((value) => value.toLowerCase());
  const hasHeader = first.some((value) =>
    ["name", "handle", "fomohandle", "twitter", "solana", "solanaaddress", "evm", "evmaddress"].includes(value),
  );
  const headers = hasHeader ? first : ["handle", "twitter", "solanaaddress", "evmaddress"];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const values = splitCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
    return normalizePerson({
      name: row.name,
      handle: row.handle || row.fomohandle,
      twitter: row.twitter,
      solanaAddress: row.solanaaddress || row.solana,
      evmAddress: row.evmaddress || row.evm,
    });
  });
}

export function addressTopic(address) {
  const normalized = normalizeEvm(address);
  return normalized ? `0x${normalized.slice(2).padStart(64, "0")}` : "";
}

function decimalString(value) {
  if (value == null || value === "") return "0";
  return String(value);
}

export function solanaTokenDeltas(transaction, owner) {
  const balances = new Map();
  for (const item of transaction?.meta?.preTokenBalances || []) {
    if (item.owner !== owner) continue;
    balances.set(item.mint, {
      pre: decimalString(item.uiTokenAmount?.uiAmountString),
      post: "0",
      decimals: item.uiTokenAmount?.decimals ?? 0,
    });
  }
  for (const item of transaction?.meta?.postTokenBalances || []) {
    if (item.owner !== owner) continue;
    const entry = balances.get(item.mint) || {
      pre: "0",
      post: "0",
      decimals: item.uiTokenAmount?.decimals ?? 0,
    };
    entry.post = decimalString(item.uiTokenAmount?.uiAmountString);
    balances.set(item.mint, entry);
  }
  return [...balances.entries()]
    .map(([token, item]) => ({
      token,
      delta: addDecimals([item.post, `-${item.pre}`]),
      decimals: item.decimals,
    }))
    .filter((item) => compareDecimals(item.delta, "0") !== 0);
}

export function classifySolanaTransaction(transaction, owner, signature) {
  const logs = transaction?.meta?.logMessages || [];
  const instructions = transaction?.transaction?.message?.instructions || [];
  const keys = transaction?.transaction?.message?.accountKeys || [];
  const signer = keys.some((key) => key.pubkey === owner && key.signer === true);
  const relay = instructions.some((item) => item.programId === RELAY_SOLANA_PROGRAM) ||
    logs.some((line) => line.includes(RELAY_SOLANA_PROGRAM));
  const instructionName = logs.find((line) => line.includes("Program log: Instruction:"))
    ?.split("Instruction:")[1]?.trim();
  const deltas = solanaTokenDeltas(transaction, owner);
  const positives = deltas.filter((item) => compareDecimals(item.delta, "0") > 0);
  const negatives = deltas.filter((item) => compareDecimals(item.delta, "0") < 0);
  const type = relay && /^Deposit(Token|Native)$/.test(instructionName || "")
    ? "RELAY_INTENT"
    : positives.length && negatives.length
      ? "SWAP"
      : positives.length
        ? "RECEIVE"
        : negatives.length
          ? "SEND"
          : "ACTIVITY";
  return {
    key: `solana:${signature}`,
    kind: "activity",
    state: "hint",
    type,
    stage: type === "RELAY_INTENT" ? "INTENT_SEEN" : "CHAIN_ACTIVITY",
    chain: "solana",
    txHash: signature,
    signer,
    relay,
    instruction: instructionName || "",
    tokenDeltas: deltas,
    tokenAmount: deltas.length === 1 ? absoluteDecimal(deltas[0].delta) : undefined,
    timestamp: transaction?.blockTime
      ? new Date(transaction.blockTime * 1000).toISOString()
      : new Date().toISOString(),
    notificationEligible: false,
  };
}

function bigintAbs(value) {
  const amount = BigInt(value || "0");
  return amount < 0n ? -amount : amount;
}

export function normalizeRelayRequest(request, person) {
  const fills = request?.protocol?.settlement?.destination?.fills || [];
  const outputTransactions = request?.data?.outTxs || [];
  const destinationAddress = request.recipient || "";
  const positiveChanges = [];
  for (const transaction of outputTransactions) {
    for (const state of transaction.stateChanges || []) {
      const diff = state?.change?.balanceDiff;
      const token = state?.change?.data?.tokenAddress;
      if (!diff || !token) continue;
      if (String(state.address).toLowerCase() !== String(destinationAddress).toLowerCase()) continue;
      if (BigInt(diff) > 0n) {
        positiveChanges.push({ token, amount: diff, chainId: transaction.chainId });
      }
    }
  }
  positiveChanges.sort((a, b) => bigintAbs(b.amount) > bigintAbs(a.amount) ? 1 : -1);
  const output = positiveChanges[0] || null;
  return {
    key: `relay:${request.id}`,
    kind: "route",
    state: request.status === "success" ? "settled" : "pending",
    type: "RELAY_ROUTE",
    stage: request.status === "success" ? "SETTLED" : "ROUTE_IDENTIFIED",
    chain: "relay",
    requestId: request.id,
    status: request.status,
    referrer: request.referrer || "",
    user: request.user,
    recipient: request.recipient,
    origin: {
      chainId: request?.protocol?.deposit?.origin?.chainId,
      token: request?.protocol?.deposit?.origin?.currency,
      amount: request?.protocol?.deposit?.origin?.amount,
      txHash: request?.protocol?.deposit?.origin?.transactionId,
    },
    destination: {
      chainId: fills[0]?.chainId ?? output?.chainId,
      txHash: fills[0]?.transactionId ?? outputTransactions[0]?.hash,
      token: output?.token || "",
      amount: output?.amount || "",
    },
    personId: person?.id,
    timestamp: request.createdAt || new Date().toISOString(),
    updatedAt: request.updatedAt,
    notificationEligible: false,
  };
}

export function decodeUserOperationReceipt(receipt, log, person, chain) {
  const logIndex = Number.parseInt(log.logIndex || "0x0", 16);
  const allLogs = receipt?.logs || [];
  let start = -1;
  for (const item of allLogs) {
    const itemIndex = Number.parseInt(item.logIndex || "0x0", 16);
    if (itemIndex >= logIndex) break;
    if (String(item.topics?.[0]).toLowerCase() === USER_OPERATION_EVENT) start = itemIndex;
  }
  const accountTopic = addressTopic(person.evmAddress).toLowerCase();
  const transfers = allLogs
    .filter((item) => {
      const itemIndex = Number.parseInt(item.logIndex || "0x0", 16);
      return itemIndex > start && itemIndex < logIndex &&
        String(item.topics?.[0]).toLowerCase() === TRANSFER_EVENT &&
        (String(item.topics?.[1]).toLowerCase() === accountTopic ||
          String(item.topics?.[2]).toLowerCase() === accountTopic);
    })
    .map((item) => ({
      token: String(item.address).toLowerCase(),
      direction: String(item.topics?.[2]).toLowerCase() === accountTopic ? "IN" : "OUT",
      amount: BigInt(item.data || "0x0").toString(),
    }));
  return {
    key: `${chain.key}:${receipt.transactionHash}:${log.logIndex}`,
    type: "USER_OPERATION",
    kind: "activity",
    state: "hint",
    stage: "INTENT_SEEN",
    chain: chain.key,
    chainId: chain.chainId,
    txHash: receipt.transactionHash,
    userOperationHash: log.topics?.[1],
    sender: person.evmAddress,
    success: receipt.status === "0x1",
    transfers,
    timestamp: new Date().toISOString(),
    notificationEligible: false,
  };
}

export function parseFomoscanHtml(html) {
  const source = String(html || "");
  const solana = source.match(/solscan\.io\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})/i)?.[1] || "";
  const evm = source.match(/etherscan\.io\/address\/(0x[a-fA-F0-9]{40})/i)?.[1] || "";
  return { solanaAddress: normalizeSolana(solana), evmAddress: normalizeEvm(evm) };
}

export function appendEvidence(person, evidence) {
  const key = `${evidence.type}:${evidence.value || evidence.requestId || evidence.url || ""}`;
  const existing = new Set((person.evidence || []).map((item) => item.key));
  if (!existing.has(key)) {
    person.evidence = [...(person.evidence || []), {
      key,
      at: new Date().toISOString(),
      ...evidence,
    }].slice(-20);
  }
  return person;
}
