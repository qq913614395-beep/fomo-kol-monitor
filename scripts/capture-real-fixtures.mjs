import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("fixtures", "real");
const wallet = { sol: "498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ", evm: "0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28" };
const samples = {
  nongwan: { chain: "sol", tx: "2gEh2GPZrhx4VjVe5DwvectM1jZr9UtBCg3BTqCWp3SDPuzPnpbPAA9mph9y58b47TpuPZzXhDwhgVczY5uhmt34" },
  jacket: { chain: "bsc", tx: "0x90002cf161e23bf3c7dcce5415b1d8b84cbb39057ca3063fd4252babf0f10023" },
  fold: { chain: "base", tx: "0x32eb9f5e22dabf5ed06f1e0f61dc8f2b44bbb238b596aa827b105ad175108686", userOpTx: "0xc63807e9208429113fad88641e1d2adf9822476417c19781f1a25474ef27afa9", userOpHash: "0xd63d47eeeb74d91c943a8dce22f2920c714d4d6d6a6d3085b482a3656963fdc5" },
  frankdegods: { chain: "sol" },
};
const rpcUrls = {
  sol: [process.env.SOLANA_RPC_HTTP, "https://api.mainnet-beta.solana.com"].filter(Boolean),
  bsc: [process.env.BNB_RPC_HTTP, "https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org"].filter(Boolean),
  base: [process.env.BASE_RPC_HTTP, "https://base-rpc.publicnode.com", "https://mainnet.base.org"].filter(Boolean),
};
const cli = process.env.GMGN_CLI_JS || path.join(process.env.APPDATA || "", "npm", "node_modules", "gmgn-cli", "dist", "index.js");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function run(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { shell: false, windowsHide: true, env: process.env });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${args.join(" ")}`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `exit ${code}`));
    });
  });
}

async function rpc(urls, method, params) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(25_000) });
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (!response.ok || parsed.error) throw new Error(`HTTP ${response.status}: ${parsed.error?.message || text.slice(0, 200)}`);
      return text;
    } catch (error) { errors.push(`${new URL(url).host}: ${error.message}`); }
  }
  throw new Error(`${method} failed on all read-only RPCs: ${errors.join("; ")}`);
}

async function saveFixture(name, files, metadata) {
  const directory = path.join(root, name); await mkdir(directory, { recursive: true });
  const manifest = [];
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file); await writeFile(target, content, "utf8");
    manifest.push({ file, sha256: sha256(content), bytes: Buffer.byteLength(content) });
  }
  await writeFile(path.join(directory, "metadata.json"), JSON.stringify({ ...metadata, capturedAt: new Date().toISOString(), authorization: "User authorized public read-only GMGN CLI and RPC fixture capture on 2026-08-04.", files: manifest }, null, 2), "utf8");
}

async function existingOr(name, file, task) {
  try { return await readFile(path.join(root, name, file), "utf8"); } catch { return task(); }
}

const version = (await run(["--version"])).trim();
const activity = {};
const cacheDirectory = path.join(root, ".capture-cache"); await mkdir(cacheDirectory, { recursive: true });
for (const chain of ["sol", "bsc", "base", "eth"]) {
  const cacheFile = path.join(cacheDirectory, `gmgn-${chain}.raw.json`);
  try { activity[chain] = await readFile(cacheFile, "utf8"); }
  catch { activity[chain] = await run(["portfolio", "activity", "--chain", chain, "--wallet", chain === "sol" ? wallet.sol : wallet.evm, "--limit", "100", "--raw"]); await writeFile(cacheFile, activity[chain], "utf8"); }
}

async function fetchPagesUntil(chain, targetWallet, transactionIdentity, maximum = 10) {
  const pages = [activity[chain]];
  for (let index = 1; index < maximum; index += 1) {
    const parsed = JSON.parse(pages.at(-1));
    if (parsed.activities?.some((item) => item.tx_hash === transactionIdentity) || !parsed.next) break;
    const pageNumber = index + 1;
    const cacheFile = path.join(cacheDirectory, `gmgn-${chain}-page-${pageNumber}.raw.json`);
    let raw;
    try { raw = await readFile(cacheFile, "utf8"); }
    catch { raw = await run(["portfolio", "activity", "--chain", chain, "--wallet", targetWallet, "--limit", "100", "--cursor", parsed.next, "--raw"]); await writeFile(cacheFile, raw, "utf8"); }
    pages.push(raw);
  }
  return pages;
}

const nongwanPages = await fetchPagesUntil("sol", wallet.sol, samples.nongwan.tx);
if (!nongwanPages.some((raw) => JSON.parse(raw).activities?.some((item) => item.tx_hash === samples.nongwan.tx))) throw new Error("Nongwan transaction was not found within the bounded GMGN pagination window");

await saveFixture("nongwan", {
  ...Object.fromEntries(nongwanPages.map((raw, index) => [`gmgn-page-${index + 1}.raw.json`, raw])),
  "solana-getTransaction.raw.json": await existingOr("nongwan", "solana-getTransaction.raw.json", () => rpc(rpcUrls.sol, "getTransaction", [samples.nongwan.tx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }])),
}, { sourceVersion: version, chain: "solana", wallet: wallet.sol, transactionIdentity: samples.nongwan.tx });

await saveFixture("jacket", {
  "gmgn-activity.raw.json": activity.bsc,
  "evm-transaction.raw.json": await existingOr("jacket", "evm-transaction.raw.json", () => rpc(rpcUrls.bsc, "eth_getTransactionByHash", [samples.jacket.tx])),
  "evm-receipt.raw.json": await existingOr("jacket", "evm-receipt.raw.json", () => rpc(rpcUrls.bsc, "eth_getTransactionReceipt", [samples.jacket.tx])),
}, { sourceVersion: version, chain: "bsc", wallet: wallet.evm, transactionIdentity: samples.jacket.tx });

await saveFixture("fold", {
  "gmgn-activity.raw.json": activity.base,
  "gmgn-transaction.raw.json": await existingOr("fold", "gmgn-transaction.raw.json", () => rpc(rpcUrls.base, "eth_getTransactionByHash", [samples.fold.tx])),
  "gmgn-receipt.raw.json": await existingOr("fold", "gmgn-receipt.raw.json", () => rpc(rpcUrls.base, "eth_getTransactionReceipt", [samples.fold.tx])),
  "userop-transaction.raw.json": await existingOr("fold", "userop-transaction.raw.json", () => rpc(rpcUrls.base, "eth_getTransactionByHash", [samples.fold.userOpTx])),
  "userop-receipt.raw.json": await existingOr("fold", "userop-receipt.raw.json", () => rpc(rpcUrls.base, "eth_getTransactionReceipt", [samples.fold.userOpTx])),
}, { sourceVersion: version, chain: "base", wallet: wallet.evm, transactionIdentity: samples.fold.tx, userOperationTransaction: samples.fold.userOpTx, userOperationHash: samples.fold.userOpHash, linkageStatus: "unverified" });

await saveFixture("frankdegods", {
  ...Object.fromEntries(Object.entries(activity).map(([chain, raw]) => [`gmgn-${chain}-page-1.raw.json`, raw])),
  ...Object.fromEntries(nongwanPages.slice(1).map((raw, index) => [`gmgn-sol-page-${index + 2}.raw.json`, raw])),
}, { sourceVersion: version, chain: "multi", wallet, transactionIdentity: "portfolio-window", pagination: `Solana pages 1-${nongwanPages.length}; other next cursors preserved in raw responses` });

console.log(JSON.stringify({ root, version, fixtures: Object.keys(samples) }));
