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

// B20Factory event, for the launch radar.
const B20_CREATED = parseAbiItem(
  "event B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)",
);

// Policy scope ids are keccak256 of the label (per B20Constants).
const TRANSFER_SENDER_POLICY = keccak256(toBytes("TRANSFER_SENDER_POLICY"));
const TRANSFER_RECEIVER_POLICY = keccak256(toBytes("TRANSFER_RECEIVER_POLICY"));
// PausableFeature enum: TRANSFER=0, MINT=1, BURN=2. B20Variant enum: Asset=0, Stablecoin=1.
const MAX_SUPPLY_CAP = (1n << 128n) - 1n; // uint128.max == "no cap" sentinel
const WAD = 10n ** 18n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  for (let i = 0; i < 3; i++) {
    try {
      return await call();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/revert/i.test(msg)) return fallback; // clean revert → fallback, don't retry
      if (i === 2) return fallback;
      await sleep(300);
    }
  }
  return fallback;
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
  paused: { transfer: boolean; mint: boolean; burn: boolean };
  rebase: boolean;
  supplyCapped: boolean;
  /** True when a seize/freeze-critical read failed (RPC) — verdict must not be trusted as safe. */
  degraded: boolean;
}

async function readB20Signals(addr: `0x${string}`): Promise<B20Signals> {
  const empty: B20Signals = {
    isB20: false, variant: null, symbol: null, supplyCap: 0n, canSeize: false,
    transferGated: false, senderPolicyId: 0n, paused: { transfer: false, mint: false, burn: false },
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
  ] as const;

  type MC = { status: "success"; result: unknown } | { status: "failure"; error: Error };
  let r: MC[];
  try {
    r = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as unknown as MC[];
  } catch {
    // Whole-chain RPC failure (not a per-call revert) — retry once, else give up.
    try {
      await sleep(400);
      r = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as unknown as MC[];
    } catch {
      return empty;
    }
  }

  const [scRes, symRes, multRes, spRes, rpRes, p0, p1, p2] = r;
  if (scRes.status !== "success") return empty; // supplyCap reverted / no data → not a B20
  const supplyCap = scRes.result as bigint;
  const symbol = symRes.status === "success" ? (symRes.result as string) : null;
  const variant: "asset" | "stablecoin" = multRes.status === "success" ? "asset" : "stablecoin";

  // On a confirmed B20, a failed seize/freeze-critical read = degraded (we must
  // NOT read that as "no policy" and call a seizable token safe).
  const degraded = spRes.status !== "success" || rpRes.status !== "success" || p0.status !== "success";
  const senderPol = spRes.status === "success" ? (spRes.result as bigint) : 0n;
  const recvPol = rpRes.status === "success" ? (rpRes.result as bigint) : 0n;

  return {
    isB20: true, variant, symbol, supplyCap,
    canSeize: senderPol > 0n,
    transferGated: senderPol > 0n || recvPol > 0n,
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
    powers: { seizable: s.canSeize, freezable: s.transferGated, pausedNow: s.paused.transfer, rebase: s.rebase, uncappedMint: !s.supplyCapped },
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
  const name = await withRetry<string | null>(() => client.readContract({ address: addr, abi: B20_ABI, functionName: "name" }) as Promise<string | null>, null);
  await sleep(120);
  const decimals = await withRetry<number | null>(() => client.readContract({ address: addr, abi: B20_ABI, functionName: "decimals" }) as Promise<number | null>, null);
  await sleep(120);
  const totalSupply = await withRetry<bigint>(() => client.readContract({ address: addr, abi: B20_ABI, functionName: "totalSupply" }) as Promise<bigint>, 0n);

  return {
    address, isB20: true, name, symbol: s.symbol, variant: s.variant, decimals,
    totalSupply: totalSupply.toString(),
    supplyCapped: s.supplyCapped,
    supplyCap: s.supplyCapped ? s.supplyCap.toString() : "uncapped",
    policies: { senderPolicyId: s.senderPolicyId.toString(), transferGated: s.transferGated },
    paused: s.paused,
    rebase: s.rebase,
    note: "B20 (Base-native) token profile read from the precompile. For a risk verdict use b20-safety; to check if YOUR wallet is blocked use b20-freeze-check.",
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
    () => client.readContract({ address: B20_POLICY_REGISTRY, abi: POLICY_ABI, functionName: "isAuthorized", args: [senderPol, getAddress(wallet)] }) as Promise<boolean | null>, null);

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

  const mult = await withRetry<bigint | null>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "multiplier" }) as Promise<bigint | null>, null);

  if (mult === null) {
    // Either not a B20, or a Stablecoin (no multiplier).
    const s = await readB20Signals(addr);
    if (!s.isB20) return notB20(address);
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
    const r = await b20Safety({ address: a });
    results.push(
      r.isB20
        ? { address: a, isB20: true, symbol: (r as { symbol?: string }).symbol ?? null, verdict: (r as { verdict?: string }).verdict, riskScore: (r as { riskScore?: number }).riskScore }
        : { address: a, isB20: false },
    );
    await sleep(150);
  }
  const worst = results.reduce((m, r) => Math.max(m, ("riskScore" in r ? r.riskScore ?? 0 : 0)), 0);
  return {
    count: results.length, worstRiskScore: worst, results,
    note: "Batch B20 safety scan (max 5). Each is scored for freeze/seize/pause/rebase/uncapped-mint. Not financial advice.",
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
    powers: { seizable: s.canSeize, freezable: s.transferGated, pausedNow: s.paused.transfer, rebase: s.rebase, uncappedMint: !s.supplyCapped },
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
  for (const c of candidates) {
    const s = await readB20Signals(getAddress(c));
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
  const verdict = blocked.length ? "action_required" : seizable.length ? "exposed" : holdings.length ? "clear" : "no_b20";

  return {
    wallet, b20Count: holdings.length, seizableCount: seizable.length, blockedCount: blocked.length,
    verdict, holdings,
    recommendation:
      blocked.length ? `⚠️ You are ALREADY blocked/seizable on ${blocked.length} B20 token(s) — exit those positions if you can.`
        : seizable.length ? `${seizable.length} of your B20 holdings can be frozen/seized by their issuer. Watch policy changes (b20-policy-watch) and size accordingly.`
          : holdings.length ? "None of your B20 holdings have active freeze/seize powers set right now."
            : "No B20 (Base-native) tokens found in this wallet.",
    note: "Scans a wallet's B20 holdings for protocol-level freeze/seize powers and whether YOUR address is already blocked — the risk ERC-20 portfolio tools can't see. Only B20 tokens are analyzed. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---- 6b. B20 Policy Watch — did this token BECOME seizable/freezable? ----

import { cdpSql } from "./covalent";
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

  // Is it a B20 at all? (supplyCap exists on every B20, reverts on ERC-20.)
  const cap = await withRetry<bigint | null>(
    () => client.readContract({ address: addr, abi: B20_ABI, functionName: "supplyCap" }) as Promise<bigint | null>,
    null,
  );
  if (cap === null) return notB20(address);

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
  const verdict = seizableNow ? "seizable" : events.length > 0 ? "watch" : "clean";

  return {
    address,
    isB20: true,
    seizableNow,
    seizableSince, // null when we can't pin the moment (history window/API gap)
    transferGatedNow: senderPol > 0n || recvPol > 0n,
    changeCount: events.length,
    events, // chronological policy/pause timeline
    historyAvailable: rows !== null,
    verdict, // seizable | watch (had changes) | clean
    recommendation: seizableNow
      ? `Sender blocklist policy is ACTIVE${seizableSince ? ` (set ${seizableSince})` : ""} — the issuer can block and burnBlocked-seize holders. Treat as high-control.`
      : events.length > 0
        ? "No active sender policy now, but this token's policies/pauses HAVE changed — the issuer uses these controls; re-check before large positions."
        : "No policy or pause changes on record and no active sender policy — no freeze/seize surface detected.",
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
