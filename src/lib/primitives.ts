/**
 * Thin Base chain primitives — one RPC read, no interpretation, sub-cent.
 *
 * WHY THIS FILE EXISTS, given we already sell 124 analytical endpoints: because
 * the index says analysis is not what agents buy. Of the fifteen resources with
 * the most distinct payers on the whole x402 network, thirteen belong to one
 * seller and every one of them is a thin wrapper over a raw JSON-RPC call —
 * block height, ENS resolve, an ERC-20 balance, a nonce, a receipt — each taking
 * 400–615 separate payers in thirty days. Our best endpoint took three. The
 * winning shape is not a verdict, it is a fact an agent needs mid-task and does
 * not want to run a node for.
 *
 * That seller serves Ethereum. Nobody is serving Base the same way, which is the
 * opening: the payment rail is already on Base, so an agent that pays here is
 * usually asking about here.
 *
 * The discipline in this file is restraint. Every function is one read, returns
 * what the chain said, and adds no score, no band and no recommendation — the
 * moment one of these starts explaining itself it becomes a different (and, on
 * the evidence, worse-selling) product. The only shaping allowed is decoding
 * hex into something an agent can use without a library, and saying plainly when
 * a thing does not exist.
 *
 * `null` vs error matters here more than usual. A block that has not been mined,
 * a transaction that is not on chain, an address holding none of a token — these
 * are answers, and they return `found: false` with the reason. Only an upstream
 * that could not be read throws, so a failure never settles a payment.
 */

import "server-only";
import { createPublicClient, fallback, http, getAddress, formatUnits, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { getConfig } from "./config";
import { finish } from "./envelope";

const TIMEOUT_MS = 10_000;

/** Batching client: these handlers fire 2–4 independent reads, and batching
 *  collapses them into one round trip instead of paying latency per field. */
function client(): PublicClient {
  const configured = getConfig().rpcUrl;
  const opts = { timeout: TIMEOUT_MS, batch: { wait: 0 } } as const;
  const transport = configured
    ? fallback([http(configured, opts), http(undefined, opts)], { rank: false })
    : http(undefined, opts);
  return createPublicClient({ chain: base, transport }) as PublicClient;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

function addr(v: string, name: string): Address {
  const s = (v || "").trim();
  if (!ADDR.test(s)) throw new Error(`Provide a valid 0x… address (${name}=)`);
  return getAddress(s) as Address;
}
function hash(v: string, name: string): `0x${string}` {
  const s = (v || "").trim();
  if (!HASH.test(s)) throw new Error(`Provide a valid 0x… 32-byte transaction hash (${name}=)`);
  return s.toLowerCase() as `0x${string}`;
}

/** Minimal ABI fragments. Declared inline rather than imported so a change to a
 *  shared ABI file can never silently alter what these endpoints report. */
const ERC20 = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ERC165 = [
  {
    name: "supportsInterface",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes4" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Read a contract field, or null when the contract simply does not implement
 *  it. A missing `name()` is information, not an outage. */
async function tryRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Classify what the code at an address means.
 *
 * "Has code" stopped being the same as "is a contract" with EIP-7702: a plain
 * wallet can now point at an implementation, and what it leaves on chain is a
 * 23-byte designator, `0xef0100` followed by the delegate's address. It is still
 * an EOA — it still signs and sends its own transactions, and its nonce still
 * counts them.
 *
 * Reading that as a contract is not a cosmetic slip. `getTransactionCount` means
 * transactions sent for a wallet and contracts created for a contract, so the
 * same number gets reported under the wrong name, and a smart-wallet user would
 * be told they had deployed a thousand contracts. Our own treasury is delegated,
 * which is how this was caught.
 */
export function classifyCode(code: string | undefined): {
  isContract: boolean;
  delegatedTo: Address | null;
  codeSize: number;
} {
  if (!code || code === "0x") return { isContract: false, delegatedTo: null, codeSize: 0 };
  const size = (code.length - 2) / 2;
  if (size === 23 && code.toLowerCase().startsWith("0xef0100")) {
    return { isContract: false, delegatedTo: getAddress(`0x${code.slice(8)}`) as Address, codeSize: size };
  }
  return { isContract: true, delegatedTo: null, codeSize: size };
}

// ---------------------------------------------------------------------------

/** Any block, by number, tag, or hash. */
export async function baseBlock(params: Record<string, string>) {
  const raw = (params.block || params.number || params.tag || "latest").trim();
  const c = client();

  let block;
  if (HASH.test(raw)) {
    block = await tryRead(() => c.getBlock({ blockHash: raw as `0x${string}` }));
  } else if (/^(latest|finalized|safe|pending|earliest)$/i.test(raw)) {
    block = await c.getBlock({ blockTag: raw.toLowerCase() as "latest" });
  } else {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error("block= must be a block number, a 0x… block hash, or latest/finalized/safe/earliest");
    block = await tryRead(() => c.getBlock({ blockNumber: BigInt(n) }));
  }

  if (!block) {
    return finish({
      chain: "base",
      requested: raw,
      found: false,
      reason: "No such block on Base — it has not been mined yet, or that hash is from another chain.",
    });
  }

  return finish({
    chain: "base",
    found: true,
    number: Number(block.number),
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: Number(block.timestamp),
    time: new Date(Number(block.timestamp) * 1000).toISOString(),
    ageSeconds: Math.max(0, Math.floor(Date.now() / 1000 - Number(block.timestamp))),
    transactionCount: block.transactions.length,
    gasUsed: block.gasUsed.toString(),
    gasLimit: block.gasLimit.toString(),
    baseFeePerGasWei: block.baseFeePerGas?.toString() ?? null,
    baseFeeGwei: block.baseFeePerGas != null ? +formatUnits(block.baseFeePerGas, 9) : null,
    miner: block.miner,
    size: block.size.toString(),
  });
}

/** A transaction receipt: did it succeed, what did it cost, what did it emit. */
export async function baseReceipt(params: Record<string, string>) {
  const h = hash(params.hash || params.tx || params.txHash || "", "hash");
  const c = client();
  const receipt = await tryRead(() => c.getTransactionReceipt({ hash: h }));

  if (!receipt) {
    return finish({
      chain: "base",
      hash: h,
      found: false,
      // The distinction an agent polling for confirmation actually needs.
      reason: "No receipt on Base — the transaction is still pending, was dropped from the mempool, or never existed here.",
      status: null,
    });
  }

  const gasUsed = receipt.gasUsed;
  const price = receipt.effectiveGasPrice;
  return finish({
    chain: "base",
    hash: h,
    found: true,
    status: receipt.status, // "success" | "reverted"
    reverted: receipt.status === "reverted",
    blockNumber: Number(receipt.blockNumber),
    from: receipt.from ? getAddress(receipt.from) : null,
    to: receipt.to ? getAddress(receipt.to) : null,
    contractCreated: receipt.contractAddress ? getAddress(receipt.contractAddress) : null,
    gasUsed: gasUsed.toString(),
    effectiveGasPriceWei: price?.toString() ?? null,
    feeWei: price != null ? (gasUsed * price).toString() : null,
    feeEth: price != null ? formatUnits(gasUsed * price, 18) : null,
    logCount: receipt.logs.length,
    // Distinct emitting contracts — enough to route without shipping every log.
    logAddresses: [...new Set(receipt.logs.map((l) => getAddress(l.address)))],
  });
}

/** How many transactions an address has sent, and whether it is a contract. */
export async function baseNonce(params: Record<string, string>) {
  const a = addr(params.address || params.wallet || "", "address");
  const c = client();
  const [nonce, code, balance] = await Promise.all([
    c.getTransactionCount({ address: a }),
    c.getCode({ address: a }),
    c.getBalance({ address: a }),
  ]);
  const { isContract, delegatedTo } = classifyCode(code);
  return finish({
    chain: "base",
    address: a,
    // For an account that signs, this is the next nonce to use AND the count of
    // transactions it has sent. For a contract it counts the contracts that
    // contract has created — the same number under a different meaning, so each
    // is reported under its own name and the other is null.
    nonce,
    sentTransactions: isContract ? null : nonce,
    contractsDeployed: isContract ? nonce : null,
    isContract,
    // EIP-7702: a wallet that has delegated to an implementation. It has code
    // but still signs its own transactions, so it counts as a wallet here.
    delegated: delegatedTo != null,
    delegatedTo,
    balanceWei: balance.toString(),
    balanceEth: formatUnits(balance, 18),
    used: nonce > 0 || balance > 0n,
  });
}

/** A token's total supply, in raw units and decimal form. */
export async function tokenSupply(params: Record<string, string>) {
  const t = addr(params.token || params.address || params.contract || "", "token");
  const c = client();
  const [supply, decimals, symbol, name] = await Promise.all([
    tryRead(() => c.readContract({ address: t, abi: ERC20, functionName: "totalSupply" }) as Promise<bigint>),
    tryRead(() => c.readContract({ address: t, abi: ERC20, functionName: "decimals" }) as Promise<number>),
    tryRead(() => c.readContract({ address: t, abi: ERC20, functionName: "symbol" }) as Promise<string>),
    tryRead(() => c.readContract({ address: t, abi: ERC20, functionName: "name" }) as Promise<string>),
  ]);

  if (supply == null) {
    return finish({
      chain: "base",
      token: t,
      found: false,
      reason: "This address does not answer totalSupply() on Base — it is not a token contract, or not a contract at all.",
    });
  }
  const d = decimals ?? 18;
  return finish({
    chain: "base",
    token: t,
    found: true,
    name: name ?? null,
    symbol: symbol ?? null,
    decimals: d,
    // Reported when the contract declared it; 18 is assumed otherwise and said so.
    decimalsAssumed: decimals == null,
    totalSupplyRaw: supply.toString(),
    totalSupply: formatUnits(supply, d),
  });
}

/** One wallet's balance of one token. */
export async function tokenBalance(params: Record<string, string>) {
  const t = addr(params.token || params.contract || "", "token");
  const w = addr(params.wallet || params.address || params.holder || "", "wallet");
  const c = client();
  const [bal, decimals, symbol] = await Promise.all([
    tryRead(() => c.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [w] }) as Promise<bigint>),
    tryRead(() => c.readContract({ address: t, abi: ERC20, functionName: "decimals" }) as Promise<number>),
    tryRead(() => c.readContract({ address: t, abi: ERC20, functionName: "symbol" }) as Promise<string>),
  ]);

  if (bal == null) {
    return finish({
      chain: "base",
      token: t,
      wallet: w,
      found: false,
      reason: "This address does not answer balanceOf() on Base — it is not an ERC-20 contract, or not a contract at all.",
    });
  }
  const d = decimals ?? 18;
  return finish({
    chain: "base",
    token: t,
    wallet: w,
    found: true,
    symbol: symbol ?? null,
    decimals: d,
    decimalsAssumed: decimals == null,
    balanceRaw: bal.toString(),
    balance: formatUnits(bal, d),
    // A zero balance is a real answer, and the commonest one — flagged so a
    // caller does not have to compare strings to find out.
    zero: bal === 0n,
  });
}

/** What kind of contract is this: ERC-20, ERC-721, ERC-1155, or not one. */
export async function contractInfo(params: Record<string, string>) {
  const a = addr(params.address || params.contract || params.token || "", "address");
  const c = client();
  const code = await c.getCode({ address: a });
  const kind = classifyCode(code);
  if (!kind.isContract) {
    return finish({
      chain: "base",
      address: a,
      isContract: false,
      standard: null,
      delegated: kind.delegatedTo != null,
      delegatedTo: kind.delegatedTo,
      reason: kind.delegatedTo
        ? `A wallet that has delegated to ${kind.delegatedTo} under EIP-7702. It carries code but still signs its own transactions, so it is an account, not a contract — inspect the delegate for what it can do.`
        : "No code at this address on Base — it is an externally owned account (a wallet), not a contract.",
    });
  }

  const iface = (id: `0x${string}`) =>
    tryRead(() => c.readContract({ address: a, abi: ERC165, functionName: "supportsInterface", args: [id] }) as Promise<boolean>);

  const [name, symbol, decimals, supply, is721, is1155] = await Promise.all([
    tryRead(() => c.readContract({ address: a, abi: ERC20, functionName: "name" }) as Promise<string>),
    tryRead(() => c.readContract({ address: a, abi: ERC20, functionName: "symbol" }) as Promise<string>),
    tryRead(() => c.readContract({ address: a, abi: ERC20, functionName: "decimals" }) as Promise<number>),
    tryRead(() => c.readContract({ address: a, abi: ERC20, functionName: "totalSupply" }) as Promise<bigint>),
    iface("0x80ac58cd"),
    iface("0xd9b67a26"),
  ]);

  // ERC-165 first because it is declared rather than inferred. ERC-20 has no
  // interface id, so it is recognised by the shape that only ERC-20s have:
  // decimals() alongside totalSupply(). An NFT answers totalSupply() too, which
  // is why the 721/1155 checks are consulted before that fallback.
  const standard = is721 ? "ERC-721" : is1155 ? "ERC-1155" : decimals != null && supply != null ? "ERC-20" : null;

  return finish({
    chain: "base",
    address: a,
    isContract: true,
    standard,
    name: name ?? null,
    symbol: symbol ?? null,
    decimals: decimals ?? null,
    totalSupplyRaw: supply?.toString() ?? null,
    supportsERC721: is721 ?? false,
    supportsERC1155: is1155 ?? false,
    delegated: false,
    delegatedTo: null,
    codeSize: kind.codeSize,
    note:
      standard === null
        ? "A contract that declares no NFT interface and exposes no ERC-20 shape — it may be a proxy, a router, or something bespoke."
        : null,
  });
}

/** A transaction as it appears on chain, before any interpretation. */
export async function baseTx(params: Record<string, string>) {
  const h = hash(params.hash || params.tx || params.txHash || "", "hash");
  const c = client();
  const tx = await tryRead(() => c.getTransaction({ hash: h }));

  if (!tx) {
    return finish({
      chain: "base",
      hash: h,
      found: false,
      reason: "Not on Base — the hash is unknown here. It may belong to another chain, or the transaction was never broadcast.",
    });
  }

  const input = tx.input ?? "0x";
  return finish({
    chain: "base",
    hash: h,
    found: true,
    // null block number means accepted into the mempool but not yet mined.
    pending: tx.blockNumber == null,
    blockNumber: tx.blockNumber != null ? Number(tx.blockNumber) : null,
    from: getAddress(tx.from),
    to: tx.to ? getAddress(tx.to) : null,
    // A null `to` is a deployment, which is otherwise easy to misread as missing data.
    isContractCreation: tx.to == null,
    valueWei: tx.value.toString(),
    valueEth: formatUnits(tx.value, 18),
    nonce: tx.nonce,
    gas: tx.gas.toString(),
    gasPriceWei: tx.gasPrice?.toString() ?? null,
    maxFeePerGasWei: tx.maxFeePerGas?.toString() ?? null,
    type: tx.type,
    // The selector is the useful part of calldata at this price point; decoding
    // it into arguments is a different, more expensive product.
    methodSelector: input.length >= 10 ? input.slice(0, 10) : null,
    inputBytes: (input.length - 2) / 2,
    hasCalldata: input.length > 2,
  });
}
