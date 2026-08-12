import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { USER_OPERATION_EVENT, decodeUserOperationReceipt } from "../monitor/core.mjs";
import { aggregatePortfolioActivities, parseGmgnOutput } from "../monitor/gmgn.mjs";

const FIXTURES = path.resolve("fixtures", "real");
const SOL = "498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ";
const EVM = "0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28";
const readJson = async (...parts) => JSON.parse(await readFile(path.join(FIXTURES, ...parts), "utf8"));

test("real Nongwan fixture aggregates two exact legs", async () => {
  const pageFiles = (await readdir(path.join(FIXTURES, "nongwan"))).filter((file) => /^gmgn-page-\d+\.raw\.json$/.test(file)).sort();
  const activities = (await Promise.all(pageFiles.map(async (file) => parseGmgnOutput(await readFile(path.join(FIXTURES, "nongwan", file), "utf8"))))).flatMap((page) => page.activities);
  const tx = "2gEh2GPZrhx4VjVe5DwvectM1jZr9UtBCg3BTqCWp3SDPuzPnpbPAA9mph9y58b47TpuPZzXhDwhgVczY5uhmt34";
  const [trade] = aggregatePortfolioActivities(activities.filter((item) => item.tx_hash === tx), { id: "frank", wallet: SOL }, "sol", { historical: true });
  assert.equal(trade.side, "sell");
  assert.equal(trade.token.symbol, "Nongwan");
  assert.equal(trade.legCount, 2);
  assert.equal(trade.tokenAmount, "4747376.720885");
  assert.equal(trade.valueUsd, "2255.54482840545");
});

test("real JACKET fixture is direct-from and removes NVDAB from terminal assets", async () => {
  const txHash = "0x90002cf161e23bf3c7dcce5415b1d8b84cbb39057ca3063fd4252babf0f10023";
  const transaction = (await readJson("jacket", "evm-transaction.raw.json")).result;
  const raw = parseGmgnOutput(await readFile(path.join(FIXTURES, "jacket", "gmgn-activity.raw.json"), "utf8"));
  const trades = aggregatePortfolioActivities(raw.activities.filter((item) => item.tx_hash.toLowerCase() === txHash), { id: "frank", wallet: EVM }, "bsc", { historical: true });
  assert.equal(transaction.from.toLowerCase(), EVM);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].token.symbol, "JACKET");
  assert.equal(trades[0].routeLegCount, 2);
  assert.equal(trades[0].valueUsd, "1163.1332351698225");
  assert.ok(trades[0].routeLegs.some((leg) => leg.tokenSymbol === "NVDAB"));
});

test("real Base fixture decodes ERC-4337 sender, userOpHash, and txHash", async () => {
  const receipt = (await readJson("fold", "userop-receipt.raw.json")).result;
  const log = receipt.logs.find((item) => item.topics[0].toLowerCase() === USER_OPERATION_EVENT);
  const decoded = decodeUserOperationReceipt(receipt, log, { id: "frank", evmAddress: EVM }, { key: "base", chainId: 8453 });
  assert.equal(decoded.sender, EVM);
  assert.equal(decoded.userOperationHash, "0xd63d47eeeb74d91c943a8dce22f2920c714d4d6d6a6d3085b482a3656963fdc5");
  assert.equal(decoded.txHash, "0xc63807e9208429113fad88641e1d2adf9822476417c19781f1a25474ef27afa9");
  const expected = await readJson("fold", "expected.json");
  assert.equal(expected.gmgnToUserOperationLinkage, "blocked_unverified");
});

test("frankdegods real GMGN pages preserve exact-wallet identity and pagination", async () => {
  for (const chain of ["sol", "bsc", "base", "eth"]) {
    const payload = parseGmgnOutput(await readFile(path.join(FIXTURES, "frankdegods", `gmgn-${chain}-page-1.raw.json`), "utf8"));
    assert.ok(Array.isArray(payload.activities));
    assert.equal(typeof payload.next, "string");
    const expectedWallet = chain === "sol" ? SOL : EVM;
    assert.ok(payload.activities.every((item) => String(item.wallet).toLowerCase() === expectedWallet.toLowerCase()));
  }
  const solPages = (await readdir(path.join(FIXTURES, "frankdegods"))).filter((file) => /^gmgn-sol-page-\d+\.raw\.json$/.test(file));
  assert.ok(solPages.length > 1);
});
