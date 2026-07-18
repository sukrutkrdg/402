/**
 * EIP-8130 Native AA — session-key / actor audit. PROTOTYPE (Vibenet).
 *
 * NOT REGISTERED in services.ts yet: EIP-8130 ships on Base mainnet with the
 * Cobalt upgrade (September 2026). Until then there is nothing to read on
 * mainnet — this targets Base Vibenet (the ephemeral devnet where 8130 is live
 * early) so we can register the paid service the week Cobalt activates.
 *
 * What it reads (AccountConfiguration system contract, base/eip-8130):
 *  - ActorAuthorized / ActorRevoked event replay → every actor (session key /
 *    app permission) ever granted on the account, and the current set.
 *  - getActorConfig / getPolicy per actor → is the permission BOUNDED by a
 *    policy (manager + commitment) or a blank-check actor?
 *  - getLockStatus → account lock posture.
 * This is the 8130 sibling of spend-audit/wallet-delegation: the "who can act
 * as this account, within what bounds" drain-surface read.
 *
 * The system contract address is CREATE2-deterministic but build-dependent, so
 * we resolve it at call time: AA8130_CONFIG env wins; otherwise we discover it
 * by scanning recent blocks for the contract's own event signatures.
 */

import "server-only";
import { createPublicClient, http, getAddress, keccak256, toBytes, parseAbiItem } from "viem";
import { finish } from "./envelope";

const VIBENET_RPC = process.env.AA8130_RPC?.trim() || "https://rpc.vibes.base.org";
const VIBENET_CHAIN = {
  id: 84538453,
  name: "Base Vibenet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [VIBENET_RPC] } },
} as const;

const client = createPublicClient({ chain: VIBENET_CHAIN, transport: http(VIBENET_RPC, { timeout: 10_000 }) });

const ACTOR_AUTHORIZED = parseAbiItem("event ActorAuthorized(address indexed account, bytes32 indexed actorId, bytes actorData)");
const ACTOR_REVOKED = parseAbiItem("event ActorRevoked(address indexed account, bytes32 indexed actorId)");

const CONFIG_ABI = [
  { type: "function", name: "isActor", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getPolicy", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "address" }, { type: "bytes32" }] },
  {
    type: "function", name: "getLockStatus", stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }, { type: "bool" }, { type: "uint40" }, { type: "uint16" }],
  },
] as const;

let cachedConfig: `0x${string}` | null = null;

/** Resolve the AccountConfiguration address: env override, else discover it by
 * scanning recent Vibenet blocks for ActorAuthorized/AccountCreated topics. */
async function resolveConfigAddress(): Promise<`0x${string}` | null> {
  const env = process.env.AA8130_CONFIG?.trim();
  if (env && /^0x[0-9a-fA-F]{40}$/.test(env)) return getAddress(env) as `0x${string}`;
  if (cachedConfig) return cachedConfig;

  const head = await client.getBlockNumber();
  const topics = [
    keccak256(toBytes("ActorAuthorized(address,bytes32,bytes)")),
    keccak256(toBytes("AccountCreated(address,bytes32,bytes32)")),
  ];
  const SPAN = 40_000n; // ephemeral devnet — recent history is all there is
  for (const topic0 of topics) {
    try {
      const logs = await client.getLogs({
        fromBlock: head > SPAN ? head - SPAN : 0n,
        toBlock: head,
        // viem types want an event; raw topic filtering is fine at RPC level
        ...({ topics: [topic0] } as object),
      });
      if (logs.length) {
        cachedConfig = getAddress(logs[logs.length - 1].address) as `0x${string}`;
        return cachedConfig;
      }
    } catch {
      /* range too wide or RPC limit — fall through */
    }
  }
  return null;
}

export async function aa8130SessionKeyAudit(params: Record<string, string>) {
  const account = (params.account || params.wallet || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error("Provide a valid 0x… account address (account=)");
  const acct = getAddress(account) as `0x${string}`;

  const config = await resolveConfigAddress();
  if (!config) {
    return finish({
      network: "base-vibenet",
      account: acct,
      verdict: "no_8130_activity",
      note: "No EIP-8130 AccountConfiguration activity discoverable on this Vibenet instance (it is ephemeral and resets). Set AA8130_CONFIG to pin the system contract address. On Base mainnet this surface activates with the Cobalt upgrade (Sept 2026).",
    });
  }

  // Replay the account's actor history straight from the system contract.
  const head = await client.getBlockNumber();
  const from = head > 40_000n ? head - 40_000n : 0n;
  const [granted, revoked] = await Promise.all([
    client.getLogs({ address: config, event: ACTOR_AUTHORIZED, args: { account: acct }, fromBlock: from, toBlock: head }),
    client.getLogs({ address: config, event: ACTOR_REVOKED, args: { account: acct }, fromBlock: from, toBlock: head }),
  ]);

  const revokedIds = new Set(revoked.map((l) => String(l.args.actorId).toLowerCase()));
  const actorIds = [...new Set(granted.map((l) => String(l.args.actorId).toLowerCase()))];

  const actors: Array<Record<string, unknown>> = [];
  for (const id of actorIds) {
    const actorId = id as `0x${string}`;
    let active = !revokedIds.has(id);
    try {
      active = (await client.readContract({ address: config, abi: CONFIG_ABI, functionName: "isActor", args: [acct, actorId] })) as boolean;
    } catch { /* keep replay-derived state */ }
    let policyManager: string | null = null;
    let policyCommitment: string | null = null;
    try {
      const [target, commitment] = (await client.readContract({ address: config, abi: CONFIG_ABI, functionName: "getPolicy", args: [acct, actorId] })) as [string, string];
      policyManager = target && !/^0x0{40}$/i.test(target) ? getAddress(target) : null;
      policyCommitment = commitment && !/^0x0{64}$/i.test(commitment) ? commitment : null;
    } catch { /* pre-policy actor */ }
    actors.push({
      actorId: id,
      active,
      bounded: Boolean(policyManager || policyCommitment),
      policyManager,
      policyCommitment,
    });
  }

  let lock: Record<string, unknown> | null = null;
  try {
    const [locked, hasInitiatedUnlock, unlocksAt, unlockDelay] = (await client.readContract({
      address: config, abi: CONFIG_ABI, functionName: "getLockStatus", args: [acct],
    })) as unknown as [boolean, boolean, bigint | number, number];
    lock = { locked, hasInitiatedUnlock, unlocksAt: Number(unlocksAt) || null, unlockDelay: Number(unlockDelay) || null };
  } catch { /* account not initialized in the system contract */ }

  const activeActors = actors.filter((a) => a.active);
  const unbounded = activeActors.filter((a) => !a.bounded);
  const verdict = activeActors.length === 0
    ? "no_active_actors"
    : unbounded.length
      ? "unbounded_actors"
      : "bounded_actors";

  return finish({
    network: "base-vibenet",
    systemContract: config,
    account: acct,
    verdict, // no_active_actors | bounded_actors | unbounded_actors | no_8130_activity
    actorCount: activeActors.length,
    unboundedCount: unbounded.length,
    revokedCount: revokedIds.size,
    actors,
    lock,
    recommendation: verdict === "unbounded_actors"
      ? `⚠️ ${unbounded.length} active actor(s) have NO policy binding — they can act as this account without onchain bounds. Bind a policy or revoke any actor you don't recognize.`
      : verdict === "bounded_actors"
        ? "Every active actor is policy-bound — permissions are scoped and revocable. Review the policy managers if any are unfamiliar."
        : "No active actors — nothing can act as this account through EIP-8130 right now.",
    note: "PROTOTYPE (Vibenet): the EIP-8130 session-key/actor drain-surface audit — every actor authorized on the account (the native-AA sibling of spend permissions), whether each is policy-bounded, and the account's lock posture. Registers as a paid mainnet service when Cobalt activates. Not financial advice.",
  });
}
