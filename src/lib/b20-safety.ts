/**
 * B20 services — everything that reads Base's native B20 token precompiles.
 *
 * B20 (live 2026-07-08) adds powers ERC-20 never had: an issuer can gate
 * transfers via a Policy Registry blocklist and call burnBlocked() to BURN a
 * blocked holder's balance (protocol-level seize). These services read those
 * powers straight from the precompiles.
 *
 * Public Base RPC rate-limits parallel eth_calls, so every read is sequential
 * with a small delay + retry (a clean contract revert falls through immediately).
 */

import "server-only";
import { createPublicClient, getAddress, keccak256, toBytes, parseAbiItem } from "viem";
import { baseTransport } from "./base-transport";
import { base } from "viem/chains";

// Fixed B20 precompile addresses (same on every network).
export const B20_FACTORY = "0xB20f000000000000000000000000000000000000" as const;
export const B20_ACTIVATION_REGISTRY = "0x8453000000000000000000000000000000000001" as const;
export const B20_POLICY_REGISTRY = "0x8453000000000000000000000000000000000002" as const;

const client = createPublicClient({
  chain: base,
  transport: baseTransport(8000),
});

// IB20 view surface.
const B20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "supplyCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isPaused", stateMutability: "view", inputs: [{ type: "uint8" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "policyId", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// IPolicyRegistry: is an account authorized under a policy?
const POLICY_ABI = [
  { type: "function", name: "isAuthorized", stateMutability: "view", inputs: [{ type: "uint64" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;

// B20Factory: the AUTHORITATIVE "is this a real B20" check. A malicious EVM
// contract can implement supplyCap()/policyId() and (with a vanity 0xB200…
// address) impersonate a B20 — only the factory can't be faked.
const FACTORY_ABI = [
  { type: "function", name: "isB20", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "isB20Initialized", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

// B20Factory event, for the launch radar.
const B20_CREATED = parseAbiItem(
  "event B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)",
);

// Policy scope ids are keccak256 of the label (per B20Constants).
const TRANSFER_SENDER_POLICY = keccak256(toBytes("TRANSFER_SENDER_POLICY"));
const TRANSFER_RECEIVER_POLICY = keccak256(toBytes("TRANSFER_RECEIVER_POLICY"));
const TRANSFER_EXECUTOR_POLICY = keccak256(toBytes("TRANSFER_EXECUTOR_POLICY"));
const MINT_RECEIVER_POLICY = keccak256(toBytes("MINT_RECEIVER_POLICY"));
// PausableFeature enum: TRANSFER=0, MINT=1, BURN=2. B20Variant enum: Asset=0, Stablecoin=1.
const MAX_SUPPLY_CAP = (1n << 128n) - 1n; // uint128.max == "no cap" sentinel
const WAD = 10n ** 18n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read with retry, distinguishing two very different failures:
 *  - a CONTRACT-LEVEL error (revert / no-data / decode) means the contract
 *    effectively answered "no" (not a B20, no such policy) → return `fallback`.
 *  - a TRANSPORT error (timeout / network / rate-limit / 5xx) means we DON'T KNOW
 *    → throw, so a seize/freeze-critical read can never silently become 0n/null
 *    and read as "safe"/"not a B20".
 * Callers that want best-effort on a cosmetic field (name/symbol/…) pass
 * `softFallback`, which returns the fallback even on a transport failure.
 *
 * We classify by transport signatures only, and default the ambiguous case to
 * `fallback` (the historical behaviour) — so a plain ERC-20 whose missing
 * function surfaces an unusual error still reads as "not a B20", never a 500.
 */
function isTransportError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /timeout|timed out|fetch failed|network|socket|econn|etimed|dns|rate.?limit|too many request|429|50[0234]|bad gateway|gateway time|service unavailable|could not be reached|connection (?:closed|refused|reset)|request failed with status/.test(msg);
}
async function withRetry<T>(call: () => Promise<T>, fallback: T, softFallback = false): Promise<T> {
  let lastErr: unknown;
  let sawTransport = false;
  for (let i = 0; i < 3; i++) {
    try {
      return await call();
    } catch (e) {
      lastErr = e;
      if (!isTransportError(e)) return fallback; // contract-level "no" — real answer
      sawTransport = true;
      if (i === 2) break;
      await sleep(300);
    }
  }
  if (softFallback || !sawTransport) return fallback;
  throw new Error(`B20 read unavailable (RPC): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---- Shared: read the core signals from a token precompile ----

export interface B20Signals {
  isB20: boolean;
  variant: "asset" | "stablecoin" | null;
  symbol: string | null;
  supplyCap: bigint;
  canSeize: boolean;
  transferGated: boolean;
  senderPolicyId: bigint;
  /** Transfers can only be executed by allowlisted executors (a third-party gate). */
  executorGated: boolean;
  /** New supply can only be minted to allowlisted receivers (mint is restricted). */
  mintGated: boolean;
  paused: { transfer: boolean; mint: boolean; burn: boolean };
  rebase: boolean;
  supplyCapped: boolean;
  /** True when a seize/freeze-critical read failed (RPC) — verdict must not be trusted as safe. */
  degraded: boolean;
}

async function readB20Signals(addr: `0x${string}`): Promise<B20Signals> {
  const empty: B20Signals = {
    isB20: false, variant: null, symbol: null, supplyCap: 0n, canSeize: false,
    transferGated: false, senderPolicyId: 0n, executorGated: false, mintGated: false,
    paused: { transfer: false, mint: false, burn: false },
    rebase: false, supplyCapped: false, degraded: false,
  };

  // One multicall (Multicall3, a single eth_call) instead of 8 sequential reads
  // with sleeps — B20 precompiles answer staticcalls, so this works and is ~1s
  // vs ~3s. supplyCap failure = not a B20 (reverts / no data on a plain ERC-20).
  const contracts = [
    { address: addr, abi: B20_ABI, functionName: "supplyCap" },
    { address: addr, abi: B20_ABI, functionName: "symbol" },
    { address: addr, abi: B20_ABI, functionName: "multiplier" },
    { address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_SENDER_POLICY] },
    { address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_RECEIVER_POLICY] },
    { address: addr, abi: B20_ABI, functionName: "isPaused", args: [0] },
    { address: addr, abi: B20_ABI, functionName: "isPaused", args: [1] },
    { address: addr, abi: B20_ABI, functionName: "isPaused", args: [2] },
    { address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_EXECUTOR_POLICY] },
    { address: addr, abi: B20_ABI, functionName: "policyId", args: [MINT_RECEIVER_POLICY] },
    { address: B20_FACTORY, abi: FACTORY_ABI, functionName: "isB20", args: [addr] },
  ] as const;

  type MC = { status: "success"; result: unknown } | { status: "failure"; error: Error };
  let r: MC[];
  try {
    r = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as unknown as MC[];
  } catch {
    // Whole-chain RPC failure (not a per-call revert) — retry once, else fail
    // LOUD. Returning `empty` here would read as "not a B20" and silently drop
    // real holdings (or clear a token we couldn't actually read).
    try {
      await sleep(400);
      r = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as unknown as MC[];
    } catch {
      throw new Error("B20 read unavailable (RPC) — try again shortly");
    }
  }

  const [scRes, symRes, multRes, spRes, rpRes, p0, p1, p2, exRes, mrRes, facRes] = r;
  if (scRes.status !== "success") return empty; // supplyCap reverted / no data → not a B20
  // Factory is the authority: a contract that answers supplyCap() but that the
  // factory disowns is a FAKE B20 (vanity-address impersonation) — not a B20.
  if (facRes?.status === "success" && facRes.result === false) return empty;
  const supplyCap = scRes.result as bigint;
  const symbol = symRes.status === "success" ? (symRes.result as string) : null;
  const variant: "asset" | "stablecoin" = multRes.status === "success" ? "asset" : "stablecoin";

  // On a confirmed B20, a failed policy/pause read = degraded (we must NOT read a
  // failed read as "no policy / not paused" and call a gated token safe). Covers
  // every gating input: sender/receiver/executor/mint policies + all pause flags.
  const degraded =
    spRes.status !== "success" ||
    rpRes.status !== "success" ||
    exRes?.status !== "success" ||
    mrRes?.status !== "success" ||
    p0.status !== "success" ||
    p1.status !== "success" ||
    p2.status !== "success" ||
    facRes?.status !== "success"; // couldn't confirm authenticity with the factory
  const senderPol = spRes.status === "success" ? (spRes.result as bigint) : 0n;
  const recvPol = rpRes.status === "success" ? (rpRes.result as bigint) : 0n;
  const execPol = exRes?.status === "success" ? (exRes.result as bigint) : 0n;
  const mintRecvPol = mrRes?.status === "success" ? (mrRes.result as bigint) : 0n;

  return {
    isB20: true, variant, symbol, supplyCap,
    canSeize: senderPol > 0n,
    transferGated: senderPol > 0n || recvPol > 0n || execPol > 0n,
    executorGated: execPol > 0n,
    mintGated: mintRecvPol > 0n,
    senderPolicyId: senderPol,
    paused: {
      transfer: p0.status === "success" ? (p0.result as boolean) : false,
      mint: p1.status === "success" ? (p1.result as boolean) : false,
      burn: p2.status === "success" ? (p2.result as boolean) : false,
    },
    rebase: variant === "asset",
    supplyCapped: supplyCap !== MAX_SUPPLY_CAP,
    degraded,
  };
}

const notB20 = (address: string) => ({
  address, isB20: false,
  note: "Not a B20 (Base-native) token — use token-risk / contract-danger for standard ERC-20 analysis.",
  checkedAt: new Date().toISOString(),
});

// ---- 1. B20 Token Safety — freeze/seize verdict ----

export async function b20Safety(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… token contract address");
  const s = await readB20Signals(getAddress(address));
  if (!s.isB20) return notB20(address);

  if (s.degraded) {
    return {
      address, isB20: true, variant: s.variant, symbol: s.symbol, verdict: "unknown", degraded: true,
      note: "⚠️ A seize/freeze-critical precompile read failed (RPC) — this token's risk could NOT be determined. Do not treat as safe; re-check.",
      checkedAt: new Date().toISOString(),
    };
  }

  const flags: string[] = [];
  let risk = 0;
  const add = (n: number, why: string) => { risk += n; flags.push(why); };
  if (s.paused.transfer) add(35, "Transfers are CURRENTLY paused — you can't move this token right now.");
  if (s.canSeize) add(35, "Sender blocklist policy is set — the issuer can block you and burnBlocked() (SEIZE) your balance.");
  if (s.transferGated) add(25, "Transfers are policy-gated — your address can be frozen/blocklisted.");
  if (s.rebase) add(15, "Asset variant with a mutable rebase multiplier — your balance can be scaled up/down.");
  if (!s.supplyCapped) add(10, "No supply cap — mintable without ceiling (dilution risk).");
  risk = Math.min(100, risk);
  const verdict = risk >= 60 ? "avoid" : risk >= 30 ? "caution" : "hold";

  return {
    address, isB20: true, variant: s.variant, symbol: s.symbol, riskScore: risk, verdict,
    powers: { seizable: s.canSeize, freezable: s.transferGated, executorGated: s.executorGated, mintGated: s.mintGated, pausedNow: s.paused.transfer, rebase: s.rebase, uncappedMint: !s.supplyCapped },
    flags,
    recommendation:
      verdict === "avoid" ? "Avoid holding size — the issuer can freeze or seize your balance at the protocol level."
        : verdict === "caution" ? "Usable but the issuer retains control (policy/rebase/uncapped). Size accordingly."
          : "No high-control powers detected — behaves close to a plain token.",
    note: "B20 is Base's native token standard. Unlike ERC-20, issuers can freeze (Policy Registry) and seize (burnBlocked) at the protocol level — this reads exactly those powers. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 2. B20 Token Info — full profile (data, not verdict) ----

export async function b20Info(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… token contract address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);

  await sleep(120);
  const name = await withRetry<string | null>(() => client.readContract({ address: addr, abi: B20_ABI, functionName: "name" }) as Promise<string | null>, null, true);
  await sleep(120);
  const decimals = await withRetry<number | null>(() => client.readContract({ address: addr, abi: B20_ABI, functionName: "decimals" }) as Promise<number | null>, null, true);
  await sleep(120);
  const totalSupply = await withRetry<bigint>(() => client.readContract({ address: addr, abi: B20_ABI, functionName: "totalSupply" }) as Promise<bigint>, 0n, true);

  return {
    address, isB20: true, name, symbol: s.symbol, variant: s.variant, decimals,
    totalSupply: totalSupply.toString(),
    supplyCapped: s.supplyCapped,
    supplyCap: s.supplyCapped ? s.supplyCap.toString() : "uncapped",
    policies: { senderPolicyId: s.senderPolicyId.toString(), transferGated: s.transferGated, executorGated: s.executorGated, mintGated: s.mintGated },
    paused: s.paused,
    rebase: s.rebase,
    ...(s.degraded ? { degraded: true } : {}),
    note: s.degraded
      ? "⚠️ PARTIAL: a policy/pause precompile read failed (RPC) — the policies/paused fields may understate gating. Re-check before relying on this. For a risk verdict use b20-safety."
      : "B20 (Base-native) token profile read from the precompile. For a risk verdict use b20-safety; to check if YOUR wallet is blocked use b20-freeze-check.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 3. B20 Freeze Check — is a specific wallet blocked/seizable on this token? ----

export async function b20FreezeCheck(params: Record<string, string>) {
  const token = (params.token || params.address || "").trim();
  const wallet = (params.wallet || "").trim();
  if (!validAddr(token)) throw new Error("Provide a valid 0x… B20 token address (token=)");
  if (!validAddr(wallet)) throw new Error("Provide the wallet to check (wallet=)");
  const tokenAddr = getAddress(token);
  // Factory-authoritative authenticity — a lookalike implementing policyId() at a
  // vanity 0xB200… address can't spoof this (the supplyCap/policyId probe alone can).
  if (!(await isB20Token(tokenAddr))) return notB20(token);

  const senderPol = await withRetry<bigint | null>(
    () => client.readContract({ address: tokenAddr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_SENDER_POLICY] }) as Promise<bigint | null>, null);
  if (senderPol === null) return notB20(token);

  if (senderPol === 0n) {
    return {
      token, wallet, isB20: true, gated: false, authorized: true, verdict: "clear",
      note: "This B20 token has no sender policy — no blocklist/allowlist applies, so your address can't be frozen or burnBlocked-seized on the send side.",
      checkedAt: new Date().toISOString(),
    };
  }

  await sleep(120);
  // null sentinel = the registry read could not be completed (RPC error/revert).
  // We must NOT fall back to "authorized: true" — that would tell a genuinely
  // blocked wallet it is clear. On failure the answer is UNKNOWN, not clear.
  const authorized = await withRetry<boolean | null>(
    () => client.readContract({ address: B20_POLICY_REGISTRY, abi: POLICY_ABI, functionName: "isAuthorized", args: [senderPol, getAddress(wallet)] }) as Promise<boolean | null>, null, true);

  if (authorized === null) {
    return {
      token, wallet, isB20: true, gated: true, senderPolicyId: senderPol.toString(),
      authorized: null, verdict: "unknown", degraded: true,
      note: "⚠️ Could not read the Policy Registry right now (RPC error) — your authorization status is UNKNOWN, NOT confirmed clear. Do not treat this as safe; re-check before trusting it.",
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    token, wallet, isB20: true, gated: true, senderPolicyId: senderPol.toString(), authorized,
    verdict: authorized ? "clear" : "BLOCKED",
    note: authorized
      ? "Your wallet is currently authorized to transfer under this token's sender policy. (Issuer can change the policy at any time — re-check before large positions.)"
      : "⚠️ Your wallet is NOT authorized under this token's sender policy — you cannot transfer, and the issuer can burnBlocked() (SEIZE) your balance. Exit if you can.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 4. B20 Rebase Tracker — Asset variant multiplier ----

export async function b20Rebase(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  // Factory-authoritative authenticity before trusting multiplier() (a lookalike
  // implementing multiplier() at a vanity 0xB200… address can't spoof isB20).
  if (!(await isB20Token(addr))) return notB20(address);

  const mult = await withRetry<bigint | null>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "multiplier" }) as Promise<bigint | null>, null);

  if (mult === null) {
    // Factory already confirmed B20 above, so no multiplier ⇒ Stablecoin variant.
    return {
      address, isB20: true, variant: "stablecoin", rebase: false,
      note: "Stablecoin variant — no rebase multiplier. Balances are 1:1, no scaling risk.",
      checkedAt: new Date().toISOString(),
    };
  }

  const ratio = Number((mult * 10000n) / WAD) / 10000; // multiplier relative to 1.0
  return {
    address, isB20: true, variant: "asset", rebase: true,
    multiplier: mult.toString(), ratioToBase: ratio,
    note: ratio === 1
      ? "Asset variant, multiplier at baseline (1.0) — no active rebase right now, but the issuer can change it (your balance can be scaled up/down)."
      : `Asset variant with an active rebase multiplier (${ratio}× baseline) — your on-chain balance is scaled by this factor and the issuer can change it.`,
    checkedAt: new Date().toISOString(),
  };
}

// ---- 5. B20 Batch Safety — up to 5 tokens at once ----

export async function b20Batch(params: Record<string, string>) {
  const raw = (params.addresses || params.tokens || "").trim();
  const list = raw.split(/[,\s]+/).filter(validAddr).slice(0, 5);
  if (list.length === 0) throw new Error("Provide up to 5 comma-separated B20 token addresses (addresses=)");

  const results = [];
  for (const a of list) {
    try {
      const r = await b20Safety({ address: a });
      results.push(
        r.isB20
          ? { address: a, isB20: true, symbol: (r as { symbol?: string }).symbol ?? null, verdict: (r as { verdict?: string }).verdict, riskScore: (r as { riskScore?: number }).riskScore }
          : { address: a, isB20: false },
      );
    } catch {
      results.push({ address: a, error: "read unavailable — retry" }); // one bad RPC read shouldn't fail the whole paid batch
    }
    await sleep(150);
  }
  const worst = results.reduce((m, r) => Math.max(m, ("riskScore" in r ? r.riskScore ?? 0 : 0)), 0);
  // Tokens that couldn't be read (error) or came back degraded/unknown are NOT
  // scored 0 — surface them so worstRiskScore=0 can't read as "all 5 are safe".
  const unread = results.filter((r) => "error" in r || (r as { verdict?: string }).verdict === "unknown");
  return {
    count: results.length,
    worstRiskScore: worst,
    ...(unread.length ? { degraded: true, unreadCount: unread.length } : {}),
    results,
    note: unread.length
      ? `Batch B20 safety scan (max 5). ${unread.length} token(s) could not be fully scored this call — worstRiskScore covers only the ones that were. Re-check the rest. Not financial advice.`
      : "Batch B20 safety scan (max 5). Each is scored for freeze/seize/pause/rebase/uncapped-mint. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- B20 Pre-Trade Gate — one GO/HOLD/STOP decision for a B20 token ----

export async function b20Gate(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const wallet = (params.wallet || params.buyer || "").trim();
  const s = await readB20Signals(getAddress(address));
  if (!s.isB20) return { ...notB20(address), decision: "N/A" };
  if (s.degraded) {
    return {
      address, isB20: true, decision: "HOLD", degraded: true, variant: s.variant, symbol: s.symbol,
      note: "⚠️ A seize/freeze-critical precompile read failed (RPC) — B20 powers could NOT be confirmed. Do not treat as safe; re-check.",
      checkedAt: new Date().toISOString(),
    };
  }

  const observedRisks: string[] = [];
  let stop = false, hold = false;
  if (s.paused.transfer) { observedRisks.push("transfers PAUSED right now — you can't move it"); stop = true; }
  if (s.canSeize) { observedRisks.push("issuer can blocklist + burnBlocked() SEIZE your balance"); stop = true; }
  if (s.transferGated && !s.canSeize) { observedRisks.push("transfers policy-gated — freezable"); hold = true; }
  if (s.rebase) { observedRisks.push("mutable rebase multiplier — balance can be scaled up/down"); hold = true; }
  if (!s.supplyCapped) { observedRisks.push("uncapped mint — dilution risk"); hold = true; }

  // If a buyer wallet is given AND the token can seize, check whether THAT wallet
  // is already blocked — a terminal flag specific to the caller.
  let walletStatus: string | null = null;
  if (validAddr(wallet) && s.canSeize) {
    const fc = (await b20FreezeCheck({ token: address, wallet })) as { verdict?: string };
    walletStatus = fc.verdict ?? null;
    if (fc.verdict === "BLOCKED") { observedRisks.push("YOUR wallet is ALREADY blocked/seizable on this token"); stop = true; }
  }

  const decision = stop ? "STOP" : hold ? "HOLD" : "GO";
  return {
    address, isB20: true, variant: s.variant, symbol: s.symbol,
    wallet: validAddr(wallet) ? wallet : null, walletStatus, decision,
    powers: { seizable: s.canSeize, freezable: s.transferGated, executorGated: s.executorGated, mintGated: s.mintGated, pausedNow: s.paused.transfer, rebase: s.rebase, uncappedMint: !s.supplyCapped },
    observedRisks,
    receipt: {
      checked: address, decision, at: new Date().toISOString(), endpoint: "b20-gate", observedRisks,
      wouldChangeCall: stop
        ? "Nothing while a terminal B20 power (seize / paused-now) stands."
        : "Policy removal, a rebase lock, or a supply cap — re-check before sizing up.",
    },
    recommendation:
      decision === "STOP" ? "Do not hold size — the issuer can freeze or seize your balance at the protocol level."
        : decision === "HOLD" ? "Tradeable with caution — the issuer retains B20 control powers; size down."
          : "No high-control B20 powers detected — behaves close to a plain token.",
    note: "B20-specific pre-trade gate: seize (burnBlocked) + freeze (Policy Registry) + rebase + pause + uncapped mint, collapsed to one verdict. Pass wallet= to also check if YOUR address is already blocked. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- B20 Transfer Preflight — will THIS specific transfer clear right now? ----

/**
 * Every other B20 check is per-token or per-wallet due diligence, bought once.
 * This is the PER-TRANSFER rail check an agent runs on every payment: given
 * (token, from, to), does this exact transfer clear NOW? It resolves the sender
 * policy against `from`, the receiver policy against `to`, the executor policy
 * against an optional `executor`, plus the live transfer-pause state — one
 * GO/HOLD/STOP. Any read it can't complete degrades to HOLD, never a false GO.
 */
export async function b20TransferPreflight(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  const from = (params.from || params.sender || "").trim();
  const to = (params.to || params.recipient || "").trim();
  const executor = (params.executor || params.spender || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address (address=)");
  if (!validAddr(from)) throw new Error("Provide the sender address (from=)");
  if (!validAddr(to)) throw new Error("Provide the recipient address (to=)");
  const addr = getAddress(address);

  const s = await readB20Signals(addr);
  if (!s.isB20) return { ...notB20(address), decision: "N/A" };
  if (s.degraded) {
    return {
      address, isB20: true, decision: "HOLD", degraded: true, variant: s.variant, symbol: s.symbol,
      note: "⚠️ A policy/pause precompile read failed (RPC) — this transfer could NOT be cleared. Re-check; do not treat as GO.",
      checkedAt: new Date().toISOString(),
    };
  }
  const pids = await readPolicyIds(addr);
  if (!pids) return { ...notB20(address), decision: "N/A" };

  // isAuthorized(policyId, account): true = allowed, false = blocked, null = read
  // failed (→ unknown, degrade to HOLD, never a false GO).
  const authOf = async (policyId: bigint, account: string): Promise<boolean | null> => {
    if (policyId === 0n) return true; // no policy on this leg → not gated
    return withRetry<boolean | null>(
      () => client.readContract({ address: B20_POLICY_REGISTRY, abi: POLICY_ABI, functionName: "isAuthorized", args: [policyId, getAddress(account)] }) as Promise<boolean | null>,
      null,
      true, // soft: an RPC failure returns null → we degrade the verdict, not 500
    );
  };

  await sleep(120);
  const senderOk = await authOf(pids.sender, from);
  await sleep(120);
  const receiverOk = await authOf(pids.receiver, to);
  let executorOk: boolean | null = true;
  if (pids.executor !== 0n) {
    // Executor policy gates WHO may execute the transfer (transferFrom operator).
    // Check the given executor; if none supplied, the executor leg is unknown.
    await sleep(120);
    executorOk = validAddr(executor) ? await authOf(pids.executor, executor) : null;
  }

  const legs = [
    { leg: "sender", policyId: pids.sender.toString(), party: from, type: policyType(pids.sender), authorized: senderOk },
    { leg: "receiver", policyId: pids.receiver.toString(), party: to, type: policyType(pids.receiver), authorized: receiverOk },
    ...(pids.executor !== 0n ? [{ leg: "executor", policyId: pids.executor.toString(), party: validAddr(executor) ? executor : null, type: policyType(pids.executor), authorized: executorOk }] : []),
  ];

  const observedRisks: string[] = [];
  let stop = false, hold = false;
  if (s.paused.transfer) { observedRisks.push("transfers are PAUSED on this token right now — nothing moves"); stop = true; }
  if (senderOk === false) { observedRisks.push("sender is NOT authorized under the sender policy — this transfer reverts (and the sender is burnBlocked-seizable)"); stop = true; }
  if (receiverOk === false) { observedRisks.push("recipient is NOT authorized under the receiver policy — this transfer reverts (recipient not whitelisted)"); stop = true; }
  if (executorOk === false) { observedRisks.push("executor is NOT authorized under the executor policy — a transferFrom by this operator reverts"); stop = true; }
  const unknownLegs = legs.filter((l) => l.authorized === null).map((l) => l.leg);
  if (unknownLegs.length) { observedRisks.push(`could not confirm the ${unknownLegs.join(" + ")} authorization this call`); hold = true; }
  if (pids.executor !== 0n && !validAddr(executor)) { observedRisks.push("this token gates the EXECUTOR too — pass executor= (the transferFrom operator) to fully clear a delegated transfer"); hold = true; }

  const decision = stop ? "STOP" : hold ? "HOLD" : "GO";
  return {
    address, isB20: true, variant: s.variant, symbol: s.symbol,
    from, to, executor: validAddr(executor) ? executor : null,
    decision, // GO | HOLD | STOP — would this exact transfer clear now?
    pausedNow: s.paused.transfer,
    legs, // per-policy leg: which party, policy type, authorized true/false/null
    observedRisks,
    receipt: {
      checked: `${short(from)}→${short(to)} · ${s.symbol ?? short(address)}`,
      decision, at: new Date().toISOString(), endpoint: "b20-transfer-preflight", observedRisks,
      wouldChangeCall: stop
        ? "Nothing while a policy blocks a party or transfers are paused — the transfer will revert."
        : "Authorize the pending party, an executor address, or an unpause — re-check immediately before submitting.",
    },
    recommendation:
      decision === "STOP" ? "Do NOT submit — this transfer will revert (or the sender is seizable). Resolve the blocked leg first."
        : decision === "HOLD" ? "Likely clears, but at least one leg couldn't be fully verified — re-check right before submitting."
          : "All policy legs authorized and transfers active — this exact transfer should clear now. Re-check just before submit (policies can change any block).",
    note: "Per-transfer B20 rail check: resolves sender/receiver/executor policies against the actual parties + live pause state for THIS transfer. State can change block to block — call immediately before submitting. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- B20 Portfolio Guard — which B20s in a wallet can freeze/seize it? ----

export async function b20Portfolio(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || "").trim();
  if (!validAddr(wallet)) throw new Error("Provide a wallet address (wallet=)");
  const w = getAddress(wallet);

  let contracts: string[];
  try {
    contracts = await walletTokenContracts(w);
  } catch {
    throw new Error("Wallet token balances unavailable (data provider) — try again shortly");
  }
  // B20 tokens live at deterministic 0xb200… addresses — prefilter cheaply, then
  // confirm each with the precompile read (a non-B20 that happens to share the
  // prefix is dropped by readB20Signals).
  const candidates = contracts.filter((a) => a.toLowerCase().startsWith("0xb200")).slice(0, 15);

  const holdings: Array<Record<string, unknown>> = [];
  const unreadable: string[] = [];
  for (const c of candidates) {
    let s: Awaited<ReturnType<typeof readB20Signals>>;
    try {
      s = await readB20Signals(getAddress(c));
    } catch {
      unreadable.push(c); // RPC failure ≠ not-a-B20 — surface it, don't drop it
      continue;
    }
    if (!s.isB20) continue;
    let walletBlocked: boolean | null = null;
    if (s.canSeize && !s.degraded) {
      const fc = (await b20FreezeCheck({ token: c, wallet })) as { verdict?: string };
      walletBlocked = fc.verdict === "BLOCKED" ? true : fc.verdict === "clear" ? false : null;
      await sleep(120);
    }
    holdings.push({
      token: c, symbol: s.symbol, variant: s.variant,
      seizable: s.canSeize, freezable: s.transferGated, pausedNow: s.paused.transfer, rebase: s.rebase,
      walletBlocked, degraded: s.degraded,
      risk: s.paused.transfer || s.canSeize ? "high" : s.transferGated || s.rebase ? "medium" : "low",
    });
    await sleep(150);
  }

  const blocked = holdings.filter((h) => h.walletBlocked === true);
  const seizable = holdings.filter((h) => h.seizable);
  // A holding whose seize/freeze status could not be fully read (multicall
  // sub-call failed, or the token was entirely unreadable) must not let the
  // portfolio read "clear" — that would hide an unknown seizable position.
  const degradedHoldings = holdings.filter((h) => h.degraded === true);
  const anyDegraded = degradedHoldings.length > 0 || unreadable.length > 0;
  const verdict = blocked.length
    ? "action_required"
    : seizable.length
      ? "exposed"
      : holdings.length
        ? (anyDegraded ? "clear_partial" : "clear")
        : (anyDegraded ? "unknown" : "no_b20");

  return {
    wallet, b20Count: holdings.length, seizableCount: seizable.length, blockedCount: blocked.length,
    verdict, holdings,
    ...(anyDegraded ? { degraded: true, unreadableCount: unreadable.length, unreadable, degradedHoldingsCount: degradedHoldings.length } : {}),
    recommendation:
      blocked.length ? `⚠️ You are ALREADY blocked/seizable on ${blocked.length} B20 token(s) — exit those positions if you can.`
        : seizable.length ? `${seizable.length} of your B20 holdings can be frozen/seized by their issuer. Watch policy changes (b20-policy-watch) and size accordingly.`
          : holdings.length
            ? anyDegraded
              ? `${holdings.length} B20 holding(s) read clean, but ${degradedHoldings.length + unreadable.length} could not be fully checked — re-scan before relying on this.`
              : "None of your B20 holdings have active freeze/seize powers set right now."
            : anyDegraded
              ? "Could not read your B20 holdings this call — re-scan shortly."
              : "No B20 (Base-native) tokens found in this wallet.",
    note: "Scans a wallet's B20 holdings for protocol-level freeze/seize powers and whether YOUR address is already blocked — the risk ERC-20 portfolio tools can't see. Only B20 tokens are analyzed. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 6b. B20 Policy Watch — did this token BECOME seizable/freezable? ----

import { cdpSql } from "./covalent";
import { dexTokenPairs } from "./upstream-cache";
import { kvLRange, kvGet, kvSet, kvIncr } from "./kv";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { getConfig } from "./config";
import { walletTokenContracts } from "./alchemy";

/**
 * The rug-prevention angle unique to B20: a token can launch clean and later
 * have a sender blocklist policy attached (PolicyUpdated) — silently becoming
 * seizable via burnBlocked. This reads the token's PolicyUpdated / Paused /
 * Unpaused event history from the CDP SQL API (which indexes all B20 events)
 * and combines it with the live policy state.
 */
export async function b20PolicyWatch(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const a = addr.toLowerCase();

  // Factory-authoritative authenticity — a lookalike implementing supplyCap() at a
  // vanity 0xB200… address (and emitting fake PolicyUpdated logs) can't spoof this,
  // so its forged policy history isn't served as a real seize/freeze verdict.
  if (!(await isB20Token(addr))) return notB20(address);

  // Live policy state (authoritative "now").
  await sleep(120);
  const senderPol = await withRetry<bigint>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_SENDER_POLICY] }) as Promise<bigint>,
    0n,
  );
  await sleep(120);
  const recvPol = await withRetry<bigint>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_RECEIVER_POLICY] }) as Promise<bigint>,
    0n,
  );

  // Event history from CDP SQL (45-day window; B20 mainnet is younger than that).
  const rows = await cdpSql<{
    block_timestamp?: string;
    event_signature?: string;
    parameters?: { oldPolicyId?: string; newPolicyId?: string; features?: string; updater?: string };
    topics?: string[];
  }>(
    `SELECT block_timestamp, event_signature, parameters, topics FROM base.events WHERE address = '${a}' AND event_name IN ('PolicyUpdated','Paused','Unpaused') AND block_timestamp > now() - INTERVAL 45 DAY ORDER BY block_timestamp ASC LIMIT 50`,
  );

  const scopeName = (t?: string) =>
    t === TRANSFER_SENDER_POLICY ? "transfer-sender" : t === TRANSFER_RECEIVER_POLICY ? "transfer-receiver" : "other";

  const events = (rows ?? []).map((r) => {
    const sig = r.event_signature ?? "";
    if (sig.startsWith("PolicyUpdated")) {
      const oldId = r.parameters?.oldPolicyId ?? "0";
      const newId = r.parameters?.newPolicyId ?? "0";
      return {
        time: r.block_timestamp ?? null,
        type: "PolicyUpdated" as const,
        scope: scopeName(r.topics?.[1]),
        oldPolicyId: oldId,
        newPolicyId: newId,
        action: newId === "0" ? "removed" : oldId === "0" ? "set" : "changed",
      };
    }
    return {
      time: r.block_timestamp ?? null,
      type: sig.startsWith("Unpaused") ? ("Unpaused" as const) : ("Paused" as const),
      features: r.parameters?.features ?? null,
      updater: r.parameters?.updater ?? null,
    };
  });

  // When did the sender policy last get set/changed (→ became seizable)?
  const senderSets = events.filter(
    (e) => e.type === "PolicyUpdated" && e.scope === "transfer-sender" && e.action !== "removed",
  );
  const seizableSince = senderPol > 0n ? (senderSets.at(-1)?.time ?? null) : null;

  const seizableNow = senderPol > 0n;
  const historyAvailable = rows !== null;
  // Don't claim "clean" (no change history) when we never actually read the
  // history — a CDP outage returns null, which must degrade to clean_unverified,
  // not overstate confidence.
  const verdict = seizableNow ? "seizable" : events.length > 0 ? "watch" : historyAvailable ? "clean" : "clean_unverified";

  return {
    address,
    isB20: true,
    seizableNow,
    seizableSince, // null when we can't pin the moment (history window/API gap)
    transferGatedNow: senderPol > 0n || recvPol > 0n,
    changeCount: events.length,
    events, // chronological policy/pause timeline
    historyAvailable,
    verdict, // seizable | watch (had changes) | clean | clean_unverified
    recommendation: seizableNow
      ? `Sender blocklist policy is ACTIVE${seizableSince ? ` (set ${seizableSince})` : ""} — the issuer can block and burnBlocked-seize holders. Treat as high-control.`
      : events.length > 0
        ? "No active sender policy now, but this token's policies/pauses HAVE changed — the issuer uses these controls; re-check before large positions."
        : historyAvailable
          ? "No policy or pause changes on record and no active sender policy — no freeze/seize surface detected."
          : "No active sender policy right now (live read), but the policy CHANGE HISTORY couldn't be read this time (data provider) — can't confirm it was always clean. Re-check shortly before relying on it.",
    note: "B20-only rug vector: a token can launch clean and later attach a blocklist (PolicyUpdated) — becoming seizable. This combines live policy state with the onchain event timeline (CDP-indexed, 45-day window). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 6c. B20 Guard — real-time seizure alerts (CDP webhook-fed) ----

interface GuardRec {
  token: string;
  event: string;
  time: string;
  scopeTopic: string | null;
  oldPolicyId: string | null;
  newPolicyId: string | null;
  txHash: string | null;
}

const parseRec = (s: string): GuardRec | null => {
  try {
    return JSON.parse(s) as GuardRec;
  } catch {
    return null;
  }
};

const MAX_GUARD_SUBS = 100; // cap on CDP webhook subscriptions we create

/**
 * Ensure a per-token CDP webhook subscription exists (CDP requires a
 * contract_address label per subscription, so guards are per-token).
 * Idempotent via a KV flag; capped. Returns whether the guard is active.
 */
async function ensureGuardSubscription(token: string): Promise<{ active: boolean; since: string | null }> {
  const flagKey = `b20guard:sub:${token}`;
  const existing = await kvGet(flagKey);
  if (existing) {
    try {
      const j = JSON.parse(existing) as { since?: string };
      return { active: true, since: j.since ?? null };
    } catch {
      return { active: true, since: null };
    }
  }
  const cfg = getConfig();
  const secret = process.env.CDP_WEBHOOK_SECRET;
  if (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret || !secret) return { active: false, since: null };
  const count = await kvIncr("b20guard:subcount", 60 * 60 * 24 * 365);
  if (count === null || count > MAX_GUARD_SUBS) return { active: false, since: null };
  try {
    const path = "/platform/v2/data/webhooks/subscriptions";
    const jwt = await generateJwt({
      apiKeyId: cfg.cdpApiKeyId,
      apiKeySecret: cfg.cdpApiKeySecret,
      requestMethod: "POST",
      requestHost: "api.cdp.coinbase.com",
      requestPath: path,
    });
    const r = await fetch(`https://api.cdp.coinbase.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        description: `B20 Guard: ${token} PolicyUpdated`,
        isEnabled: true,
        eventTypes: ["onchain.activity.detected"],
        target: { url: `https://402.com.tr/api/webhooks/cdp?key=${secret}` },
        labels: { network: "base-mainnet", contract_address: token, event_name: "PolicyUpdated" },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { active: false, since: null };
    const j = (await r.json()) as { subscriptionId?: string };
    const since = new Date().toISOString();
    await kvSet(flagKey, JSON.stringify({ id: j.subscriptionId ?? null, since }), 60 * 60 * 24 * 365);
    return { active: true, since };
  } catch {
    return { active: false, since: null };
  }
}

/**
 * Real-time layer over b20-policy-watch. With `address` → registers a per-token
 * CDP webhook guard (sub-second PolicyUpdated capture) and returns live status +
 * captured alerts. Without → network-wide feed of recent policy changes /
 * just-turned-seizable tokens straight from CDP-indexed events.
 */
export async function b20Guard(params: Record<string, string>) {
  const address = (params.address || "").trim();

  if (address) {
    if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address (or omit for the network feed)");
    const a = address.toLowerCase();

    const guard = await ensureGuardSubscription(a);
    const rows = await kvLRange(`b20guard:token:${a}`, 0, 19);
    const latest = await kvGet(`b20guard:latest:${a}`);
    const events = rows.map(parseRec).filter((r): r is GuardRec => !!r);

    // Live confirmation (webhook alerts only cover time since the guard went up).
    const senderPol = await withRetry<bigint>(
      () => client.readContract({ address: getAddress(address), abi: B20_ABI, functionName: "policyId", args: [TRANSFER_SENDER_POLICY] }) as Promise<bigint>,
      0n,
    );

    const last = latest ? parseRec(latest) : null;
    return {
      address,
      guardActive: guard.active,
      guardSince: guard.since,
      seizableNow: senderPol > 0n,
      lastAlert: last,
      recentAlerts: events,
      alertCount: events.length,
      verdict: senderPol > 0n ? "seizable" : events.length > 0 ? "watch" : "clear",
      note: guard.active
        ? "Guard active: this token's PolicyUpdated events are captured sub-second via an onchain webhook. Re-call anytime for the latest alerts; b20-policy-watch has the full historical timeline. Not financial advice."
        : "Guard could not be activated (webhook capacity/config) — falling back to live state only. b20-policy-watch still covers the full timeline. Not financial advice.",
      checkedAt: new Date().toISOString(),
    };
  }

  // Feed mode: recent policy changes across ALL B20 tokens from CDP-indexed
  // events (network-wide query — no per-token subscription needed here).
  const rows = await cdpSql<{ address?: string; block_timestamp?: string; parameters?: { oldPolicyId?: string; newPolicyId?: string }; topics?: string[]; transaction_hash?: string }>(
    `SELECT address, block_timestamp, parameters, topics, transaction_hash FROM base.events WHERE event_name = 'PolicyUpdated' AND block_timestamp > now() - INTERVAL 48 HOUR ORDER BY block_timestamp DESC LIMIT 25`,
  );
  const feed = (rows ?? []).map((r) => ({
    token: r.address ?? null,
    time: r.block_timestamp ?? null,
    scope:
      r.topics?.[1] === TRANSFER_SENDER_POLICY
        ? "transfer-sender"
        : r.topics?.[1] === TRANSFER_RECEIVER_POLICY
          ? "transfer-receiver"
          : "other",
    oldPolicyId: r.parameters?.oldPolicyId ?? null,
    newPolicyId: r.parameters?.newPolicyId ?? null,
    txHash: r.transaction_hash ?? null,
  }));
  const turnedSeizable = feed.filter((e) => e.scope === "transfer-sender" && e.newPolicyId !== "0" && e.newPolicyId !== null);
  return {
    windowHours: 48,
    feed,
    feedCount: feed.length,
    turnedSeizable: turnedSeizable.map((e) => ({ token: e.token, time: e.time, txHash: e.txHash })),
    turnedSeizableCount: turnedSeizable.length,
    historyAvailable: rows !== null,
    note: "Network-wide feed of B20 policy changes in the last 48h. turnedSeizable = tokens that just attached a sender blocklist — holders can now be burnBlocked-seized; exit checks recommended. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 6. B20 Launch Radar — freshly created B20 tokens ----

export async function b20LaunchRadar(params: Record<string, string>) {
  const limit = Math.min(Math.max(parseInt(params.limit || "12", 10) || 12, 1), 25);
  const latest = await client.getBlockNumber();
  const span = 8000n; // ~4-5h on Base
  const fromBlock = latest > span ? latest - span : 0n;

  const logs = await client.getLogs({ address: B20_FACTORY, event: B20_CREATED, fromBlock, toBlock: "latest" });
  const recent = logs.slice(-limit).reverse();

  const tokens = recent.map((l) => {
    const a = l.args as { token?: string; variant?: number; name?: string; symbol?: string; decimals?: number };
    return {
      token: a.token ?? null,
      variant: a.variant === 1 ? "stablecoin" : "asset",
      name: a.name ?? null,
      symbol: a.symbol ?? null,
      decimals: a.decimals ?? null,
      block: Number(l.blockNumber),
    };
  });

  return {
    window: `blocks ${fromBlock}–${latest} (~last few hours)`,
    found: logs.length,
    showing: tokens.length,
    tokens,
    note: `Freshly minted B20 tokens on Base, newest first. Run b20-safety on any address before touching it — new ≠ safe. Showing up to ${limit}.`,
    checkedAt: new Date().toISOString(),
  };
}

// ---- B20 Control Audit — WHO holds the mint/burn/seize/pause powers? ----

const ROLE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["MINT_ROLE", "mint"],
  ["BURN_ROLE", "burn"],
  ["BURN_BLOCKED_ROLE", "seize (burnBlocked)"],
  ["PAUSE_ROLE", "pause"],
  ["UNPAUSE_ROLE", "unpause"],
  ["METADATA_ROLE", "metadata"],
  ["OPERATOR_ROLE", "operator (rebase)"],
];

/**
 * b20-safety reads WHICH powers a B20 has; this reads WHO holds them. Reads each
 * role's bytes32 id from the token, then replays RoleGranted/RoleRevoked events to
 * reconstruct the current holders of mint / burn / seize / pause / admin — plus
 * whether the admin has been renounced. The issuer-control map regulated-asset
 * agents need before holding size.
 */
export async function b20Control(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);

  // 1) Read each role's bytes32 id straight from the token (guaranteed-correct).
  const roleAbi = ROLE_NAMES.map(([fn]) => ({ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }));
  const idToName = new Map<string, string>();
  idToName.set("0x" + "0".repeat(64), "admin"); // DEFAULT_ADMIN_ROLE
  try {
    const mc = (await client.multicall({ contracts: ROLE_NAMES.map(([fn]) => ({ address: addr, abi: roleAbi as never, functionName: fn })) as never, allowFailure: true })) as Array<{ status?: string; result?: unknown }>;
    ROLE_NAMES.forEach(([, label], i) => {
      const r = mc[i];
      if (r?.status === "success" && typeof r.result === "string") idToName.set(r.result.toLowerCase(), label);
    });
  } catch {
    /* role-id reads best-effort — admin + raw role ids still work below */
  }

  // 2) Replay role events. Role & account are INDEXED, so they live in topics.
  const rows = await cdpSql<{ event_signature?: string; topics?: string[] }>(
    `SELECT event_signature, topics FROM base.events WHERE address = '${addr.toLowerCase()}' AND (event_signature LIKE 'RoleGranted%' OR event_signature LIKE 'RoleRevoked%' OR event_signature LIKE 'LastAdminRenounced%') AND block_timestamp > now() - INTERVAL 365 DAY ORDER BY block_timestamp ASC LIMIT 3000`,
  );
  if (rows === null) throw new Error("B20 role event data unavailable (data provider) — try again shortly");

  const holders = new Map<string, Set<string>>();
  let adminRenounced = false;
  for (const r of rows) {
    const sig = r.event_signature ?? "";
    if (/LastAdminRenounced/i.test(sig)) { adminRenounced = true; continue; }
    const t = r.topics ?? [];
    const roleId = String(t[1] ?? "").toLowerCase();
    const acctTopic = String(t[2] ?? "");
    if (acctTopic.length < 42) continue;
    let account: string;
    try { account = getAddress("0x" + acctTopic.slice(-40)); } catch { continue; }
    const label = idToName.get(roleId) ?? `role:${roleId.slice(0, 10)}`;
    if (!holders.has(label)) holders.set(label, new Set());
    if (/RoleRevoked/i.test(sig)) holders.get(label)!.delete(account);
    else holders.get(label)!.add(account);
  }

  const roles: Record<string, string[]> = {};
  for (const [label, set] of holders) if (set.size) roles[label] = [...set];
  const minters = roles["mint"] ?? [];
  const seizers = roles["seize (burnBlocked)"] ?? [];
  const pausers = roles["pause"] ?? [];
  const admins = roles["admin"] ?? [];

  const flags: string[] = [];
  if (seizers.length) flags.push(`${seizers.length} address(es) can SEIZE balances (burnBlocked)`);
  if (minters.length) flags.push(`${minters.length} address(es) can MINT new supply`);
  if (pausers.length) flags.push(`${pausers.length} address(es) can PAUSE transfers`);
  if (admins.length === 1 && !adminRenounced) flags.push("a single admin address controls all role assignment");
  if (adminRenounced) flags.push("admin renounced — the role set is frozen as-is");

  const controllers = new Set([...minters, ...seizers, ...admins]);
  const verdict = seizers.length ? "seizable_controlled" : minters.length || pausers.length ? "issuer_controlled" : admins.length && !adminRenounced ? "admin_controlled" : "minimal";

  return {
    address: addr, isB20: true, symbol: s.symbol, variant: s.variant,
    adminRenounced,
    distinctControllers: controllers.size,
    roles,
    can: { mint: minters, seize: seizers, pause: pausers, admin: admins },
    flags,
    verdict, // seizable_controlled | issuer_controlled | admin_controlled | minimal
    recommendation:
      seizers.length ? `${seizers.length} address(es) can freeze + seize your balance at will — a fully issuer-controlled asset. Only hold if you trust the operator.`
        : minters.length ? "The issuer can mint supply and gate transfers — standard for regulated assets, but you're trusting the operator; size accordingly."
          : adminRenounced ? "Admin renounced — the role set is frozen; no new powers can be granted. Lower governance risk."
            : "Limited control roles detected — behaves close to a plain token.",
    note: "Maps a B20's role-based access control (mint / burn / seize / pause / admin) from onchain role events — WHO can exercise the token's powers, and whether admin is renounced. Complements b20-safety (which powers exist). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- Confirm a B20 (supplyCap reverts on a plain ERC-20) — shared by the below ----
export async function isB20Token(addr: `0x${string}`): Promise<boolean> {
  // Factory-first: isB20() can't be spoofed by a lookalike contract that
  // implements supplyCap(). Falls back to the supplyCap probe only if the
  // factory read itself fails (transport).
  const real = await withRetry<boolean | null>(
    () => client.readContract({ address: B20_FACTORY, abi: FACTORY_ABI, functionName: "isB20", args: [addr] }) as Promise<boolean>,
    null,
    true,
  );
  if (real !== null) return real;
  const cap = await withRetry<bigint | null>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "supplyCap" }) as Promise<bigint | null>,
    null,
  );
  return cap !== null;
}

const topicToAddr = (t?: string): string | null => {
  try {
    return t && t.length >= 42 ? getAddress("0x" + t.slice(-40)) : null;
  } catch {
    return null;
  }
};

// ---- B20 Seizure History — has the issuer ever FIRED the gun (burnBlocked)? ----

/**
 * Every other B20 check reads what the issuer CAN do; this reads what they HAVE
 * done. burnBlocked() seizes a blocked holder's balance and emits a distinct
 * `BurnedBlocked(address indexed caller, address indexed from, uint256 amount)`
 * event (IB20) — the one unambiguous, hard-to-get signal that an issuer's
 * coercive power isn't just theoretical. Scans that history per token (or a
 * specific victim wallet), or network-wide with no address. No other tool
 * surfaces actual seizures.
 */
export async function b20SeizureHistory(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  const wallet = (params.wallet || params.victim || "").trim();

  // Network-wide feed when no token is given: recent seizures across all B20s.
  if (!address) {
    const rows = await cdpSql<{ address?: string; block_timestamp?: string; topics?: string[]; parameters?: { amount?: string }; transaction_hash?: string }>(
      `SELECT address, block_timestamp, topics, parameters, transaction_hash FROM base.events WHERE event_signature LIKE 'BurnedBlocked%' AND block_timestamp > now() - INTERVAL 30 DAY ORDER BY block_timestamp DESC LIMIT 50`,
    );
    if (rows === null) throw new Error("B20 seizure event data unavailable (data provider) — try again shortly");
    const feed = rows.map((r) => ({
      token: r.address ?? null,
      caller: topicToAddr(r.topics?.[1]),
      victim: topicToAddr(r.topics?.[2]),
      amount: String(r.parameters?.amount ?? "0"),
      time: r.block_timestamp ?? null,
      txHash: r.transaction_hash ?? null,
    }));
    return {
      windowDays: 30,
      seizureCount: feed.length,
      distinctTokens: new Set(feed.map((f) => f.token).filter(Boolean)).size,
      seizures: feed,
      verdict: feed.length ? "active_enforcement" : "quiet",
      note: "Network-wide feed of actual B20 seizures (burnBlocked → BurnedBlocked events) in the last 30 days — issuers that DID seize holders, not just could. Not financial advice.",
      checkedAt: new Date().toISOString(),
    };
  }

  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address (address=)");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);

  const rows = await cdpSql<{ block_timestamp?: string; topics?: string[]; parameters?: { amount?: string }; transaction_hash?: string }>(
    `SELECT block_timestamp, topics, parameters, transaction_hash FROM base.events WHERE address = '${addr.toLowerCase()}' AND event_signature LIKE 'BurnedBlocked%' AND block_timestamp > now() - INTERVAL 365 DAY ORDER BY block_timestamp DESC LIMIT 500`,
  );
  if (rows === null) throw new Error("B20 seizure event data unavailable (data provider) — try again shortly");

  const w = validAddr(wallet) ? getAddress(wallet).toLowerCase() : null;
  const seizures = rows.map((r) => ({
    caller: topicToAddr(r.topics?.[1]),
    victim: topicToAddr(r.topics?.[2]),
    amount: String(r.parameters?.amount ?? "0"),
    time: r.block_timestamp ?? null,
    txHash: r.transaction_hash ?? null,
  }));
  const victims = new Set(seizures.map((x) => x.victim?.toLowerCase()).filter(Boolean));
  const walletSeized = w ? seizures.filter((x) => x.victim?.toLowerCase() === w) : null;

  // "Armed" = has the sender blocklist power. "Enforced" = has actually used it.
  const verdict = seizures.length
    ? "enforced"
    : s.canSeize
      ? "armed"
      : "no_seize_power";

  return {
    address, isB20: true, symbol: s.symbol, variant: s.variant,
    canSeize: s.canSeize,
    seizureCount: seizures.length,
    distinctVictims: victims.size,
    verdict, // enforced | armed | no_seize_power
    ...(w ? { wallet, walletSeized: (walletSeized?.length ?? 0) > 0, walletSeizures: walletSeized } : {}),
    seizures: seizures.slice(0, 100),
    recommendation:
      verdict === "enforced"
        ? `⚠️ This issuer HAS seized holders — ${seizures.length} burnBlocked seizure(s) across ${victims.size} wallet(s). The coercive power is not theoretical; treat holding risk as REAL.`
        : verdict === "armed"
          ? "The issuer CAN seize (sender blocklist set) but has no recorded burnBlocked seizures yet — armed but not fired. Watch policy changes (b20-policy-watch)."
          : "No sender blocklist and no seizure history — this token has no active protocol-level seize surface.",
    note: "Reads actual B20 seizures (burnBlocked → BurnedBlocked events, 365-day window) — whether the issuer has ever burned a blocked holder's balance, not just whether they could. Pass wallet= to check a specific address. The enforcement-history signal ERC-20 (and every other B20 tool) can't show. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 7. B20 Memo Tracker — payment IDs / compliance tags on a B20 ----

/**
 * B20 adds memos to transfers/mints/burns (transferWithMemo → Memo(caller, memo))
 * for payment IDs, compliance tags, and settlement correlation — a field plain
 * ERC-20 has no equivalent for. Reads a token's Memo event history (CDP-indexed),
 * optionally filtered by a specific memo (bytes32) or the caller wallet. The
 * settlement-reconciliation primitive for agents paying over B20 stablecoins.
 */
export async function b20Memo(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  if (!(await isB20Token(addr))) return notB20(address);

  let memoFilter = (params.memo || "").trim().toLowerCase();
  if (memoFilter && !memoFilter.startsWith("0x")) memoFilter = "0x" + memoFilter;
  const caller = (params.caller || params.wallet || "").trim().toLowerCase();

  // Memo(address indexed caller, bytes32 indexed memo) → caller=topics[1], memo=topics[2].
  const rows = await cdpSql<{ block_timestamp?: string; topics?: string[]; transaction_hash?: string }>(
    `SELECT block_timestamp, topics, transaction_hash FROM base.events WHERE address = '${addr.toLowerCase()}' AND event_name = 'Memo' AND block_timestamp > now() - INTERVAL 45 DAY ORDER BY block_timestamp DESC LIMIT 200`,
  );
  if (rows === null) throw new Error("B20 memo event data unavailable (data provider) — try again shortly");

  let memos = rows
    .map((r) => ({
      time: r.block_timestamp ?? null,
      caller: topicToAddr(r.topics?.[1]),
      memo: String(r.topics?.[2] ?? "").toLowerCase(),
      txHash: r.transaction_hash ?? null,
    }))
    .filter((m) => /^0x[0-9a-f]{64}$/.test(m.memo));

  if (memoFilter && /^0x[0-9a-f]{64}$/.test(memoFilter)) memos = memos.filter((m) => m.memo === memoFilter);
  if (caller && /^0x[0-9a-f]{40}$/.test(caller)) memos = memos.filter((m) => m.caller?.toLowerCase() === caller);

  // Merchant reconciliation: to= keeps only memos whose tx also moved tokens TO
  // that address (the Memo event itself doesn't carry the recipient — join via
  // the Transfer in the same tx, exactly how the Base docs tell merchants to).
  const merchant = (params.to || params.merchant || "").trim().toLowerCase();
  if (merchant && /^0x[0-9a-f]{40}$/.test(merchant)) {
    const txRows = await cdpSql<{ topics?: string[]; transaction_hash?: string }>(
      `SELECT topics, transaction_hash FROM base.events WHERE address = '${addr.toLowerCase()}' AND event_name = 'Transfer' AND block_timestamp > now() - INTERVAL 45 DAY ORDER BY block_timestamp DESC LIMIT 2000`,
    );
    if (txRows === null) throw new Error("B20 transfer event data unavailable (data provider) — try again shortly");
    const toTx = new Set(
      txRows.filter((r) => topicToAddr(r.topics?.[2])?.toLowerCase() === merchant).map((r) => r.transaction_hash).filter(Boolean),
    );
    memos = memos.filter((m) => m.txHash && toTx.has(m.txHash));
  }

  const uniqueMemos = new Set(memos.map((m) => m.memo)).size;
  const uniqueCallers = new Set(memos.map((m) => m.caller).filter(Boolean)).size;

  return {
    address,
    isB20: true,
    memoCount: memos.length,
    uniqueMemos,
    uniqueCallers,
    filtered: Boolean(memoFilter || caller || (merchant && /^0x[0-9a-f]{40}$/.test(merchant))),
    memos: memos.slice(0, 50),
    verdict: memos.length ? "tagged_settlement" : "no_memos",
    recommendation: memoFilter
      ? memos.length
        ? `Found ${memos.length} on-chain transfer(s) carrying that memo — use txHash/caller to reconcile the payment.`
        : "No transfers found carrying that memo in the last 45 days on this token."
      : memos.length
        ? `${memos.length} memoed transfer(s) across ${uniqueMemos} distinct memo(s) — this token is used for tagged/compliant settlement. Filter with memo= to trace a specific payment ID.`
        : "No memoed transfers on this token — memos aren't in use here.",
    note: "B20 memos (payment IDs, compliance tags, settlement correlation) — a Base-native field ERC-20 has no equivalent for. Filter by memo= (bytes32) or caller= to reconcile a specific payment. CDP-indexed, 45-day window. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 8. B20 Supply / Mint Headroom — dilution risk + cap-change history ----

/**
 * b20-safety flags freeze/seize (seizure risk); this reads the OTHER half of the
 * rug picture: dilution. supplyCap vs totalSupply = how much can still be minted,
 * plus the SupplyCapUpdated history — an issuer that RAISED the cap diluted (or
 * can dilute) holders. Uncapped mint is the worst case.
 */
export async function b20Supply(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);

  await sleep(120);
  const totalSupply = await withRetry<bigint>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "totalSupply" }) as Promise<bigint>,
    0n,
  );

  const capped = s.supplyCapped;
  const cap = s.supplyCap;
  const headroom = capped && cap > totalSupply ? cap - totalSupply : 0n;
  const pctMinted = capped && cap > 0n ? Math.min(100, Number((totalSupply * 10000n) / cap) / 100) : null;

  // SupplyCapUpdated(address indexed updater, uint256 oldSupplyCap, uint256 newSupplyCap).
  const rows = await cdpSql<{ block_timestamp?: string; parameters?: { oldSupplyCap?: string; newSupplyCap?: string; oldCap?: string; newCap?: string }; transaction_hash?: string }>(
    `SELECT block_timestamp, parameters, transaction_hash FROM base.events WHERE address = '${addr.toLowerCase()}' AND event_name = 'SupplyCapUpdated' AND block_timestamp > now() - INTERVAL 365 DAY ORDER BY block_timestamp ASC LIMIT 50`,
  );
  const capChanges = (rows ?? []).map((r) => {
    const oldC = BigInt(r.parameters?.oldSupplyCap ?? r.parameters?.oldCap ?? "0");
    const newC = BigInt(r.parameters?.newSupplyCap ?? r.parameters?.newCap ?? "0");
    return {
      time: r.block_timestamp ?? null,
      oldCap: oldC.toString(),
      newCap: newC.toString(),
      direction: newC > oldC ? "raised" : newC < oldC ? "lowered" : "unchanged",
      txHash: r.transaction_hash ?? null,
    };
  });
  const raises = capChanges.filter((c) => c.direction === "raised").length;

  const verdict = !capped
    ? "uncapped"
    : raises > 0
      ? "cap_raised"
      : pctMinted !== null && pctMinted >= 99
        ? "at_cap"
        : "capped";

  return {
    address,
    isB20: true,
    variant: s.variant,
    symbol: s.symbol,
    totalSupply: totalSupply.toString(),
    supplyCap: capped ? cap.toString() : "uncapped",
    mintHeadroom: capped ? headroom.toString() : "unbounded",
    pctMinted,
    capRaises: raises,
    capChanges,
    historyAvailable: rows !== null,
    verdict, // uncapped | cap_raised | at_cap | capped
    recommendation: !capped
      ? "⚠️ No supply cap — the issuer can mint unlimited new supply and dilute you at will. Treat as high dilution risk."
      : raises > 0
        ? `⚠️ The supply cap has been RAISED ${raises} time(s) — the issuer has diluted (or set up to dilute) holders. Watch for further cap raises before sizing up.`
        : pctMinted !== null && pctMinted >= 99
          ? "Cap is effectively fully minted — little further dilution headroom, but confirm the issuer can't raise the cap (b20-control for the mint/admin roles)."
          : `Capped supply with ${pctMinted ?? "?"}% minted — bounded dilution. The issuer can still raise the cap; pair with b20-control to see who holds the admin role.`,
    note: "The dilution half of B20 rug risk: supply cap vs minted supply (headroom) plus the on-chain SupplyCapUpdated history (a raised cap = past/prepared dilution). Complements b20-safety (seizure) and b20-control (who can mint). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 9. B20 Metadata Integrity — can this token rename itself? has it? ----

const META_ROLE_ABI = [
  { type: "function", name: "METADATA_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

/**
 * A B20 with a METADATA_ROLE holder can call updateName / updateSymbol — i.e.
 * change its own identity after launch (an impersonation / bait-and-switch
 * vector plain ERC-20s can't do at the protocol level). This reads whether the
 * metadata is mutable (role holder exists) AND whether it has ALREADY been
 * renamed (NameUpdated / SymbolUpdated history).
 */
export async function b20Metadata(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);

  await sleep(120);
  const currentName = await withRetry<string | null>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "name" }) as Promise<string | null>,
    null,
    true, // cosmetic display field
  );
  await sleep(120);
  // METADATA_ROLE gates the mutable/immutable verdict — a transport failure here
  // must NOT read as "no role → immutable", so this stays fail-loud (throws).
  const metaRoleId = await withRetry<string | null>(
    () => client.readContract({ address: addr, abi: META_ROLE_ABI, functionName: "METADATA_ROLE" }) as Promise<string | null>,
    null,
  );
  const metaId = metaRoleId ? metaRoleId.toLowerCase() : null;

  // NameUpdated/SymbolUpdated history + RoleGranted/Revoked to reconstruct METADATA_ROLE holders.
  const rows = await cdpSql<{ event_signature?: string; block_timestamp?: string; parameters?: { newName?: string; newSymbol?: string }; topics?: string[] }>(
    `SELECT event_signature, block_timestamp, parameters, topics FROM base.events WHERE address = '${addr.toLowerCase()}' AND (event_signature LIKE 'NameUpdated%' OR event_signature LIKE 'SymbolUpdated%' OR event_signature LIKE 'RoleGranted%' OR event_signature LIKE 'RoleRevoked%') AND block_timestamp > now() - INTERVAL 365 DAY ORDER BY block_timestamp ASC LIMIT 2000`,
  );
  if (rows === null) throw new Error("B20 metadata event data unavailable (data provider) — try again shortly");

  const renames: Array<{ time: string | null; field: string; newValue: string }> = [];
  const metaHolders = new Set<string>();
  for (const r of rows) {
    const sig = r.event_signature ?? "";
    if (/^NameUpdated/.test(sig)) {
      renames.push({ time: r.block_timestamp ?? null, field: "name", newValue: String(r.parameters?.newName ?? "") });
    } else if (/^SymbolUpdated/.test(sig)) {
      renames.push({ time: r.block_timestamp ?? null, field: "symbol", newValue: String(r.parameters?.newSymbol ?? "") });
    } else if (metaId) {
      const roleId = String(r.topics?.[1] ?? "").toLowerCase();
      if (roleId !== metaId) continue;
      const acct = topicToAddr(r.topics?.[2]);
      if (!acct) continue;
      if (/^RoleRevoked/.test(sig)) metaHolders.delete(acct);
      else metaHolders.add(acct);
    }
  }

  const mutable = metaHolders.size > 0;
  const renamed = renames.length > 0;
  const verdict = renamed ? "renamed" : mutable ? "mutable" : "immutable";

  return {
    address,
    isB20: true,
    currentName,
    currentSymbol: s.symbol,
    metadataMutable: mutable,
    metadataControllers: [...metaHolders],
    renameCount: renames.length,
    renames,
    verdict, // renamed (already changed identity) | mutable (can) | immutable
    recommendation: renamed
      ? `⚠️ This token has changed its ${[...new Set(renames.map((r) => r.field))].join("/")} on-chain ${renames.length} time(s) — its current identity is NOT guaranteed to match what you first saw. Treat name/symbol as untrusted; verify by address only.`
      : mutable
        ? `${metaHolders.size} address(es) can rename this token's name/symbol at any time (METADATA_ROLE). Its identity is mutable — trust the address, not the label.`
        : "No metadata controllers and no rename history — the token's name/symbol are effectively fixed.",
    note: "B20 metadata integrity: whether the name/symbol are mutable (METADATA_ROLE holder) and whether they've already been changed on-chain (NameUpdated/SymbolUpdated) — an impersonation/bait-and-switch vector ERC-20 has no protocol equivalent for. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 10. B20 Permit Inspector — gasless-approval readiness for agents ----

const PERMIT_ABI = [
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

/**
 * Every B20 has ERC-2612 permit built in — an agent can approve a spender with a
 * signature instead of a transaction. This reads exactly what an agent needs to
 * build a valid permit: the token's DOMAIN_SEPARATOR, the owner's current nonce
 * (so the signed payload can't be rejected/replayed), and the EIP-712 domain
 * fields (name/version/chainId/verifyingContract).
 */
export async function b20Permit(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const owner = (params.owner || params.wallet || "").trim();

  if (!(await isB20Token(addr))) return notB20(address);

  await sleep(120);
  const domainSeparator = await withRetry<string | null>(
    () => client.readContract({ address: addr, abi: PERMIT_ABI, functionName: "DOMAIN_SEPARATOR" }) as Promise<string | null>,
    null,
  );
  await sleep(120);
  const name = await withRetry<string | null>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "name" }) as Promise<string | null>,
    null,
    true, // cosmetic
  );

  let nonce: string | null = null;
  if (validAddr(owner)) {
    await sleep(120);
    const n = await withRetry<bigint | null>(
      () => client.readContract({ address: addr, abi: PERMIT_ABI, functionName: "nonces", args: [getAddress(owner)] }) as Promise<bigint | null>,
      null,
    );
    nonce = n === null ? null : n.toString();
  }

  return {
    address,
    isB20: true,
    supportsPermit: true, // ERC-2612 is built into every B20
    owner: validAddr(owner) ? getAddress(owner) : null,
    nonce, // next nonce to sign with (null if no owner= given or read failed)
    domainSeparator,
    eip712Domain: { name, version: "1", chainId: 8453, verifyingContract: addr },
    permitTypes: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    recommendation: validAddr(owner)
      ? nonce !== null
        ? `Sign an EIP-712 Permit with nonce ${nonce} and a future deadline, then submit permit(owner,spender,value,deadline,v,r,s) — a gasless approval, no separate approve() tx.`
        : "Couldn't read the owner's nonce right now (RPC) — retry before signing; a wrong nonce makes the permit revert."
      : "Pass owner= to also get the current nonce. Every B20 supports ERC-2612 permit — approve spenders by signature, no gas.",
    note: "ERC-2612 permit readiness for a B20: DOMAIN_SEPARATOR, owner nonce, and the EIP-712 domain/type struct an agent needs to build a valid gasless approval. Read-only; signs nothing. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- Shared: read the four transfer/mint policy ids in one multicall ----
// Returns null only when the token is genuinely not a B20 (sender policyId
// reverts). A TRANSPORT failure throws — never mislabel an outage as "not a
// B20" / "no policies". `degraded` is set if a secondary policy read failed.
async function readPolicyIds(addr: `0x${string}`): Promise<{ sender: bigint; receiver: bigint; executor: bigint; mint: bigint; degraded: boolean } | null> {
  const contracts = [
    { address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_SENDER_POLICY] },
    { address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_RECEIVER_POLICY] },
    { address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_EXECUTOR_POLICY] },
    { address: addr, abi: B20_ABI, functionName: "policyId", args: [MINT_RECEIVER_POLICY] },
  ] as const;
  let r: Array<{ status?: string; result?: unknown }>;
  try {
    r = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as Array<{ status?: string; result?: unknown }>;
  } catch (e) {
    // Whole-multicall (transport) failure — retry once, then fail loud.
    try {
      await sleep(400);
      r = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as Array<{ status?: string; result?: unknown }>;
    } catch {
      throw new Error(`B20 policy read unavailable (RPC): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (r[0]?.status !== "success") return null; // sender policyId reverts on a non-B20
  const g = (i: number) => (r[i]?.status === "success" ? (r[i].result as bigint) : 0n);
  const degraded = r.slice(1).some((x) => x?.status !== "success");
  return { sender: g(0), receiver: g(1), executor: g(2), mint: g(3), degraded };
}

// Policy type is encoded in the high byte of the policyId (B20Constants:
// ALWAYS_BLOCK = (uint64(ALLOWLIST) << 56) | 1). enum PolicyType{BLOCKLIST=0,ALLOWLIST=1}.
const policyType = (pid: bigint): "none" | "blocklist" | "allowlist" =>
  pid === 0n ? "none" : Number(pid >> 56n) === 1 ? "allowlist" : "blocklist";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// ---- 11. B20 Policy Admin Watch — WHO administers the blocklist that can freeze you? ----

const POLICY_ADMIN_ABI = [
  { type: "function", name: "policyAdmin", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingPolicyAdmin", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [{ type: "address" }] },
] as const;

/**
 * b20-control reads the token's OWN roles (who can mint/seize). But the address
 * that can actually add you to a blocklist lives in the Policy Registry, not the
 * token — its `policyAdmin`. This reads WHO administers each of the token's active
 * transfer policies, and whether that control is being handed over
 * (pendingPolicyAdmin) or renounced (admin = 0). The other half of "who can
 * freeze/seize you", straight from the registry.
 */
export async function b20PolicyAdmin(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);
  const pids = await readPolicyIds(addr);
  if (!pids) return notB20(address);

  const scopeList: Array<[string, bigint]> = [
    ["transfer-sender", pids.sender],
    ["transfer-receiver", pids.receiver],
    ["transfer-executor", pids.executor],
    ["mint-receiver", pids.mint],
  ];

  const scopes: Array<Record<string, unknown>> = [];
  for (const [scope, pid] of scopeList) {
    if (pid === 0n) continue;
    await sleep(120);
    const admin = await withRetry<string | null>(
      () => client.readContract({ address: B20_POLICY_REGISTRY, abi: POLICY_ADMIN_ABI, functionName: "policyAdmin", args: [pid] }) as Promise<string | null>,
      null,
    );
    await sleep(120);
    const pending = await withRetry<string | null>(
      () => client.readContract({ address: B20_POLICY_REGISTRY, abi: POLICY_ADMIN_ABI, functionName: "pendingPolicyAdmin", args: [pid] }) as Promise<string | null>,
      null,
    );
    scopes.push({
      scope,
      policyId: pid.toString(),
      type: policyType(pid),
      admin: admin && admin !== ZERO_ADDR ? getAddress(admin) : null,
      renounced: admin === ZERO_ADDR,
      pendingAdmin: pending && pending !== ZERO_ADDR ? getAddress(pending) : null,
      degraded: admin === null,
    });
  }

  const controlling = scopes.filter((x) => x.scope === "transfer-sender" || x.scope === "transfer-receiver");
  const anyPending = scopes.some((x) => x.pendingAdmin);
  const activeAdmins = new Set(scopes.map((x) => x.admin).filter(Boolean) as string[]);
  const allRenounced = controlling.length > 0 && controlling.every((x) => x.renounced);
  // A failed secondary policy read defaults that scope's id to 0n (looks like
  // "no policy"); if that happened, don't assert "no_policies" cleanly.
  const scopesDegraded = pids.degraded || scopes.some((x) => x.degraded === true);
  const verdict = scopes.length === 0
    ? (pids.degraded ? "unknown" : "no_policies")
    : anyPending
      ? "admin_transfer_pending"
      : allRenounced
        ? "admin_renounced"
        : activeAdmins.size
          ? "admin_controlled"
          : "unknown";

  return {
    address,
    isB20: true,
    symbol: s.symbol,
    verdict, // no_policies | admin_transfer_pending | admin_renounced | admin_controlled | unknown
    ...(scopesDegraded ? { degraded: true } : {}),
    policyAdmins: scopes,
    distinctAdmins: activeAdmins.size,
    recommendation: scopes.length === 0
      ? "No transfer/mint policies set — there's no blocklist admin to worry about on this token right now."
      : anyPending
        ? "⚠️ A policy admin transfer is PENDING — control over who can be blocked/seized is being handed to a new address. Confirm you trust the incoming admin before holding size."
        : allRenounced
          ? "The controlling policy admins are renounced (address 0) — the current membership is frozen; no new addresses can be blocked. Lower freeze risk."
          : `The blocklist/allowlist that governs transfers is controlled by ${activeAdmins.size} admin address(es) — whoever holds it can block (and, with a sender policy, burnBlocked-seize) holders. Trust the admin, or don't hold size.`,
    note: "Reads the Policy Registry admin for a B20's active transfer/mint policies — WHO can add you to the blocklist (and whether that control is being transferred or renounced). Complements b20-control (token roles) and b20-safety (which powers exist). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 12. B20 Access Type — is this a permissioned (allowlist) token, or blockable? ----

/**
 * A B20 transfer policy is either a BLOCKLIST (you're allowed unless listed) or
 * an ALLOWLIST (you're allowed ONLY if listed — a permissioned/whitelist token
 * you can't even receive without being approved). b20-safety flags that a policy
 * exists; this decodes its TYPE per scope — the difference between "the issuer can
 * block bad actors" and "this is a permissioned RWA you can't hold uninvited".
 */
export async function b20AccessType(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);
  const pids = await readPolicyIds(addr);
  if (!pids) return notB20(address);

  const scopeDefs: Array<[string, bigint]> = [
    ["send", pids.sender],
    ["receive", pids.receiver],
    ["execute", pids.executor],
    ["mint-to", pids.mint],
  ];
  const scopes = scopeDefs
    .filter(([, pid]) => pid !== 0n)
    .map(([scope, pid]) => ({ scope, policyId: pid.toString(), type: policyType(pid) }));

  const permissioned = scopes.some((x) => (x.scope === "send" || x.scope === "receive") && x.type === "allowlist");
  const blockable = scopes.some((x) => x.type === "blocklist");
  // If a scope read failed we can't certify "open" (a failed read looks like "no
  // policy") — disclose the partial state instead of implying no gating.
  const verdict = permissioned ? "permissioned" : blockable ? "blockable" : pids.degraded ? "open_partial" : "open";

  return {
    address,
    isB20: true,
    symbol: s.symbol,
    variant: s.variant,
    verdict, // permissioned (allowlist-gated) | blockable (blocklist) | open (no transfer policy) | open_partial (a scope read failed)
    ...(pids.degraded ? { degraded: true } : {}),
    scopes,
    recommendation: permissioned
      ? "⚠️ Permissioned token — an ALLOWLIST gates transfers, so you can only hold/receive it if the issuer has whitelisted your address. Confirm you're (and will stay) approved before buying; otherwise you may not be able to receive or move it."
      : blockable
        ? "Blocklist-gated — you can transfer freely UNLESS the issuer adds you to the blocklist (after which a sender policy also enables burnBlocked-seize). Standard for regulated assets; watch policy changes (b20-policy-watch)."
        : pids.degraded
          ? "No blocklist/allowlist found on the scopes we could read, but at least one scope read failed this call — re-check before assuming the token is ungated."
          : "No transfer policy — behaves like an open token on the transfer path (no allowlist/blocklist gating).",
    note: "Decodes each active B20 policy as ALLOWLIST (permissioned — must be whitelisted) vs BLOCKLIST (open unless blocked). The distinction b20-safety collapses: a permissioned RWA you can't hold uninvited is a different risk than a blockable token. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 13. B20 Announcements — on-chain issuer notices (Asset variant) ----

/**
 * B20 Asset tokens can post on-chain announcements (announce → Announcement(id,
 * description, uri)) — issuer notices, corporate actions, redemptions — a channel
 * plain ERC-20 has no equivalent for. Reads a token's announcement feed (active vs
 * ended) from CDP-indexed events. The issuer-communications primitive for agents
 * holding tokenized/RWA B20 assets.
 */
export async function b20Announcements(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);
  if (s.variant !== "asset") {
    return {
      address,
      isB20: true,
      variant: s.variant,
      announcementCount: 0,
      announcements: [],
      verdict: "n/a",
      note: "Announcements are an Asset-variant feature; this is a Stablecoin (or non-Asset) B20 — no on-chain announcement channel.",
      checkedAt: new Date().toISOString(),
    };
  }

  const rows = await cdpSql<{ event_signature?: string; block_timestamp?: string; parameters?: { id?: string; description?: string; uri?: string }; topics?: string[]; transaction_hash?: string }>(
    `SELECT event_signature, block_timestamp, parameters, topics, transaction_hash FROM base.events WHERE address = '${addr.toLowerCase()}' AND (event_signature LIKE 'Announcement%' OR event_signature LIKE 'EndAnnouncement%') AND block_timestamp > now() - INTERVAL 365 DAY ORDER BY block_timestamp DESC LIMIT 100`,
  );
  if (rows === null) throw new Error("B20 announcement event data unavailable (data provider) — try again shortly");

  const ended = new Set(
    rows.filter((r) => /^EndAnnouncement/.test(r.event_signature ?? "")).map((r) => String(r.parameters?.id ?? "")),
  );
  const announcements = rows
    .filter((r) => /^Announcement/.test(r.event_signature ?? ""))
    .map((r) => {
      const id = String(r.parameters?.id ?? "");
      return {
        time: r.block_timestamp ?? null,
        id,
        description: String(r.parameters?.description ?? ""),
        uri: String(r.parameters?.uri ?? ""),
        caller: topicToAddr(r.topics?.[1]),
        active: !ended.has(id),
        txHash: r.transaction_hash ?? null,
      };
    });

  const activeCount = announcements.filter((a) => a.active).length;
  return {
    address,
    isB20: true,
    variant: "asset",
    symbol: s.symbol,
    announcementCount: announcements.length,
    activeCount,
    announcements: announcements.slice(0, 40),
    verdict: activeCount ? "active_notices" : announcements.length ? "past_notices" : "none",
    recommendation: activeCount
      ? `${activeCount} active on-chain issuer announcement(s) — read the description/uri for corporate actions (redemptions, notices) that affect holders.`
      : announcements.length
        ? "No active announcements, but this issuer has used the on-chain announcement channel before — worth periodic checks."
        : "No on-chain announcements from this issuer.",
    note: "B20 Asset on-chain issuer announcements (notices, corporate actions, redemptions) — a channel ERC-20 has no equivalent for. CDP-indexed, 365-day window. Verify any uri before acting on it. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 14. B20 Stablecoin Profile — declared peg currency + issuance ----

const CURRENCY_ABI = [
  { type: "function", name: "currency", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * B20 Stablecoin tokens self-declare a fiat currency code (currency() → "USD",
 * "EUR", …). This reads that declared peg alongside the token's issuance profile
 * (supply, cap, control powers) — a one-call "what is this stablecoin and who
 * controls it" for agents settling in B20 stablecoins.
 */
export async function b20Stablecoin(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);
  if (s.variant !== "stablecoin") {
    return {
      address,
      isB20: true,
      variant: s.variant,
      note: "Not a Stablecoin-variant B20 (this is an Asset variant) — currency()/peg declaration applies to stablecoins. Use b20-rebase for Asset multiplier or b20-info for the general profile.",
      checkedAt: new Date().toISOString(),
    };
  }

  await sleep(120);
  const declaredCurrency = await withRetry<string | null>(
    () => client.readContract({ address: addr, abi: CURRENCY_ABI, functionName: "currency" }) as Promise<string | null>,
    null,
  );
  await sleep(120);
  const totalSupply = await withRetry<bigint>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "totalSupply" }) as Promise<bigint>,
    0n,
    true, // display number — don't 500 the peg profile on a blip
  );

  return {
    address,
    isB20: true,
    variant: "stablecoin",
    symbol: s.symbol,
    declaredCurrency, // self-declared ISO fiat code (e.g. USD) — issuer's claim, not proof of backing
    totalSupply: totalSupply.toString(),
    supplyCap: s.supplyCapped ? s.supplyCap.toString() : "uncapped",
    control: { seizable: s.canSeize, freezable: s.transferGated, pausedNow: s.paused.transfer, uncappedMint: !s.supplyCapped },
    ...(s.degraded ? { degraded: true } : {}),
    verdict: s.degraded ? "unknown" : s.canSeize || s.paused.transfer ? "issuer_controlled" : s.transferGated ? "gated" : "open",
    recommendation: `Declared peg: ${declaredCurrency || "unknown"}. This is the issuer's self-declared currency code — NOT proof of reserves or backing. ${
      s.canSeize ? "The issuer can freeze/seize holders (standard for regulated stablecoins) — trust the operator." : "No active sender-blocklist right now."
    } Pair with b20-control for who holds the mint/seize roles.`,
    note: "B20 Stablecoin profile: the self-declared fiat currency code plus issuance (supply/cap) and control powers. The currency code is a claim, not attested backing. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 15. B20 Authenticity — is this a REAL B20, or a lookalike contract? ----

/**
 * Nothing stops a scammer from deploying a plain EVM contract at a vanity
 * 0xB200… address that fakes the B20 read surface (supplyCap(), policyId(), …).
 * The B20Factory is the one authority that can't be spoofed: real B20s are
 * chain-native precompiles it registered, and they hold NO bytecode.
 */
export async function b20Authenticity(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… token address (address=)");
  const addr = getAddress(address);

  // 10-byte B20 prefix (0xb2 + 9 zero bytes), byte 10 = variant.
  const looksB20 = addr.toLowerCase().startsWith("0xb2" + "0".repeat(18));
  const contracts = [
    { address: B20_FACTORY, abi: FACTORY_ABI, functionName: "isB20", args: [addr] },
    { address: B20_FACTORY, abi: FACTORY_ABI, functionName: "isB20Initialized", args: [addr] },
  ] as const;
  type MC = { status: "success"; result: unknown } | { status: "failure"; error: Error };
  let r: MC[];
  try {
    r = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as unknown as MC[];
  } catch {
    await sleep(400);
    r = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as unknown as MC[];
  }
  const [isRes, initRes] = r;
  if (isRes.status !== "success") throw new Error("B20 factory read unavailable (RPC) — try again shortly");
  const factorySaysB20 = isRes.result === true;
  const initialized = initRes.status === "success" ? initRes.result === true : null;

  await sleep(120);
  const code = await withRetry<string | null>(
    async () => (await client.getCode({ address: addr })) ?? "0x",
    null,
    true,
  );
  const hasBytecode = code !== null && code !== "0x" && code.length > 2;

  const verdict = factorySaysB20
    ? initialized === false
      ? "genuine_uninitialized"
      : "genuine"
    : looksB20
      ? "fake_lookalike"
      : "not_b20";

  return {
    address: addr,
    prefixLooksB20: looksB20,
    factoryConfirms: factorySaysB20,
    initialized,
    hasBytecode, // real B20 precompiles hold NO bytecode; a lookalike contract does
    verdict, // genuine | genuine_uninitialized | fake_lookalike | not_b20
    recommendation: factorySaysB20
      ? "Genuine B20 — registered by the B20Factory precompile. Safe to run the rest of the B20 suite (b20-safety, b20-gate, b20-dossier) against it."
      : looksB20
        ? "🚨 FAKE — the address is shaped like a B20 (0xB200… prefix) but the B20Factory does NOT recognize it. This is a lookalike impersonating a Base-native token. Distrust every 'B20' claim it makes; at best treat it as an unknown ERC-20 (token-risk, contract-danger)."
        : "Not a B20 — the factory doesn't recognize this address and it doesn't carry the B20 prefix. Use the ERC-20 tools (token-risk, rug-score).",
    note: "Authenticity check against the B20Factory precompile — the one signal a vanity-address impersonator can't fake. Genuine B20s are chain-native precompiles with no bytecode; a 0xB200…-prefixed EVM contract is an impersonation. Run FIRST, before trusting any B20 analysis of an unknown token. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 16. B20 Config Audit — bricked scopes, dangling policies, frozen lists ----

const POLICY_EXISTS_ABI = [
  { type: "function", name: "policyExists", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "policyAdmin", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [{ type: "address" }] },
] as const;

const ALWAYS_BLOCK_ID = (1n << 56n) | 1n; // (uint64(ALLOWLIST) << 56) | 1 per B20Constants

/**
 * The Base docs warn issuers directly: binding a scope to a NON-EXISTENT policy
 * silently collapses to empty-set semantics — a non-existent ALLOWLIST denies
 * EVERYONE (transfers bricked), a non-existent BLOCKLIST allows everyone
 * (gating silently off). This audits every scope for those footguns plus
 * ALWAYS_BLOCK bindings, renounced (frozen) policy admins, and live pauses.
 */
export async function b20ConfigAudit(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);
  const pids = await readPolicyIds(addr);
  if (!pids) return notB20(address);

  const scopeDefs: Array<[string, bigint, string]> = [
    ["transfer-sender", pids.sender, "outbound transfers"],
    ["transfer-receiver", pids.receiver, "inbound transfers"],
    ["transfer-executor", pids.executor, "third-party transferFrom (approvals, DEXs, smart wallets)"],
    ["mint-receiver", pids.mint, "minting new supply"],
  ];

  const findings: Array<{ severity: string; scope: string; issue: string }> = [];
  const scopes: Array<Record<string, unknown>> = [];
  for (const [scope, pid, gates] of scopeDefs) {
    if (pid === 0n) {
      scopes.push({ scope, policyId: "0", type: "none", state: "open" });
      continue;
    }
    const type = policyType(pid);
    let exists: boolean | null = null;
    let admin: string | null = null;
    if (pid !== ALWAYS_BLOCK_ID) {
      await sleep(120);
      exists = await withRetry<boolean | null>(
        () => client.readContract({ address: B20_POLICY_REGISTRY, abi: POLICY_EXISTS_ABI, functionName: "policyExists", args: [pid] }) as Promise<boolean>,
        null,
        true,
      );
      if (exists) {
        await sleep(120);
        admin = await withRetry<string | null>(
          () => client.readContract({ address: B20_POLICY_REGISTRY, abi: POLICY_EXISTS_ABI, functionName: "policyAdmin", args: [pid] }) as Promise<string>,
          null,
          true,
        );
      }
    }

    let state = "ok";
    if (pid === ALWAYS_BLOCK_ID) {
      state = "deny_all";
      findings.push({ severity: "critical", scope, issue: `Scope is bound to ALWAYS_BLOCK — ${gates} are DEAD (every account denied).` });
    } else if (exists === false && type === "allowlist") {
      state = "deny_all_dangling";
      findings.push({ severity: "critical", scope, issue: `Scope points to a NON-EXISTENT allowlist policy (#${pid}) — empty-set semantics deny EVERYONE; ${gates} are bricked. The exact footgun the Base docs warn about.` });
    } else if (exists === false && type === "blocklist") {
      state = "open_dangling";
      findings.push({ severity: "warning", scope, issue: `Scope points to a NON-EXISTENT blocklist policy (#${pid}) — gating is silently OFF (everyone allowed). Likely a misconfiguration.` });
    } else if (admin === ZERO_ADDR) {
      state = "frozen";
      findings.push({ severity: "info", scope, issue: `Policy #${pid} admin is renounced — membership is frozen forever (no new blocks/allows possible on this list).` });
    }
    scopes.push({
      scope,
      policyId: pid.toString(),
      type,
      exists,
      admin: admin && admin !== ZERO_ADDR ? getAddress(admin) : null,
      renounced: admin === ZERO_ADDR,
      state,
    });
  }

  if (s.paused.transfer) findings.push({ severity: "critical", scope: "pause", issue: "TRANSFER is paused right now — the token cannot move." });
  if (s.paused.mint) findings.push({ severity: "info", scope: "pause", issue: "MINT is paused." });
  if (s.paused.burn) findings.push({ severity: "info", scope: "pause", issue: "BURN is paused." });

  const critical = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const transferDead =
    s.paused.transfer ||
    scopes.some((x) => (x.scope === "transfer-sender" || x.scope === "transfer-receiver") && (x.state === "deny_all" || x.state === "deny_all_dangling"));

  const verdict = transferDead ? "bricked" : critical ? "critical_misconfig" : warnings ? "misconfigured" : "clean";

  return {
    address,
    isB20: true,
    symbol: s.symbol,
    variant: s.variant,
    ...(s.degraded || pids.degraded ? { degraded: true } : {}),
    verdict, // bricked | critical_misconfig | misconfigured | clean
    transferDead,
    findings,
    scopes,
    recommendation: transferDead
      ? "🚨 This token CANNOT MOVE right now (paused and/or a transfer scope denies everyone). Do not buy or accept it until the issuer fixes the configuration — funds sent in may be stuck."
      : critical
        ? "Critical configuration faults found — a scope is dead or dangling. Issuers: fix the policy binding (validate policyExists before updatePolicy). Holders: treat operational risk as elevated."
        : warnings
          ? "Configuration is sloppy (dangling policy binding) but the token functions. Issuers should rebind the scope to a real policy."
          : "Configuration is clean: every bound policy exists, no deny-all scopes, nothing paused.",
    note: "Lints a B20's policy wiring for the misconfigurations the Base docs warn about: scopes bound to non-existent policies (a dangling ALLOWLIST silently bricks transfers), ALWAYS_BLOCK bindings, renounced/frozen lists, and live pauses. Pre-launch lint for issuers; a can-it-even-move check for holders. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 17. B20 Policy Members — the FULL blocklist/allowlist, not one wallet ----

/** parameters.accounts may come back as a real array OR as the CDP indexer's
 * flat-string form "{0xabc 0xdef}" (same quirk as SpendPermission tuples). */
function parseAccountsParam(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return v.replace(/^[{[]|[}\]]$/g, "").split(/[\s,]+/).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x));
  return [];
}

/**
 * b20-freeze-check answers "is THIS wallet blocked"; this reconstructs the
 * ENTIRE membership of a token's blocklist/allowlist by replaying the Policy
 * Registry's BlocklistUpdated / AllowlistUpdated events — every address ever
 * blocked (or whitelisted), when, by whom, and the current member set.
 * Compliance-grade visibility no other tool provides. Pass policy= to read a
 * registry policy directly, or address= to resolve a token's active policies.
 */
export async function b20PolicyMembers(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  const policyParam = (params.policy || params.policyId || "").trim();

  // Which policy ids do we replay?
  let targets: Array<{ scope: string; pid: bigint }> = [];
  let tokenMeta: { symbol: string | null; degraded: boolean } | null = null;
  if (policyParam) {
    if (!/^\d+$/.test(policyParam)) throw new Error("policy= must be a numeric uint64 policy ID");
    targets = [{ scope: "direct", pid: BigInt(policyParam) }];
  } else {
    if (!validAddr(address)) throw new Error("Provide a B20 token (address=) or a registry policy ID (policy=)");
    const addr = getAddress(address);
    const s = await readB20Signals(addr);
    if (!s.isB20) return notB20(address);
    const pids = await readPolicyIds(addr);
    if (!pids) return notB20(address);
    tokenMeta = { symbol: s.symbol, degraded: s.degraded || pids.degraded };
    targets = (
      [
        ["transfer-sender", pids.sender],
        ["transfer-receiver", pids.receiver],
        ["transfer-executor", pids.executor],
        ["mint-receiver", pids.mint],
      ] as Array<[string, bigint]>
    )
      .filter(([, pid]) => pid !== 0n && pid !== ALWAYS_BLOCK_ID)
      .map(([scope, pid]) => ({ scope, pid }));
    if (targets.length === 0) {
      return {
        address, isB20: true, symbol: tokenMeta.symbol,
        policies: [], verdict: "no_policies",
        recommendation: "No registry-backed transfer/mint policies on this token — there is no blocklist or allowlist membership to enumerate.",
        note: "Full blocklist/allowlist membership replay for a B20's policies. This token has none bound.",
        checkedAt: new Date().toISOString(),
      };
    }
  }

  // One scan of the registry's membership events (B20 is weeks old — the full
  // history fits; ordered ASC for replay). Filter per policy id JS-side:
  // topics[1] is the indexed uint64 policyId as a 32-byte word.
  const rows = await cdpSql<{ event_name?: string; block_timestamp?: string; topics?: string[]; parameters?: Record<string, unknown>; transaction_hash?: string }>(
    `SELECT event_name, block_timestamp, topics, parameters, transaction_hash FROM base.events WHERE address = '${B20_POLICY_REGISTRY.toLowerCase()}' AND (event_name = 'BlocklistUpdated' OR event_name = 'AllowlistUpdated') AND block_timestamp > now() - INTERVAL 365 DAY ORDER BY block_timestamp ASC LIMIT 5000`,
  );
  if (rows === null) throw new Error("Policy Registry event data unavailable (data provider) — try again shortly");
  const truncated = rows.length >= 5000;

  const policies: Array<Record<string, unknown>> = [];
  for (const { scope, pid } of targets) {
    const pidHex = "0x" + pid.toString(16).padStart(64, "0");
    const members = new Set<string>();
    const changes: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      if ((r.topics?.[1] ?? "").toLowerCase() !== pidHex) continue;
      const flagRaw = r.parameters?.allowed ?? r.parameters?.blocked;
      const setMembership = String(flagRaw).toLowerCase() === "true" || flagRaw === true;
      const accounts = parseAccountsParam(r.parameters?.accounts);
      for (const a of accounts) {
        try {
          const acct = getAddress(a);
          if (setMembership) members.add(acct);
          else members.delete(acct);
        } catch { /* skip malformed */ }
      }
      changes.push({
        time: r.block_timestamp ?? null,
        action: setMembership ? "added" : "removed",
        updater: topicToAddr(r.topics?.[2]),
        accounts: accounts.slice(0, 20),
        txHash: r.transaction_hash ?? null,
      });
    }
    policies.push({
      scope,
      policyId: pid.toString(),
      type: policyType(pid),
      memberCount: members.size,
      members: [...members].slice(0, 200),
      changeCount: changes.length,
      recentChanges: changes.slice(-25).reverse(),
    });
  }

  const totalMembers = policies.reduce((n, p) => n + (p.memberCount as number), 0);
  const anyBlocklist = policies.some((p) => p.type === "blocklist" && (p.memberCount as number) > 0);
  const verdict = anyBlocklist ? "active_blocklist" : totalMembers > 0 ? "allowlist_membership" : "empty_lists";

  return {
    ...(address && validAddr(address) ? { address, isB20: true, symbol: tokenMeta?.symbol ?? null } : {}),
    ...(tokenMeta?.degraded ? { degraded: true } : {}),
    ...(truncated ? { truncated: true, truncationNote: "Registry event scan hit the 5000-row cap — member sets may be incomplete." } : {}),
    policies,
    totalMembers,
    verdict, // active_blocklist | allowlist_membership | empty_lists | no_policies
    recommendation: anyBlocklist
      ? "⚠️ This token's blocklist has real members — the issuer actively blocks addresses (blocked holders with a sender policy are seizable via burnBlocked). Check the members list; cross-check seizures with b20-seizure-history."
      : totalMembers > 0
        ? "Allowlist membership found — this is a permissioned token; only the listed addresses can participate on the gated scopes."
        : "The bound policies currently have no members (empty lists) — gating exists but nobody is blocked/whitelisted yet. Note: members seeded via createPolicyWithAccounts at creation may predate the event history.",
    note: "Reconstructs the FULL membership of a B20's blocklist/allowlist policies (BlocklistUpdated/AllowlistUpdated replay from the Policy Registry): every blocked/whitelisted address, when, and by whom. b20-freeze-check answers it for one wallet; this enumerates the whole list. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 18. B20 Genesis Audit — what did the issuer do in the initCalls bypass window? ----

/**
 * createB20's initCalls run with role gates AND transfer-side policy gates
 * BYPASSED (a factory-only privilege window). Whatever the issuer did there —
 * pre-mints, role grants, policy bindings, blocklist seeding — happened before
 * any external control existed. This reconstructs the creation transaction's
 * full event trail: the token's true starting conditions.
 */
export async function b20GenesisAudit(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);

  // Earliest events emitted BY the token = its creation tx (initCalls execute
  // inside createB20's transaction).
  // Lower-bounded at Beryl activation (no B20 exists before 2026-06) — keeps
  // the scan inside CDP SQL's read limits as the chain grows.
  const firstRows = await cdpSql<{ block_timestamp?: string; transaction_hash?: string }>(
    `SELECT block_timestamp, transaction_hash FROM base.events WHERE address = '${addr.toLowerCase()}' AND block_timestamp > '2026-06-01' ORDER BY block_timestamp ASC LIMIT 1`,
  );
  if (firstRows === null) throw new Error("B20 event data unavailable (data provider) — try again shortly");
  if (!firstRows.length || !firstRows[0].transaction_hash) {
    return {
      address, isB20: true, symbol: s.symbol,
      verdict: "no_genesis_activity",
      note: "No indexed events from this token yet — either it was created with no initCalls and has never been used, or indexing hasn't caught up.",
      checkedAt: new Date().toISOString(),
    };
  }
  const genesisTx = firstRows[0].transaction_hash;
  const genesisTime = firstRows[0].block_timestamp ?? null;
  if (!genesisTime) throw new Error("B20 event data unavailable (data provider) — try again shortly");

  // Everything that happened in that tx — token, registry AND factory events.
  // A bare transaction_hash filter is rejected by CDP SQL (unbounded scan);
  // a ±1-day timestamp window around the known genesis time prunes it.
  const gDay = new Date(genesisTime);
  const lo = new Date(gDay.getTime() - 86_400_000).toISOString().slice(0, 10);
  const hi = new Date(gDay.getTime() + 86_400_000).toISOString().slice(0, 10);
  const rows = await cdpSql<{ address?: string; event_name?: string; topics?: string[]; parameters?: Record<string, unknown> }>(
    `SELECT address, event_name, topics, parameters FROM base.events WHERE transaction_hash = '${genesisTx}' AND block_timestamp BETWEEN '${lo}' AND '${hi}' LIMIT 500`,
  );
  if (rows === null) throw new Error("B20 event data unavailable (data provider) — try again shortly");

  const factoryConfirmed = rows.some(
    (r) => (r.address ?? "").toLowerCase() === B20_FACTORY.toLowerCase() && /^B20Created/.test(r.event_name ?? ""),
  );
  const tokenRows = rows.filter((r) => (r.address ?? "").toLowerCase() === addr.toLowerCase());

  const preMints: Array<{ to: string | null; amount: string }> = [];
  const roleGrants: Array<{ role: string; account: string | null }> = [];
  const policyBindings: Array<{ scope: string; policyId: string }> = [];
  const listSeeds: Array<{ policy: string; action: string; accounts: string[] }> = [];
  let capSetAtGenesis: string | null = null;

  const scopeNames = new Map<string, string>([
    [TRANSFER_SENDER_POLICY.toLowerCase(), "transfer-sender"],
    [TRANSFER_RECEIVER_POLICY.toLowerCase(), "transfer-receiver"],
    [TRANSFER_EXECUTOR_POLICY.toLowerCase(), "transfer-executor"],
    [MINT_RECEIVER_POLICY.toLowerCase(), "mint-receiver"],
  ]);

  for (const r of tokenRows) {
    const name = r.event_name ?? "";
    const t = r.topics ?? [];
    if (name === "Transfer") {
      const from = topicToAddr(t[1]);
      if (from === ZERO_ADDR || from === null || /^0x0{40}$/i.test(from ?? "")) {
        preMints.push({ to: topicToAddr(t[2]), amount: String((r.parameters as { value?: string })?.value ?? "0") });
      }
    } else if (name === "RoleGranted") {
      roleGrants.push({ role: String(t[1] ?? "").slice(0, 10), account: topicToAddr(t[2]) });
    } else if (name === "PolicyUpdated") {
      const scope = scopeNames.get(String(t[1] ?? "").toLowerCase()) ?? String(t[1] ?? "").slice(0, 10);
      policyBindings.push({ scope, policyId: String((r.parameters as { newPolicyId?: string })?.newPolicyId ?? "?") });
    } else if (name === "SupplyCapUpdated") {
      capSetAtGenesis = String((r.parameters as { newSupplyCap?: string })?.newSupplyCap ?? null);
    }
  }
  for (const r of rows) {
    if ((r.address ?? "").toLowerCase() !== B20_POLICY_REGISTRY.toLowerCase()) continue;
    const name = r.event_name ?? "";
    if (name === "BlocklistUpdated" || name === "AllowlistUpdated") {
      const flagRaw = (r.parameters as Record<string, unknown>)?.allowed ?? (r.parameters as Record<string, unknown>)?.blocked;
      listSeeds.push({
        policy: name === "BlocklistUpdated" ? "blocklist" : "allowlist",
        action: String(flagRaw).toLowerCase() === "true" || flagRaw === true ? "seeded" : "removed",
        accounts: parseAccountsParam((r.parameters as Record<string, unknown>)?.accounts).slice(0, 20),
      });
    }
  }

  const totalPreMinted = preMints.reduce((n, m) => { try { return n + BigInt(m.amount); } catch { return n; } }, 0n);
  const flags: string[] = [];
  if (preMints.length) flags.push(`pre-minted ${totalPreMinted.toString()} raw units to ${new Set(preMints.map((m) => m.to)).size} address(es) inside the bypass window`);
  if (policyBindings.length) flags.push("transfer/mint policies were bound at genesis (gating designed-in, not added later)");
  if (listSeeds.length) flags.push("blocklist/allowlist membership was SEEDED at genesis");
  if (roleGrants.length) flags.push(`${roleGrants.length} role grant(s) at genesis`);

  const verdict = listSeeds.some((x) => x.policy === "blocklist" && x.action === "seeded")
    ? "blocklist_seeded"
    : preMints.length && policyBindings.length
      ? "configured_launch"
      : preMints.length
        ? "premined"
        : policyBindings.length || roleGrants.length
          ? "configured_launch"
          : "bare_launch";

  return {
    address, isB20: true, symbol: s.symbol, variant: s.variant,
    genesisTx, genesisTime, factoryConfirmed,
    ...(factoryConfirmed ? {} : { caveat: "The earliest indexed activity tx does not contain B20Created — the true creation emitted no token events; showing earliest activity instead." }),
    preMints: preMints.slice(0, 25),
    totalPreMinted: totalPreMinted.toString(),
    roleGrants: roleGrants.slice(0, 25),
    policyBindings,
    listSeeds,
    ...(capSetAtGenesis ? { supplyCapAtGenesis: capSetAtGenesis } : {}),
    flags,
    verdict, // blocklist_seeded | premined | configured_launch | bare_launch | no_genesis_activity
    recommendation: verdict === "blocklist_seeded"
      ? "⚠️ The issuer seeded blocklist membership AT CREATION — addresses were blocked before the token ever traded. Deliberate, compliance-style launch; review the seeded list (b20-policy-members)."
      : preMints.length
        ? `The issuer pre-minted supply during the initCalls bypass window (role/policy gates OFF). Check who received it and how concentrated it is before sizing in.`
        : "Clean/bare genesis — no pre-mint, no seeded lists detected at creation.",
    note: "Reconstructs a B20's creation transaction — everything the issuer did in the initCalls bypass window (pre-mints, role grants, policy bindings, blocklist seeding), when role and transfer-policy gates were suspended. The token's true starting conditions. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 19. B20 Mint Watch — the live dilution feed (who is printing, right now) ----

const ZERO_TOPIC = "0x" + "0".repeat(64);

/**
 * b20-supply reads the dilution CEILING (cap vs minted); this reads the actual
 * mint STREAM: every mint/batchMint (Transfer from 0x0) in the window — how
 * much was printed, to whom, how fast, and what share of current supply that is.
 */
export async function b20MintWatch(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const days = Math.min(90, Math.max(1, Number(params.days || 30) || 30));
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);

  await sleep(120);
  const totalSupply = await withRetry<bigint>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "totalSupply" }) as Promise<bigint>,
    0n,
    true,
  );

  const rows = await cdpSql<{ block_timestamp?: string; topics?: string[]; parameters?: { amount?: string }; transaction_hash?: string }>(
    `SELECT block_timestamp, topics, parameters, transaction_hash FROM base.events WHERE address = '${addr.toLowerCase()}' AND event_name = 'Transfer' AND block_timestamp > now() - INTERVAL ${days} DAY ORDER BY block_timestamp DESC LIMIT 2000`,
  );
  if (rows === null) throw new Error("B20 transfer event data unavailable (data provider) — try again shortly");
  const truncated = rows.length >= 2000;

  const mints = rows
    .filter((r) => (r.topics?.[1] ?? "").toLowerCase() === ZERO_TOPIC)
    .map((r) => ({
      time: r.block_timestamp ?? null,
      to: topicToAddr(r.topics?.[2]),
      amount: String((r.parameters as { value?: string })?.value ?? "0"),
      txHash: r.transaction_hash ?? null,
    }));

  let minted = 0n;
  for (const m of mints) { try { minted += BigInt(m.amount); } catch { /* skip */ } }
  const recipients = new Set(mints.map((m) => m.to).filter(Boolean));
  const pctOfSupply = totalSupply > 0n ? Number((minted * 10000n) / totalSupply) / 100 : null;

  const verdict = mints.length === 0
    ? "quiet"
    : pctOfSupply !== null && pctOfSupply >= 20
      ? "heavy_dilution"
      : pctOfSupply !== null && pctOfSupply >= 5
        ? "active_minting"
        : "minor_minting";

  return {
    address, isB20: true, symbol: s.symbol, variant: s.variant,
    windowDays: days,
    mintCount: mints.length,
    mintedInWindow: minted.toString(),
    pctOfCurrentSupply: pctOfSupply,
    distinctRecipients: recipients.size,
    totalSupply: totalSupply.toString(),
    supplyCap: s.supplyCapped ? s.supplyCap.toString() : "uncapped",
    mintGated: s.mintGated,
    mintPaused: s.paused.mint,
    ...(truncated ? { truncated: true } : {}),
    mints: mints.slice(0, 50),
    verdict, // heavy_dilution | active_minting | minor_minting | quiet
    recommendation: verdict === "heavy_dilution"
      ? `⚠️ ${pctOfSupply}% of the current supply was minted in the last ${days} days — the issuer is printing aggressively. Existing holders are being diluted in real time; check the cap ceiling with b20-supply before holding.`
      : verdict === "active_minting"
        ? `Meaningful issuance: ${pctOfSupply}% of current supply minted in ${days} days across ${recipients.size} recipient(s). Normal for a growing stablecoin/RWA — but verify the mint role holders (b20-control) and cap (b20-supply).`
        : mints.length
          ? "Minor minting activity — issuance is present but small relative to supply."
          : `No mints in the last ${days} days — supply is static in this window.${s.supplyCapped ? "" : " Note: the token is UNCAPPED, so this can change at any time."}`,
    note: "The live dilution feed for a B20: every mint (Transfer from 0x0, incl. batchMint) in the window — amount, recipients, and share of current supply. b20-supply shows the ceiling; this shows the printing. Pass days= (1-90, default 30). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 20. B20 Rebase History — silent balance rescaling, on the record ----

/**
 * An Asset-variant B20's multiplier rescales EVERY holder's visible balance in
 * one call (updateMultiplier — no per-account events, nothing in your tx
 * history). b20-rebase reads today's multiplier; this replays MultiplierUpdated
 * to show every rescaling that ever happened — especially DOWNWARD moves, which
 * cut every holder's balance silently.
 */
export async function b20RebaseHistory(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);
  if (s.variant !== "asset") {
    return {
      address, isB20: true, variant: s.variant, symbol: s.symbol,
      verdict: "n/a",
      note: "The rebase multiplier is an Asset-variant feature; this Stablecoin B20 has no multiplier (balances are never rescaled).",
      checkedAt: new Date().toISOString(),
    };
  }

  await sleep(120);
  const current = await withRetry<bigint>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "multiplier" }) as Promise<bigint>,
    WAD,
    true,
  );

  const rows = await cdpSql<{ block_timestamp?: string; parameters?: { multiplier?: string }; transaction_hash?: string }>(
    `SELECT block_timestamp, parameters, transaction_hash FROM base.events WHERE address = '${addr.toLowerCase()}' AND event_name = 'MultiplierUpdated' AND block_timestamp > now() - INTERVAL 365 DAY ORDER BY block_timestamp ASC LIMIT 200`,
  );
  if (rows === null) throw new Error("B20 rebase event data unavailable (data provider) — try again shortly");

  let prev = WAD; // multiplier starts at 1.0 (WAD)
  const changes = rows.map((r) => {
    const to = (() => { try { return BigInt(String(r.parameters?.multiplier ?? "0")); } catch { return 0n; } })();
    const direction = to > prev ? "up" : to < prev ? "down" : "flat";
    const pct = prev > 0n ? Number(((to - prev) * 10000n) / prev) / 100 : null;
    const entry = {
      time: r.block_timestamp ?? null,
      multiplier: to.toString(),
      asFloat: Number(to) / 1e18,
      direction,
      changePct: pct,
      txHash: r.transaction_hash ?? null,
    };
    prev = to;
    return entry;
  });
  const downMoves = changes.filter((c) => c.direction === "down");

  const verdict = downMoves.length
    ? "negative_rebase_history"
    : changes.length
      ? "rebasing"
      : "static";

  return {
    address, isB20: true, variant: "asset", symbol: s.symbol,
    currentMultiplier: current.toString(),
    currentAsFloat: Number(current) / 1e18,
    rebaseCount: changes.length,
    negativeRebases: downMoves.length,
    changes: changes.slice(-50).reverse(),
    verdict, // negative_rebase_history | rebasing | static
    recommendation: downMoves.length
      ? `⚠️ This token has rebased DOWNWARD ${downMoves.length} time(s) — every holder's balance was silently cut (no transfer, no per-account event). Understand the operator's rebase policy before holding; watch b20-rebase for the live value.`
      : changes.length
        ? `${changes.length} multiplier update(s) on record, all upward/flat — yield-style rebasing. Balances scale by the multiplier; the operator (OPERATOR_ROLE) controls it.`
        : "No multiplier changes on record — balances have never been rescaled (multiplier is at its launch value).",
    note: "Replays every MultiplierUpdated on an Asset B20 — the full history of balance rescaling, including downward moves that cut every holder silently. b20-rebase reads today's value; this shows the operator's track record. 365-day window. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 21. B20 Peg Check — declared currency vs actual market price ----

interface DexPair {
  priceUsd?: string;
  liquidity?: { usd?: number };
  baseToken?: { address?: string };
  dexId?: string;
  pairAddress?: string;
}

/**
 * A B20 Stablecoin's currency() is SELF-DECLARED — nothing verifies it. This is
 * the missing verification: read the declared peg, then check what the market
 * actually prices the token at (DEX pools). "Says USD, trades at $0.71" is the
 * one-call rug signal for agents settling in B20 stablecoins.
 */
export async function b20Peg(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… B20 token address");
  const addr = getAddress(address);
  const s = await readB20Signals(addr);
  if (!s.isB20) return notB20(address);
  if (s.variant !== "stablecoin") {
    return {
      address, isB20: true, variant: s.variant, symbol: s.symbol,
      verdict: "not_stablecoin",
      note: "Peg verification applies to Stablecoin-variant B20s (declared currency()). For Asset variants use b20-rebase / b20-info.",
      checkedAt: new Date().toISOString(),
    };
  }

  await sleep(120);
  const declaredCurrency = await withRetry<string | null>(
    () => client.readContract({ address: addr, abi: CURRENCY_ABI, functionName: "currency" }) as Promise<string>,
    null,
    true,
  );

  const pairs = await dexTokenPairs<DexPair>(addr);
  const own = (pairs ?? [])
    .filter((p) => (p.baseToken?.address ?? "").toLowerCase() === addr.toLowerCase() && p.priceUsd)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const best = own[0] ?? null;
  const priceUsd = best?.priceUsd ? Number(best.priceUsd) : null;
  const liquidityUsd = best?.liquidity?.usd ?? null;

  const isUsdPeg = (declaredCurrency ?? "").toUpperCase() === "USD";
  let deviationPct: number | null = null;
  if (priceUsd !== null && isUsdPeg) deviationPct = Math.round(Math.abs(priceUsd - 1) * 10000) / 100;

  const verdict = pairs === null
    ? "unknown"
    : priceUsd === null
      ? "no_market"
      : !isUsdPeg
        ? "unverifiable_fx"
        : deviationPct !== null && deviationPct <= 1
          ? "on_peg"
          : deviationPct !== null && deviationPct <= 5
            ? "depeg_warning"
            : "depegged";

  return {
    address, isB20: true, variant: "stablecoin", symbol: s.symbol,
    declaredCurrency,
    marketPriceUsd: priceUsd,
    liquidityUsd,
    ...(best ? { dex: best.dexId ?? null, pair: best.pairAddress ?? null } : {}),
    ...(deviationPct !== null ? { deviationPct } : {}),
    verdict, // on_peg | depeg_warning | depegged | no_market | unverifiable_fx | unknown | not_stablecoin
    recommendation: verdict === "depegged"
      ? `🚨 DEPEGGED — declares ${declaredCurrency} but trades at $${priceUsd} (${deviationPct}% off). The self-declared peg is NOT holding; do not treat this as a dollar. Check issuer control (b20-stablecoin) and seizure posture (b20-safety) before touching it.`
      : verdict === "depeg_warning"
        ? `⚠️ Trading ${deviationPct}% off its declared ${declaredCurrency} peg ($${priceUsd}). Thin liquidity or early stress — recheck before settling meaningful size.`
        : verdict === "on_peg"
          ? `Holding its declared ${declaredCurrency} peg ($${priceUsd}, ${deviationPct}% deviation) on $${liquidityUsd ? Math.round(liquidityUsd).toLocaleString() : "?"} of DEX liquidity.`
          : verdict === "no_market"
            ? `Declares ${declaredCurrency || "no currency"} but has NO DEX market — the peg is a pure claim with zero price discovery. Fine for closed-loop/institutional settlement; do not assume exchangeability.`
            : verdict === "unverifiable_fx"
              ? `Declares ${declaredCurrency} — a non-USD peg; USD-denominated DEX pricing ($${priceUsd}) can't verify it directly without an FX oracle. Compare against the ${declaredCurrency}/USD rate yourself.`
              : "Market data unavailable right now — peg could not be verified this call.",
    note: "Verifies a B20 Stablecoin's SELF-DECLARED currency() against its actual DEX market price — the check the standard itself doesn't do (the docs: the code is 'not verified against any external registry'). USD pegs get a deviation verdict; non-USD pegs report price for FX comparison. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
