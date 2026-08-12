import { appendEvidence, normalizeEvm, normalizeSolana, parseFomoscanHtml } from "./core.mjs";

const CHAIN_BY_ID = { 1: "ethereum", 56: "bsc", 8453: "base", 792703809: "solana" };

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

export async function fetchRelayRequests(config, address, limit = 10) {
  const url = new URL(config.relayRequestsPath, config.relayApiBase);
  url.searchParams.set("user", address);
  url.searchParams.set("limit", String(limit));
  const headers = config.relayApiKey ? { authorization: `Bearer ${config.relayApiKey}` } : {};
  const payload = await fetchJson(url, { headers });
  return payload.requests || payload.data || [];
}

export function counterpartFromRequests(person, requests) {
  let solanaAddress = person.solanaAddress || "";
  let evmAddress = person.evmAddress || "";
  const evidence = [];
  const candidates = [];
  for (const request of requests) {
    if (String(request.referrer).toLowerCase() !== "fomo") continue;
    const userSol = normalizeSolana(request.user);
    const recipientSol = normalizeSolana(request.recipient);
    const userEvm = normalizeEvm(request.user);
    const recipientEvm = normalizeEvm(request.recipient);
    const originChainId = Number(request?.protocol?.deposit?.origin?.chainId || 0);
    const destinationChainId = Number(request?.protocol?.settlement?.destination?.fills?.[0]?.chainId || request?.data?.outTxs?.[0]?.chainId || 0);
    if (solanaAddress && (userSol === solanaAddress || recipientSol === solanaAddress)) {
      const counterpart = userEvm || recipientEvm;
      evmAddress ||= counterpart;
      if (counterpart) {
        const isDestination = recipientEvm === counterpart && destinationChainId;
        const chainId = isDestination ? destinationChainId : originChainId;
        candidates.push({
          chain: CHAIN_BY_ID[chainId] || "unknown",
          chainId: chainId || null,
          address: counterpart,
          addressRole: isDestination ? "vault" : userEvm === counterpart ? "source_wallet" : "unknown",
          source: "relay-fomo-request",
          confidence: isDestination && CHAIN_BY_ID[chainId] ? 0.85 : CHAIN_BY_ID[chainId] ? 0.7 : 0.5,
          requestId: request.id,
          firstSeenAt: request.createdAt,
          lastSeenAt: request.updatedAt || request.createdAt,
          evidence: [{ type: "relay-fomo-request", requestId: request.id, originChainId, destinationChainId, originTxHash: request?.protocol?.deposit?.origin?.transactionId, destinationTxHash: request?.protocol?.settlement?.destination?.fills?.[0]?.transactionId }],
        });
      }
    }
    if (evmAddress && (userEvm === evmAddress || recipientEvm === evmAddress)) {
      solanaAddress ||= userSol || recipientSol;
    }
    if ((solanaAddress && (userSol === solanaAddress || recipientSol === solanaAddress)) ||
        (evmAddress && (userEvm === evmAddress || recipientEvm === evmAddress))) {
      evidence.push({ type: "relay-fomo-request", requestId: request.id, value: request.id });
    }
  }
  const uniqueCandidates = [...new Map(candidates.map((item) => [`${item.chain}:${item.address}:${item.addressRole}`, item])).values()];
  return { solanaAddress, evmAddress, evidence, candidates: uniqueCandidates };
}

export async function resolvePerson(config, person) {
  const resolved = structuredClone(person);
  resolved.candidates = [];
  if (config.enableFomoscanResolver && resolved.handle) {
    const response = await fetch(`https://www.fomoscan.sh/${encodeURIComponent(resolved.handle)}`, {
      headers: { "user-agent": "FomoKolMonitor/0.1 (+local read-only resolver)" },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) {
      const found = parseFomoscanHtml(await response.text());
      resolved.solanaAddress ||= found.solanaAddress;
      if (found.evmAddress) resolved.candidates.push({ chain: "unknown", address: found.evmAddress, addressRole: "unknown", source: "fomoscan-seed", confidence: 0.4, evidence: [{ type: "fomoscan-seed", url: `https://www.fomoscan.sh/${resolved.handle}` }] });
      if (found.solanaAddress || found.evmAddress) {
        appendEvidence(resolved, {
          type: "fomoscan-seed",
          url: `https://www.fomoscan.sh/${resolved.handle}`,
          value: `${found.solanaAddress}:${found.evmAddress}`,
        });
      }
    }
  }

  const addresses = [...new Set([
    resolved.solanaAddress,
    resolved.evmAddress,
    ...(resolved.bindings || []).map((binding) => binding.address),
  ].filter(Boolean))];
  for (const address of addresses) {
    try {
      const requests = await fetchRelayRequests(config, address, 10);
      const counterpart = counterpartFromRequests(resolved, requests);
      resolved.solanaAddress ||= counterpart.solanaAddress;
      resolved.candidates.push(...(counterpart.candidates || []));
      for (const evidence of counterpart.evidence) appendEvidence(resolved, evidence);
    } catch {
      // Address discovery remains useful when Relay is temporarily unavailable.
    }
  }
  resolved.candidates = [...new Map(resolved.candidates.map((item) => [`${item.chain}:${item.address}:${item.addressRole}`, item])).values()];
  resolved.updatedAt = new Date().toISOString();
  return resolved;
}
