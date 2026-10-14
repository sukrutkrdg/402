/**
 * clanker-token-audit — "was this Base token really launched through Clanker,
 * which version, who asked for it, and is the liquidity held by Clanker's locker?"
 *
 * The first version of this check looked for `owner() == factory` or the factory
 * address inside the token's bytecode. Neither is how Clanker works: v4 tokens
 * have no owner() and never embed the factory, so every real v4 token failed,
 * and $CLANKER itself (a v0 launch) was called an impersonator. This version
 * asks the factories, which keep the record themselves:
 *
 *   v4    0xE85A…83a9  tokenDeploymentInfo(token) → (token, hook, locker, extensions)
 *   v3.1  0x2A78…7382  deploymentInfoForToken(token) → (token, positionId, locker)
 *   v3    0x375C…2c5E  deploymentInfoForToken(token)
 *   v2    0x7325…3833  deploymentInfoForToken(token)
 *
 * The v0 (0x250c…EA47) and v1 (0x9B84…c3e1) factories kept no per-token record,
 * only a TokenCreated event. Every token they created shares one runtime
 * bytecode per version, so a code fingerprint rules them OUT with no upstream at
 * all; to rule one IN we take the deploy transaction clanker.world lists and
 * verify, from the receipt, that the factory itself emitted TokenCreated for
 * this exact address. clanker.world is never the only evidence for a verdict.
 *
 * Liquidity: the factory names the locker and LP position; we read who holds the
 * position NFT now. `liquidityLocked: true` only when it sits in a Clanker
 * locker whose public functions were reviewed and include no way to withdraw or
 * transfer the position (v2, v3, v3.1, v4 lockers below), or in a v0/v1 time
 * lock whose end() is still in the future. Anything else is reported as read,
 * with liquidityLocked null and the reason — never guessed.
 *
 * Billing: a Base RPC failure throws (not charged). "We cannot tell" is a
 * refusal receipt (not billed), not a confident verdict.
 */

import "server-only";
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { decisionReceipt } from "./envelope";

const client = createPublicClient({ chain: base, transport: baseTransport(8000, true) });

const ENDPOINT = "clanker-token-audit";
const ZERO = "0x0000000000000000000000000000000000000000";

export const CLANKER_FACTORIES = {
  v4: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
  "v3.1": "0x2A787b2362021cC3eEa3C24C4748a6cD5B687382",
  v3: "0x375C15db32D28cEcdcAB5C03Ab889bf15cbD2c5E",
  v2: "0x732560fa1d1A76350b1A500155BA978031B53833",
  v1: "0x9B84fcE5Dcd9a38d2D01d5D72373F6b6b067c3e1",
  v0: "0x250c9FB2b411B48273f69879007803790A6AeA47",
} as const satisfies Record<string, Address>;
type Version = keyof typeof CLANKER_FACTORIES;

/** clanker.world's `type` for each factory, for the cross-check. */
const API_TYPE: Record<Version, string> = {
  v4: "clanker_v4",
  "v3.1": "clanker_v3_1",
  v3: "clanker_v3",
  v2: "clanker_v2",
  v1: "clanker",
  v0: "proxy",
};

/**
 * Lockers whose external functions were reviewed (dispatcher + Clanker's
 * published ABI): fee collection, reward-recipient admin, and ERC-20/ETH sweeps
 * only — no function moves an LP position NFT out. A position held by one of
 * these is locked for good.
 */
const PERMANENT_LOCKERS: Record<string, Version> = {
  "0xffa37784d619f228d8b379d287a4d7282e500762": "v4",
  "0x33e2eda238edcf470309b8c6d228986a1204c8f9": "v3.1",
  "0x5ec4f99f342038c67a312a166ff56e6d70383d86": "v3",
  "0x618a9840691334ee8d24445a4ada4284bf42417d": "v2",
};

/** keccak256 of the runtime bytecode every v0 / v1 factory token shares. */
const LEGACY_CODE: Record<string, "v0" | "v1"> = {
  "0xf6926d7dfdad38ad074c2fd728b1bb12264f560c5e66fe555105d9ad575c4d3b": "v0",
  "0x334311ad8d9f8a10d5d16d38bc215d0de7f8204d332a6f1a060ebb3f4adbc57f": "v1",
};

const UNI_V3_POSITIONS = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" as const;
const UNI_V4_POSITIONS = "0x7C5f5A4bBd8fD63184577525326123B519429bDc" as const;
const CLANKER_WORLD = "https://www.clanker.world/api/tokens";

// ---- ABIs (only what is read) ----

const v4FactoryAbi = [
  {
    type: "function", name: "tokenDeploymentInfo", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{
      type: "tuple", components: [
        { name: "token", type: "address" }, { name: "hook", type: "address" },
        { name: "locker", type: "address" }, { name: "extensions", type: "address[]" },
      ],
    }],
  },
] as const;

const legacyFactoryAbi = [
  {
    type: "function", name: "deploymentInfoForToken", stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "token", type: "address" }, { name: "positionId", type: "uint256" }, { name: "locker", type: "address" }],
  },
] as const;

const v4LockerAbi = [
  {
    type: "function", name: "tokenRewards", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{
      type: "tuple", components: [
        { name: "token", type: "address" },
        { name: "poolKey", type: "tuple", components: [
          { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
        ] },
        { name: "positionId", type: "uint256" }, { name: "numPositions", type: "uint256" },
        { name: "rewardBps", type: "uint16[]" }, { name: "rewardAdmins", type: "address[]" },
        { name: "rewardRecipients", type: "address[]" },
      ],
    }],
  },
] as const;

const ownerOfAbi = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

const timeLockAbi = [
  { type: "function", name: "end", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const v4TokenAbi = [
  {
    type: "function", name: "allData", stateMutability: "view", inputs: [],
    outputs: [
      { name: "originalAdmin", type: "address" }, { name: "admin", type: "address" },
      { name: "image", type: "string" }, { name: "metadata", type: "string" }, { name: "context", type: "string" },
    ],
  },
] as const;

const tokenViewsAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "context", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "deployer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fid", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "castHash", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const tokenCreatedV0 = [{
  type: "event", name: "TokenCreated", inputs: [
    { name: "tokenAddress", type: "address", indexed: false }, { name: "lpNftId", type: "uint256", indexed: false },
    { name: "deployer", type: "address", indexed: false }, { name: "name", type: "string", indexed: false },
    { name: "symbol", type: "string", indexed: false }, { name: "supply", type: "uint256", indexed: false },
    { name: "_supply", type: "uint256", indexed: false }, { name: "lockerAddress", type: "address", indexed: false },
  ],
}] as const;

const tokenCreatedV1 = [{
  type: "event", name: "TokenCreated", inputs: [
    { name: "tokenAddress", type: "address", indexed: false }, { name: "lpNftId", type: "uint256", indexed: false },
    { name: "deployer", type: "address", indexed: false }, { name: "fid", type: "uint256", indexed: false },
    { name: "name", type: "string", indexed: false }, { name: "symbol", type: "string", indexed: false },
    { name: "supply", type: "uint256", indexed: false }, { name: "lockerAddress", type: "address", indexed: false },
    { name: "castHash", type: "string", indexed: false },
  ],
}] as const;

const tokenCreatedV31 = [{
  type: "event", name: "TokenCreated", inputs: [
    { name: "tokenAddress", type: "address", indexed: true }, { name: "creatorAdmin", type: "address", indexed: true },
    { name: "interfaceAdmin", type: "address", indexed: true }, { name: "creatorRewardRecipient", type: "address", indexed: false },
    { name: "interfaceRewardRecipient", type: "address", indexed: false }, { name: "positionId", type: "uint256", indexed: false },
    { name: "name", type: "string", indexed: false }, { name: "symbol", type: "string", indexed: false },
    { name: "startingTickIfToken0IsNewToken", type: "int24", indexed: false }, { name: "metadata", type: "string", indexed: false },
    { name: "amountTokensBought", type: "uint256", indexed: false }, { name: "vaultDuration", type: "uint256", indexed: false },
    { name: "vaultPercentage", type: "uint8", indexed: false }, { name: "msgSender", type: "address", indexed: false },
  ],
}] as const;

const tokenCreatedV4 = [{
  type: "event", name: "TokenCreated", inputs: [
    { name: "msgSender", type: "address", indexed: false }, { name: "tokenAddress", type: "address", indexed: true },
    { name: "tokenAdmin", type: "address", indexed: true }, { name: "tokenImage", type: "string", indexed: false },
    { name: "tokenName", type: "string", indexed: false }, { name: "tokenSymbol", type: "string", indexed: false },
    { name: "tokenMetadata", type: "string", indexed: false }, { name: "tokenContext", type: "string", indexed: false },
    { name: "startingTick", type: "int24", indexed: false }, { name: "poolHook", type: "address", indexed: false },
    { name: "poolId", type: "bytes32", indexed: false }, { name: "pairedToken", type: "address", indexed: false },
    { name: "locker", type: "address", indexed: false }, { name: "mevModule", type: "address", indexed: false },
    { name: "extensionsSupply", type: "uint256", indexed: false }, { name: "extensions", type: "address[]", indexed: false },
  ],
}] as const;

// ---- helpers ----

const lc = (a: string | null | undefined) => (a ?? "").toLowerCase();
const isZero = (a: string | null | undefined) => !a || lc(a) === ZERO;
const clip = (s: unknown, n = 64) => (typeof s === "string" && s ? s.slice(0, n) : null);

/** Read that is allowed to fail: a secondary detail, never the verdict. */
async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

interface ClankerWorldRecord {
  contract_address?: string;
  chain_id?: number;
  type?: string;
  factory_address?: string;
  locker_address?: string;
  pool_address?: string;
  tx_hash?: string;
  msg_sender?: string;
  admin?: string;
  requestor_fid?: number | string | null;
  deployed_at?: string;
}

/** clanker.world's public token search, narrowed to an exact Base match.
 *  `ok: false` = the API could not be consulted; `record: null` = consulted,
 *  no listing. Its search is fuzzy, so anything but an exact address match on
 *  chain 8453 is ignored. */
async function clankerWorld(address: string): Promise<{ ok: boolean; record: ClankerWorldRecord | null }> {
  try {
    const res = await fetch(`${CLANKER_WORLD}?q=${address}&limit=5`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, record: null };
    const body = (await res.json()) as { data?: ClankerWorldRecord[] };
    if (!Array.isArray(body?.data)) return { ok: false, record: null };
    const hit = body.data.find((r) => lc(r.contract_address) === lc(address) && Number(r.chain_id ?? 8453) === 8453);
    return { ok: true, record: hit ?? null };
  } catch {
    return { ok: false, record: null };
  }
}

function factoryVersion(addr: string | undefined): Version | null {
  for (const [v, f] of Object.entries(CLANKER_FACTORIES)) if (lc(f) === lc(addr)) return v as Version;
  return null;
}

/** Fields the context JSON of a v3.1/v4 token carries; anything else is dropped
 *  (it is free text the deployer wrote). */
function parseContext(raw: unknown): { interface: string | null; platform: string | null; id: string | null } | null {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return null;
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    return { interface: clip(c.interface), platform: clip(c.platform), id: clip(String(c.id ?? "")) };
  } catch {
    return null;
  }
}

function v4PoolId(k: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

interface Liquidity {
  liquidityLocked: boolean | null;
  basis: string;
  locker: string | null;
  lockerReviewed: boolean;
  lpPositionManager: string | null;
  lpPositionIds: string[];
  lpHolders: string[];
  lockedUntil: string | null;
  pool: Record<string, unknown> | null;
  feeRecipients: { recipient: string; admin: string | null; bps: number }[] | null;
}

const emptyLiquidity = (basis: string, locker: string | null = null): Liquidity => ({
  liquidityLocked: null, basis, locker, lockerReviewed: !!locker && !!PERMANENT_LOCKERS[lc(locker)],
  lpPositionManager: null, lpPositionIds: [], lpHolders: [], lockedUntil: null, pool: null, feeRecipients: null,
});

/** Position NFTs held by a reviewed permanent locker → locked; any held elsewhere → not. */
function permanentVerdict(locker: string, holders: (string | null)[], pm: string): Pick<Liquidity, "liquidityLocked" | "basis"> {
  if (holders.some((h) => h === null)) return { liquidityLocked: null, basis: "LP position owner could not be read this call" };
  if (!PERMANENT_LOCKERS[lc(locker)]) {
    return { liquidityLocked: null, basis: `factory names locker ${locker}, which is not one of the Clanker lockers this check has reviewed — lock terms not evaluated` };
  }
  const away = holders.filter((h) => lc(h) !== lc(locker));
  if (away.length) return { liquidityLocked: false, basis: `${away.length} of ${holders.length} LP position(s) are not held by the Clanker locker (${pm} ownerOf)` };
  return {
    liquidityLocked: true,
    basis: `all ${holders.length} LP position NFT(s) are owned by the Clanker locker ${locker}, which has no function that withdraws or transfers a position — permanent`,
  };
}

/** v4 / v3.1: who sent the deploy, read from the factory's own TokenCreated in
 *  the deploy receipt. The tx hash comes from clanker.world; only an event the
 *  factory emitted for THIS token is believed. Detail only — null on any miss. */
async function deployEvent(token: Address, version: "v4" | "v3.1", txHash: string | null | undefined) {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const receipt = await soft(client.getTransactionReceipt({ hash: txHash as Hex }));
  if (!receipt || receipt.status !== "success") return null;
  const factory = lc(CLANKER_FACTORIES[version]);
  for (const log of receipt.logs) {
    if (lc(log.address) !== factory) continue;
    try {
      if (version === "v4") {
        const ev = decodeEventLog({ abi: tokenCreatedV4, data: log.data, topics: log.topics });
        if (lc(ev.args.tokenAddress) === lc(token)) return { msgSender: ev.args.msgSender, admin: ev.args.tokenAdmin, deployTx: txHash };
      } else {
        const ev = decodeEventLog({ abi: tokenCreatedV31, data: log.data, topics: log.topics });
        if (lc(ev.args.tokenAddress) === lc(token)) return { msgSender: ev.args.msgSender, admin: ev.args.creatorAdmin, deployTx: txHash };
      }
    } catch {
      /* not TokenCreated */
    }
  }
  return null;
}

// ---- per-version readers (secondary: a failure here costs detail, not the verdict) ----

async function readV4(token: Address, info: { hook: Address; locker: Address; extensions: readonly Address[] }, txHash?: string | null) {
  const missing: string[] = [];
  const [all, rewards, ev] = await Promise.all([
    soft(client.readContract({ address: token, abi: v4TokenAbi, functionName: "allData" })),
    soft(client.readContract({ address: info.locker, abi: v4LockerAbi, functionName: "tokenRewards", args: [token] })),
    deployEvent(token, "v4", txHash),
  ]);
  if (!all) missing.push("token.allData (requestor)");
  const ctx = all ? parseContext(all[4]) : null;
  const deployment = {
    requestor: all ? all[0] : ev?.admin ?? null,
    requestorSource: all ? "token.originalAdmin() — the admin set at deploy" : ev ? "TokenCreated.tokenAdmin in the deploy receipt" : null,
    deploySender: ev?.msgSender ?? null,
    deployTx: ev?.deployTx ?? null,
    currentAdmin: all ? all[1] : null,
    interface: ctx?.interface ?? null,
    platform: ctx?.platform ?? null,
    socialId: ctx?.id || null,
    hook: info.hook,
    extensionsCount: info.extensions.length,
  };

  let liquidity: Liquidity;
  if (!rewards || isZero(rewards.token)) {
    missing.push("locker.tokenRewards (LP positions)");
    liquidity = emptyLiquidity(rewards ? "locker holds no reward record for this token" : "locker could not be read this call", info.locker);
  } else {
    const n = Number(rewards.numPositions);
    const ids = Array.from({ length: Math.min(Math.max(n, 0), 10) }, (_, i) => rewards.positionId + BigInt(i));
    const holders = await Promise.all(
      ids.map((id) => soft(client.readContract({ address: UNI_V4_POSITIONS, abi: ownerOfAbi, functionName: "ownerOf", args: [id] }))),
    );
    if (holders.some((h) => h === null)) missing.push("Uniswap v4 PositionManager.ownerOf");
    const k = rewards.poolKey;
    liquidity = {
      ...permanentVerdict(info.locker, holders, "Uniswap v4 PositionManager"),
      locker: info.locker,
      lockerReviewed: !!PERMANENT_LOCKERS[lc(info.locker)],
      lpPositionManager: UNI_V4_POSITIONS,
      lpPositionIds: ids.map(String),
      lpHolders: [...new Set(holders.filter((h): h is Address => !!h))],
      lockedUntil: null,
      pool: {
        dex: "uniswap-v4",
        poolId: v4PoolId(k),
        currency0: k.currency0,
        currency1: k.currency1,
        pairedToken: lc(k.currency0) === lc(token) ? k.currency1 : k.currency0,
        hook: k.hooks,
        tickSpacing: k.tickSpacing,
      },
      feeRecipients: rewards.rewardRecipients.map((r, i) => ({ recipient: r, admin: rewards.rewardAdmins[i] ?? null, bps: Number(rewards.rewardBps[i] ?? 0) })),
    };
  }
  return { deployment, liquidity, missing };
}

async function readV2toV31(token: Address, version: "v3.1" | "v3" | "v2", positionId: bigint, locker: Address, txHash?: string | null) {
  const missing: string[] = [];
  const holderP = soft(client.readContract({ address: UNI_V3_POSITIONS, abi: ownerOfAbi, functionName: "ownerOf", args: [positionId] }));
  let deployment: Record<string, unknown>;
  if (version === "v3.1") {
    const [admin, context, ev] = await Promise.all([
      soft(client.readContract({ address: token, abi: tokenViewsAbi, functionName: "admin" })),
      soft(client.readContract({ address: token, abi: tokenViewsAbi, functionName: "context" })),
      deployEvent(token, "v3.1", txHash),
    ]);
    if (!admin && !ev) missing.push("token.admin / deploy receipt (requestor)");
    const ctx = parseContext(context);
    deployment = {
      requestor: ev?.admin ?? null,
      requestorSource: ev ? "TokenCreated.creatorAdmin in the deploy receipt" : null,
      deploySender: ev?.msgSender ?? null,
      deployTx: ev?.deployTx ?? null,
      currentAdmin: admin,
      interface: ctx?.interface ?? null,
      platform: ctx?.platform ?? null,
      socialId: ctx?.id || null,
    };
  } else {
    const [deployer, fid, castHash] = await Promise.all([
      soft(client.readContract({ address: token, abi: tokenViewsAbi, functionName: "deployer" })),
      soft(client.readContract({ address: token, abi: tokenViewsAbi, functionName: "fid" })),
      soft(client.readContract({ address: token, abi: tokenViewsAbi, functionName: "castHash" })),
    ]);
    if (!deployer) missing.push("token.deployer (requestor)");
    deployment = {
      requestor: deployer,
      requestorSource: deployer ? "token.deployer()" : null,
      farcasterFid: fid !== null && fid > 0n ? String(fid) : null,
      castHash: clip(castHash, 66),
    };
  }
  const holder = await holderP;
  if (!holder) missing.push("Uniswap v3 NonfungiblePositionManager.ownerOf");
  const liquidity: Liquidity = {
    ...permanentVerdict(locker, [holder], "Uniswap v3 NonfungiblePositionManager"),
    locker,
    lockerReviewed: !!PERMANENT_LOCKERS[lc(locker)],
    lpPositionManager: UNI_V3_POSITIONS,
    lpPositionIds: [String(positionId)],
    lpHolders: holder ? [holder] : [],
    lockedUntil: null,
    pool: { dex: "uniswap-v3" },
    feeRecipients: null,
  };
  return { deployment, liquidity, missing };
}

/** v0/v1: confirm from the deploy receipt that the factory emitted TokenCreated
 *  for this exact token. Returns null when the receipt holds no such log. */
async function verifyLegacyReceipt(token: Address, version: "v0" | "v1", txHash: Hex) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const factory = lc(CLANKER_FACTORIES[version]);
  for (const log of receipt.logs) {
    if (lc(log.address) !== factory) continue;
    try {
      if (version === "v0") {
        const ev = decodeEventLog({ abi: tokenCreatedV0, data: log.data, topics: log.topics });
        if (lc(ev.args.tokenAddress) === lc(token)) {
          return { lpNftId: ev.args.lpNftId, deployer: ev.args.deployer, locker: ev.args.lockerAddress, fid: null as string | null, castHash: null as string | null, status: receipt.status };
        }
      } else {
        const ev = decodeEventLog({ abi: tokenCreatedV1, data: log.data, topics: log.topics });
        if (lc(ev.args.tokenAddress) === lc(token)) {
          return { lpNftId: ev.args.lpNftId, deployer: ev.args.deployer, locker: ev.args.lockerAddress, fid: String(ev.args.fid), castHash: clip(ev.args.castHash, 66), status: receipt.status };
        }
      }
    } catch {
      /* another event from the factory (e.g. OwnershipTransferred) */
    }
  }
  return null;
}

async function readLegacyLiquidity(ev: { lpNftId: bigint; locker: Address }, apiLocker: string | undefined) {
  const missing: string[] = [];
  const holder = await soft(client.readContract({ address: UNI_V3_POSITIONS, abi: ownerOfAbi, functionName: "ownerOf", args: [ev.lpNftId] }));
  const out: Liquidity = {
    ...emptyLiquidity("", ev.locker),
    lpPositionManager: UNI_V3_POSITIONS,
    lpPositionIds: [String(ev.lpNftId)],
    lpHolders: holder ? [holder] : [],
    pool: { dex: "uniswap-v3" },
  };
  if (!holder) {
    missing.push("Uniswap v3 NonfungiblePositionManager.ownerOf");
    return { liquidity: { ...out, basis: "LP position owner could not be read this call" }, missing };
  }
  if (lc(holder) === lc(ev.locker)) {
    const end = await soft(client.readContract({ address: ev.locker, abi: timeLockAbi, functionName: "end" }));
    if (end === null) {
      missing.push("locker.end()");
      return { liquidity: { ...out, basis: "LP NFT is in the deploy-time Clanker time lock, but its end() could not be read" }, missing };
    }
    const until = new Date(Number(end) * 1000).toISOString();
    if (Number(end) * 1000 > Date.now()) {
      return { liquidity: { ...out, liquidityLocked: true, lockedUntil: until, basis: `LP NFT is held by the Clanker time lock created at deploy (the factory-recorded locker), whose end() is ${until}` }, missing };
    }
    return { liquidity: { ...out, liquidityLocked: false, lockedUntil: until, basis: `LP NFT is still in the deploy-time Clanker time lock, but that lock ended ${until} and the position can be released` }, missing };
  }
  const listed = apiLocker && lc(apiLocker) === lc(holder);
  return {
    liquidity: {
      ...out,
      basis: listed
        ? `LP NFT has moved out of the deploy-time time lock to ${holder}, the locker clanker.world lists for this token; that contract's lock terms are not evaluated here`
        : `LP NFT has moved out of the deploy-time Clanker time lock and is now held by ${holder}; lock terms not evaluated`,
    },
    missing,
  };
}

// ---- handler ----

export async function clankerTokenAudit(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… token address");
  const token = getAddress(raw);

  const apiP = clankerWorld(token);

  // Core reads: the bytecode and every factory that keeps a per-token record.
  // One batched round trip; any failure means no verdict and no charge.
  let code: Hex | undefined;
  let v4: { token: Address; hook: Address; locker: Address; extensions: readonly Address[] };
  let legacy: Record<"v3.1" | "v3" | "v2", readonly [Address, bigint, Address]>;
  try {
    const [c, r4, r31, r3, r2] = await Promise.all([
      client.getCode({ address: token }),
      client.readContract({ address: CLANKER_FACTORIES.v4, abi: v4FactoryAbi, functionName: "tokenDeploymentInfo", args: [token] }),
      client.readContract({ address: CLANKER_FACTORIES["v3.1"], abi: legacyFactoryAbi, functionName: "deploymentInfoForToken", args: [token] }),
      client.readContract({ address: CLANKER_FACTORIES.v3, abi: legacyFactoryAbi, functionName: "deploymentInfoForToken", args: [token] }),
      client.readContract({ address: CLANKER_FACTORIES.v2, abi: legacyFactoryAbi, functionName: "deploymentInfoForToken", args: [token] }),
    ]);
    code = c;
    v4 = r4;
    legacy = { "v3.1": r31, v3: r3, v2: r2 };
  } catch {
    throw new Error("Base RPC unavailable — could not read the Clanker factories; not charged, retry shortly");
  }

  const api = await apiP;
  const sources: string[] = [
    "Base RPC: Clanker v4 factory tokenDeploymentInfo()",
    "Base RPC: Clanker v3.1 / v3 / v2 factory deploymentInfoForToken()",
    "Base RPC: token bytecode (v0/v1 fingerprint)",
  ];
  const missing: string[] = [];
  if (api.ok) sources.push("clanker.world /api/tokens (cross-check)");
  else missing.push("clanker.world cross-check");

  const isContract = !!code && code !== "0x";
  const delegatedEoa = isContract && code!.toLowerCase().startsWith("0xef0100");
  const codeId = isContract && !delegatedEoa ? keccak256(code!) : null;

  const names = isContract && !delegatedEoa
    ? await Promise.all([
        soft(client.readContract({ address: token, abi: tokenViewsAbi, functionName: "name" })),
        soft(client.readContract({ address: token, abi: tokenViewsAbi, functionName: "symbol" })),
      ])
    : [null, null];
  const name = clip(names[0], 80);
  const symbol = clip(names[1], 32);

  const apiView = (version: Version | null) => {
    const r = api.record;
    if (!api.ok) return { consulted: false, listed: null, agreesWithOnchain: null };
    if (!r) return { consulted: true, listed: false, agreesWithOnchain: version === null ? true : null };
    const apiVersion = factoryVersion(r.factory_address);
    return {
      consulted: true,
      listed: true,
      type: clip(r.type, 24),
      factory: r.factory_address ?? null,
      locker: r.locker_address ?? null,
      deployTx: r.tx_hash ?? null,
      requestorFid: r.requestor_fid != null && r.requestor_fid !== "" ? String(r.requestor_fid) : null,
      deployedAt: clip(r.deployed_at, 32),
      agreesWithOnchain: version !== null && apiVersion === version,
    };
  };

  const finish = (o: {
    verdict: "clanker_verified" | "not_clanker" | "unknown";
    version: Version | null;
    evidence: string;
    deployment?: Record<string, unknown> | null;
    liquidity?: Liquidity | null;
    refusal?: string;
    recommendation: string;
    claimsClanker?: boolean;
  }) => {
    const refused = o.verdict === "unknown";
    const receipt = decisionReceipt({
      endpoint: ENDPOINT,
      params: { address: token },
      degraded: refused,
      missing: refused ? [o.refusal ?? "clanker deployment record"] : missing,
      refusalReason: refused ? o.refusal : undefined,
      confidenceBasis: refused
        ? "no deployment record could be confirmed either way — not a verdict"
        : missing.length
          ? "factory records read onchain; some secondary detail was unavailable this call"
          : undefined,
    });
    return {
      address: token,
      verdict: o.verdict,
      isClanker: o.verdict === "clanker_verified" ? true : o.verdict === "not_clanker" ? false : null,
      clankerVersion: o.version,
      factory: o.version ? CLANKER_FACTORIES[o.version] : null,
      name,
      symbol,
      isContract: isContract && !delegatedEoa,
      evidence: o.evidence,
      deployment: o.deployment ?? null,
      liquidityLocked: o.liquidity?.liquidityLocked ?? null,
      liquidity: o.liquidity ?? null,
      ...(o.claimsClanker !== undefined ? { claimsClanker: o.claimsClanker } : {}),
      clankerWorld: apiView(o.version),
      sources,
      recommendation: o.recommendation,
      note: "Clanker's own factory contracts are the source of truth; clanker.world is a cross-check. 'Launched through Clanker' says how a token was created, not that it is safe to buy. Not financial advice.",
      receipt: {
        endpoint: ENDPOINT,
        decision: o.verdict === "clanker_verified" ? "VERIFIED" : o.verdict === "not_clanker" ? "NOT_CLANKER" : "REFUSE",
        ...receipt,
      },
      checkedAt: new Date().toISOString(),
    };
  };

  // ---- 1. v4 / v3.1 / v3 / v2: the factory's own record ----
  if (!isZero(v4.token) && lc(v4.token) === lc(token)) {
    const r = await readV4(token, v4, api.record?.tx_hash);
    missing.push(...r.missing);
    sources.push("Base RPC: Clanker v4 locker tokenRewards(), Uniswap v4 PositionManager ownerOf(), token allData()");
    return finish({
      verdict: "clanker_verified",
      version: "v4",
      evidence: `Clanker v4 factory ${CLANKER_FACTORIES.v4} tokenDeploymentInfo() returns a deployment record for this token (hook ${v4.hook}, locker ${v4.locker})`,
      deployment: r.deployment,
      liquidity: r.liquidity,
      recommendation: lockLine("v4", r.liquidity),
    });
  }
  for (const version of ["v3.1", "v3", "v2"] as const) {
    const [rec, positionId, locker] = legacy[version];
    if (isZero(rec) || lc(rec) !== lc(token)) continue;
    const r = await readV2toV31(token, version, positionId, locker, api.record?.tx_hash);
    missing.push(...r.missing);
    sources.push("Base RPC: Uniswap v3 NonfungiblePositionManager ownerOf(), token deployer/admin views");
    return finish({
      verdict: "clanker_verified",
      version,
      evidence: `Clanker ${version} factory ${CLANKER_FACTORIES[version]} deploymentInfoForToken() returns a deployment record for this token (LP position #${positionId}, locker ${locker})`,
      deployment: r.deployment,
      liquidity: r.liquidity,
      recommendation: lockLine(version, r.liquidity),
    });
  }

  // ---- 2. no contract (or a delegated EOA): not a token at all ----
  if (!isContract || delegatedEoa) {
    return finish({
      verdict: "not_clanker",
      version: null,
      evidence: delegatedEoa
        ? "address is an EIP-7702 delegated account, not a token contract; no Clanker factory has a record for it"
        : "no contract code at this address on Base, and no Clanker factory has a record for it",
      recommendation: "This is not a token contract on Base, so it was not launched through Clanker. Check the address.",
    });
  }

  // ---- 3. v0 / v1: fingerprint, then the deploy receipt ----
  const legacyVersion = codeId ? LEGACY_CODE[codeId] : undefined;
  if (legacyVersion) {
    sources.push(`Base RPC: deploy transaction receipt (TokenCreated from the ${legacyVersion} factory)`);
    if (!api.ok) {
      throw new Error(`Bytecode matches Clanker ${legacyVersion} tokens; confirming needs the deploy transaction, and clanker.world is unavailable — not charged, retry shortly`);
    }
    const txHash = api.record?.tx_hash;
    if (!api.record || !txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return finish({
        verdict: "unknown",
        version: null,
        evidence: `bytecode is identical to Clanker ${legacyVersion} tokens, but no deploy transaction is listed for this address, so the factory's TokenCreated event cannot be checked; identical bytecode alone does not prove which contract deployed it`,
        refusal: "no_deploy_record_for_legacy_bytecode",
        recommendation: "Cannot confirm a Clanker launch either way. Treat it as unverified.",
      });
    }
    let ev: Awaited<ReturnType<typeof verifyLegacyReceipt>>;
    try {
      ev = await verifyLegacyReceipt(token, legacyVersion, txHash as Hex);
    } catch {
      throw new Error("Base RPC could not return the deploy transaction receipt — not charged, retry shortly");
    }
    if (!ev || ev.status !== "success") {
      return finish({
        verdict: "unknown",
        version: null,
        evidence: `clanker.world lists deploy transaction ${txHash}, but its receipt holds no TokenCreated event from the Clanker ${legacyVersion} factory for this token`,
        refusal: "listed_deploy_tx_does_not_match",
        recommendation: "The listed launch record does not check out onchain. Treat it as unverified.",
      });
    }
    const lq = await readLegacyLiquidity(ev, api.record.locker_address);
    missing.push(...lq.missing);
    sources.push("Base RPC: Uniswap v3 NonfungiblePositionManager ownerOf(), Clanker time lock end()");
    return finish({
      verdict: "clanker_verified",
      version: legacyVersion,
      evidence: `deploy transaction ${txHash} was sent to the Clanker ${legacyVersion} factory ${CLANKER_FACTORIES[legacyVersion]}, which emitted TokenCreated for this token (bytecode also matches ${legacyVersion} tokens)`,
      deployment: {
        // v1 records the requester's address; v0's `deployer` is the Clanker
        // bot that sent every v0 launch, so there the fid is the requester.
        requestor: legacyVersion === "v1" ? ev.deployer : null,
        requestorSource:
          legacyVersion === "v1"
            ? "TokenCreated.deployer in the deploy receipt"
            : "v0 TokenCreated records only the Clanker bot that sent the deploy; the requester is the Farcaster fid",
        deploySender: ev.deployer,
        farcasterFid: ev.fid ?? (api.record.requestor_fid != null && api.record.requestor_fid !== "" ? String(api.record.requestor_fid) : null),
        fidSource: ev.fid ? "deploy receipt" : api.record.requestor_fid != null ? "clanker.world" : null,
        castHash: ev.castHash,
        deployTx: txHash,
      },
      liquidity: lq.liquidity,
      recommendation: lockLine(legacyVersion, lq.liquidity),
    });
  }

  // ---- 4. no record anywhere onchain ----
  const apiVersion = api.record ? factoryVersion(api.record.factory_address) : null;
  if (api.ok && api.record) {
    // clanker.world lists it but no factory we read has it: our view is
    // incomplete (a factory we do not know), so do not answer "no".
    return finish({
      verdict: "unknown",
      version: null,
      evidence: `clanker.world lists this token (type ${clip(api.record.type, 24) ?? "?"}, factory ${api.record.factory_address ?? "?"}), but none of the Clanker factories this check reads has a record for it${apiVersion ? "" : " — that factory is not one this check knows"}`,
      refusal: "listed_by_clanker_world_without_factory_record",
      recommendation: "Records disagree. Treat the Clanker origin as unverified until the factory record can be read.",
    });
  }
  const claimsClanker = /clank/i.test(`${name ?? ""} ${symbol ?? ""}`);
  return finish({
    verdict: "not_clanker",
    version: null,
    evidence: "no deployment record in the Clanker v4, v3.1, v3 or v2 factories, and the bytecode is not the v0/v1 Clanker token bytecode",
    claimsClanker,
    recommendation: claimsClanker
      ? "Its name or symbol mentions Clanker, but there is no Clanker deployment record for this address. If it was presented to you as a Clanker launch, that claim does not check out."
      : "Not launched through any Clanker factory. That is a statement about origin, not a risk verdict.",
  });
}

function lockLine(version: Version, l: Liquidity): string {
  const head = `Launched through the Clanker ${version} factory.`;
  if (l.liquidityLocked === true) return `${head} Its launch liquidity is locked: ${l.basis}.`;
  if (l.liquidityLocked === false) return `${head} Its launch liquidity is NOT locked: ${l.basis}.`;
  return `${head} Lock status not established: ${l.basis}.`;
}
