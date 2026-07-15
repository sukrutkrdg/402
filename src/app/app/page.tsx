"use client";

/**
 * Base App mini-app: a mobile Base token-safety suite.
 *  - Free instant rug-score check (free tier, no wallet needed).
 *  - Several paid checks (AI verdict, sellability, deep DD, holder forensics,
 *    exit liquidity, contract danger) paid in-app over x402 using the user's
 *    Base wallet (gasless EIP-3009 signature) — a real transacting Base App user.
 */

import { useEffect, useState } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import { useAccount, useConnect, type Connector } from "wagmi";
import { createPublicClient, http, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";
import OnrampButton from "@/components/OnrampButton";
import WalletProtect from "@/components/WalletProtect";

// On-chain pay rail (opt-in): a REAL USDC transfer broadcast from the user's own
// wallet, so it registers as a Base App transacting user (climbs App Rankings).
// The gasless x402 flow below is unchanged and stays the default.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = (process.env.NEXT_PUBLIC_PAY_TO_ADDRESS || "0x973a31858f4d2125f48c880542da11a2796f12d6") as `0x${string}`;
const ERC20_TRANSFER_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const priceToCents = (price: string) => Math.round((parseFloat(price.replace(/[^0-9.]/g, "")) || 0) * 100);

type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

// Consumer-friendly "paste a token → get an answer" checks for the mini-app.
const CHECKS = [
  { id: "pre-trade-gate", label: "🚦 Pre-Trade Gate · GO/HOLD/STOP", price: "$0.10" },
  { id: "ai-token-report", label: "🛡️ AI Token Safety", price: "$0.12" },
  { id: "b20-safety", label: "🆕 B20 Safety · freeze/seize", price: "$0.04" },
  { id: "b20-gate", label: "🚦 B20 Pre-Trade Gate", price: "$0.05" },
  { id: "b20-policy-watch", label: "👁️ B20: when did it turn seizable?", price: "$0.03" },
  { id: "sellability", label: "🔒 Can I sell? (honeypot)", price: "$0.08" },
  { id: "deep-dd", label: "🏛️ Deep Due-Diligence", price: "$0.75" },
  { id: "position-health", label: "🩺 Position Health (I'm in it)", price: "$0.04" },
  { id: "whale-flow", label: "🐋 Whale Flow · selling now?", price: "$0.04" },
  { id: "deployer-rep", label: "🕵️ Deployer Reputation", price: "$0.04" },
  { id: "holder-forensics", label: "🧬 Holder Forensics", price: "$0.03" },
  { id: "volume-check", label: "📊 Volume Authenticity (wash?)", price: "$0.03" },
  { id: "exit-liquidity", label: "🚪 Exit Liquidity", price: "$0.02" },
  { id: "lp-lock", label: "🔐 LP Lock Details", price: "$0.02" },
  { id: "token-unlock", label: "📆 LP Unlock Calendar", price: "$0.02" },
  { id: "proxy-check", label: "🧩 Proxy / Upgrade Risk", price: "$0.02" },
  { id: "contract-danger", label: "⚠️ Contract Danger", price: "$0.04" },
  { id: "token-momentum", label: "📈 Momentum (price/volume)", price: "$0.02" },
  { id: "token-risk", label: "🔎 Token Risk", price: "$0.03" },
] as const;

type EthProvider = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

// Build the minimal ClientEvmSigner x402 needs from the mini-app wallet provider.
function makeSigner(
  provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
  address: `0x${string}`,
  onSigning?: () => void,
) {
  const domainType = (d: Record<string, unknown>) => {
    const f: Array<{ name: string; type: string }> = [];
    if (d.name !== undefined) f.push({ name: "name", type: "string" });
    if (d.version !== undefined) f.push({ name: "version", type: "string" });
    if (d.chainId !== undefined) f.push({ name: "chainId", type: "uint256" });
    if (d.verifyingContract !== undefined) f.push({ name: "verifyingContract", type: "address" });
    if (d.salt !== undefined) f.push({ name: "salt", type: "bytes32" });
    return f;
  };
  return {
    address,
    async signTypedData(msg: TypedData): Promise<`0x${string}`> {
      const typedData = {
        types: { EIP712Domain: domainType(msg.domain), ...msg.types },
        domain: msg.domain,
        primaryType: msg.primaryType,
        message: msg.message,
      };
      const json = JSON.stringify(typedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      onSigning?.();
      return (await provider.request({
        method: "eth_signTypedData_v4",
        params: [address, json],
      })) as `0x${string}`;
    },
  };
}

// A compact, readable summary of any check's result data.
function formatResult(id: string, d: Record<string, unknown>): string {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const factors = Array.isArray(d.factors)
    ? (d.factors as Array<{ name?: string; status?: string }>).map((f) => `• ${f.name}: ${f.status}`).join("\n")
    : "";
  const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]).map((r) => `• ${r}`).join("\n") : "";
  switch (id) {
    case "pre-trade-gate": {
      const rc = (d.receipt ?? {}) as { observedRisks?: string[] };
      const risks = Array.isArray(rc.observedRisks) && rc.observedRisks.length ? rc.observedRisks.map((r) => `• ${r}`).join("\n") : "";
      return `${s(d.decision)}${d.degraded ? " · ⚠️ degraded (a check couldn't run)" : ""}\n${risks || "No blocking flags across risk, sellability, routing & deployer."}\n\n➡️ ${s(d.recommendation)}`;
    }
    case "whale-flow":
      return `${s(d.verdict).toUpperCase().replace(/_/g, " ")} · sell pressure ${s(d.sellPressurePct)}%\nPools: ${s(d.poolsTracked)} · large transfers (${s(d.windowHours)}h): ${s(d.largeTransfers)}\n\n➡️ ${s(d.recommendation)}`;
    case "volume-check":
      return `${s(d.verdict).toUpperCase().replace(/_/g, " ")} · suspicion ${s(d.suspicionScore)}/100\nVol 24h: $${s(d.volume24h)} · Liq: $${s(d.liquidityUsd)} · vol/liq ${s(d.volumeToLiquidity)}×\nBuys/Sells: ${s((d.txns24h as { buys?: number })?.buys)}/${s((d.txns24h as { sells?: number })?.sells)}\n\n➡️ ${s(d.recommendation)}`;
    case "lp-lock":
      return `Rug risk: ${s(d.rugRisk).toUpperCase()}\nLP secured: ${s(d.lpSecuredPercent)}% (locked ${s(d.lpLockedPercent)}% + burned ${s(d.lpBurnedPercent)}%) · pullable ${s(d.lpUnlockedPercent)}%\n\n➡️ ${s(d.recommendation)}`;
    case "proxy-check":
      return `Upgrade risk: ${s(d.upgradeRisk).toUpperCase()}\n${d.isProxy ? `Upgradeable (${s(d.proxyStandard)}) · admin: ${s(d.adminType)}` : "Not an upgradeable proxy"}${(Array.isArray(d.flags) && d.flags.length) ? "\n" + (d.flags as string[]).map((f) => `• ${f}`).join("\n") : ""}\n\n${s(d.note)}`;
    case "token-momentum": {
      const pc = (d.priceChange ?? {}) as { h1?: number | null; h6?: number | null; h24?: number | null };
      return `${s(d.trend).toUpperCase().replace(/_/g, " ")} · ${s(d.symbol)}\nPrice: $${s(d.priceUsd)}\nΔ 1h: ${s(pc.h1)}% · 6h: ${s(pc.h6)}% · 24h: ${s(pc.h24)}%\nLiquidity: $${s(d.liquidityUsd)}`;
    }
    case "ai-token-report":
      return `${s(d.verdict).toUpperCase()} · safety ${s(d.safetyScore)}/100\n\n${s(d.summary)}${factors ? "\n\n" + factors : ""}`;
    case "deep-dd": {
      const tr = d.tradeability as { canBuy?: boolean; canSell?: boolean } | undefined;
      return `${s(d.verdict).toUpperCase()} · safety ${s(d.safetyScore)}/100\nBuy: ${tr?.canBuy} · Sell: ${tr?.canSell}\n\n${s(d.summary)}\n\n➡️ ${s(d.recommendation)}`;
    }
    case "sellability":
      return `${d.canSell ? "✅ SELLABLE" : "🚫 CANNOT SELL"} (${s(d.verdict)})\nSell tax: ${s(d.sellTaxPct)}% · Buy tax: ${s(d.buyTaxPct)}%${reasons ? "\n\n" + reasons : ""}`;
    case "holder-forensics":
      return `Concentration risk: ${s(d.concentrationRisk).toUpperCase()}\nLargest wallet: ${s(d.largestWalletPercent)}% · Creator: ${s(d.creatorPercent)}%\nHolders: ${s(d.holderCount)}\nFlags: ${(Array.isArray(d.flags) ? d.flags : []).join(", ") || "none"}`;
    case "exit-liquidity":
      return `Exit risk: ${s(d.exitRisk).toUpperCase()} · Can exit: ${d.canExit}\nLiquidity: $${s(d.liquidityUsd)}\nSell impact: ${s(d.estSellImpactPct)}% · Max safe exit: $${s(d.maxSafeExitUsd)}`;
    case "position-health": {
      const exit = d.exit as { canExit?: boolean | null; estSellImpactPct?: number | null; maxSafeExitUsd?: number | null } | null;
      const rug = d.rug as { score?: number | null; level?: string | null } | null;
      return `${s(d.verdict).toUpperCase().replace("_", " ")}\nPrice: $${s(d.currentPriceUsd)} · Liquidity: $${s(d.liquidityUsd)}\nExit: ${exit?.canExit ? "✅" : "🚫"} (impact ${s(exit?.estSellImpactPct)}% · max safe $${s(exit?.maxSafeExitUsd)})\nRug score: ${s(rug?.score)}/100 (${s(rug?.level)})${reasons ? "\n\n" + reasons : ""}\n\n➡️ ${s(d.recommendation)}`;
    }
    case "deployer-rep": {
      const sig = Array.isArray(d.signals) ? (d.signals as string[]).map((x) => `• ${x}`).join("\n") : "";
      return `Deployer: ${s(d.reputation).toUpperCase().replace("_", " ")} (${s(d.reputationScore)}/100)\nCreator holds: ${d.creatorHoldingPct ?? "?"}% · Renounced: ${d.ownershipRenounced === true ? "✅" : d.ownershipRenounced === false ? "❌" : "?"}${sig ? "\n\n" + sig : ""}\n\n➡️ ${s(d.recommendation)}`;
    }
    case "token-unlock": {
      const next = d.nextUnlock as { daysUntil?: number; percentOfLp?: number | null; lockerLabel?: string | null } | null;
      return `${d.hasImminentUnlock ? `🚨 ${s(d.imminentUnlockPct)}% of LP unlocks within 30 days` : "No imminent LP unlock"}\nLP secured: ${s(d.lpSecuredPercent)}% · Scheduled unlocks: ${s(d.unlockCount)}${next ? `\nNext: in ${next.daysUntil}d (${next.percentOfLp ?? "?"}%${next.lockerLabel ? ` · ${next.lockerLabel}` : ""})` : ""}\n\n➡️ ${s(d.recommendation)}`;
    }
    case "b20-safety": {
      if (d.isB20 === false) return `Not a B20 token.\n\n${s(d.note)}`;
      const p = (d.powers ?? {}) as { seizable?: boolean; freezable?: boolean; rebase?: boolean };
      return `${s(d.verdict).toUpperCase()} · risk ${s(d.riskScore)}/100 · ${s(d.variant)}\nSeize: ${p.seizable ? "⚠️ yes" : "no"} · Freeze: ${p.freezable ? "⚠️ yes" : "no"} · Rebase: ${p.rebase ? "⚠️ yes" : "no"}\n\n➡️ ${s(d.recommendation)}`;
    }
    case "b20-gate": {
      if (d.isB20 === false) return `Not a B20 token.\n\n${s(d.note)}`;
      const risks = Array.isArray(d.observedRisks) && d.observedRisks.length ? (d.observedRisks as string[]).map((r) => `• ${r}`).join("\n") : "";
      return `${s(d.decision)}${d.degraded ? " · ⚠️ degraded" : ""} · ${s(d.symbol)}\n${risks || "No high-control B20 powers detected."}\n\n➡️ ${s(d.recommendation)}`;
    }
    case "b20-policy-watch": {
      if (d.isB20 === false) return `Not a B20 token.\n\n${s(d.note)}`;
      return `${s(d.verdict).toUpperCase()}${d.seizableNow ? ` · seizable since ${s(d.seizableSince) || "before launch history"}` : ""}\nPolicy/pause changes on record: ${s(d.changeCount)}\n\n➡️ ${s(d.recommendation)}`;
    }
    case "contract-danger":
      return `Danger: ${s(d.dangerLevel).toUpperCase()}\n${(Array.isArray(d.dangerCategories) ? d.dangerCategories : []).join(", ") || "no dangerous owner functions"}\n\n➡️ ${s(d.recommendation)}`;
    case "token-risk": {
      const rc = (d.receipt ?? {}) as { decision?: string; wouldChangeCall?: string };
      return `${rc.decision ? `${rc.decision} · ` : ""}Risk: ${s(d.riskLevel).toUpperCase()} (${s(d.riskScore)}/100)\n${(Array.isArray(d.flags) ? d.flags : []).join(", ") || "no flags"}${rc.wouldChangeCall ? `\n\n↻ ${rc.wouldChangeCall}` : ""}`;
    }
    default:
      return JSON.stringify(d, null, 2).slice(0, 800);
  }
}

export default function MiniApp() {
  const [addr, setAddr] = useState("");
  const [selected, setSelected] = useState<string>(CHECKS[0].id);
  const [busy, setBusy] = useState<"free" | "paid" | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  // When a plain browser has several wallets installed, we can't guess which one
  // to use — show these as a picker and let the user choose.
  const [walletPicker, setWalletPicker] = useState<Connector[] | null>(null);
  // True after a free teaser is shown → offer a one-tap "unlock full report".
  const [previewShown, setPreviewShown] = useState(false);
  // "token" = token-safety checks; "wallet" = approval scan + revoke.
  const [mode, setMode] = useState<"token" | "wallet">("token");
  // Opt-in: pay with a real on-chain USDC transfer (broadcast from the user's
  // wallet) instead of the gasless x402 signature — so it counts as a Base App
  // transacting user. Off by default; the gasless path is unchanged.
  const [gasMode, setGasMode] = useState(false);
  // A confirmed on-chain payment whose report wasn't delivered yet (e.g. an RPC
  // race on redeem). Kept so the user can retry the SAME payment — never re-charged.
  const [lastPaid, setLastPaid] = useState<{ hash: string; service: string; address: string; label: string; price: string } | null>(null);

  // Deep link: /app?mode=wallet opens straight into Protect-wallet mode.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") === "wallet") setMode("wallet");
  }, []);

  const { address, isConnected, connector } = useAccount();
  const { connectAsync, connectors } = useConnect();
  // A wallet is available when the mini-app host exposes the connector.
  const hasWallet = connectors.length > 0;

  useEffect(() => {
    sdk.actions.ready().catch(() => {});
  }, []);

  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
  const check = CHECKS.find((c) => c.id === selected) ?? CHECKS[0];

  async function freeCheck() {
    if (!valid) return;
    setErr(null);
    setOut(null);
    setBusy("free");
    try {
      const r = await fetch(`/api/x402/rug-score?address=${addr.trim()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Check failed");
      const d = j.data as { rugScore?: number; level?: string; signals?: string[]; signalsCount?: number };
      if (j.preview) {
        // Daily free check used → teaser: score + how many signals, details locked.
        setOut(
          `Rug score: ${d.rugScore}/100 (${d.level})\n🔒 ${d.signalsCount ?? 0} risk signal${(d.signalsCount ?? 0) === 1 ? "" : "s"} found — details locked.`,
        );
        setPreviewShown(true);
      } else {
        setOut(`Rug score: ${d.rugScore}/100 (${d.level})\n${(d.signals || []).join("\n")}`);
        setPreviewShown(false);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function paidReport(chosenConnector?: Connector) {
    if (!valid) return;
    setErr(null);
    setOut(null);
    setStep(null);
    setWalletPicker(null);
    setPreviewShown(false);
    setBusy("paid");
    const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timed out: ${label}`)), ms))]);
    try {
      setStep("Connecting wallet…");
      if (connectors.length === 0) throw new Error("No wallet connector available.");
      let inMiniApp = false;
      try {
        inMiniApp = await sdk.isInMiniApp();
      } catch {
        inMiniApp = false;
      }
      const isFc = (c: Connector) => /farcaster/i.test(c.id) || /farcaster/i.test(c.type);

      // Pick the connector for the context:
      //  - explicit choice from the wallet picker wins;
      //  - inside a mini-app → the Farcaster/Base App host wallet;
      //  - plain browser with SEVERAL wallets → show the picker (can't guess
      //    which window.ethereum wallet to use — that's the "wallet must have at
      //    least one account" crash);
      //  - plain browser with one wallet → use it directly.
      let preferred = chosenConnector;
      if (!preferred) {
        if (inMiniApp) {
          preferred = connectors.find(isFc) ?? connectors[0];
        } else {
          const webConnectors = connectors.filter((c) => !isFc(c));
          if (webConnectors.length > 1) {
            setWalletPicker(webConnectors);
            setStep(null);
            setBusy(null);
            return; // re-enters paidReport(connector) once the user picks one
          }
          preferred = webConnectors[0] ?? connectors[0];
        }
      }

      let acct = address as `0x${string}` | undefined;
      let conn = connector;
      if (!isConnected || !acct || conn?.id !== preferred.id) {
        const res = await withTimeout(connectAsync({ connector: preferred }), 60000, "wallet connect");
        acct = res.accounts?.[0];
        conn = preferred;
      }
      if (!acct || !conn) {
        throw new Error(
          inMiniApp
            ? "Wallet didn't respond — close this mini app and reopen it from the cast, then try again."
            : "Couldn't connect a wallet. Approve the connection in your wallet extension and try again.",
        );
      }
      // Get the connected EIP-1193 provider from the connector and reuse the
      // existing x402 signing flow unchanged.
      const provider = (await conn.getProvider()) as EthProvider;

      // Ensure the wallet is on Base (8453) before signing. x402 signs a payment
      // authorization for chainId 8453 and settles on Base; if the wallet (e.g.
      // MetaMask defaulting to Ethereum) is on another chain, the facilitator
      // can't settle and returns an empty 402 ("Payment failed — server 402").
      // Mini-app host wallets are already on Base, so this is a no-op there.
      if (!inMiniApp) {
        setStep("Switching to Base…");
        try {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
        } catch (switchErr) {
          if ((switchErr as { code?: number })?.code === 4902) {
            await provider.request({
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: "0x2105",
                  chainName: "Base",
                  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                  rpcUrls: ["https://mainnet.base.org"],
                  blockExplorerUrls: ["https://basescan.org"],
                },
              ],
            });
          }
          // Other errors: proceed anyway; the wallet may already be on Base.
        }
      }

      const client = new x402Client();
      client.register(
        "eip155:8453",
        new ExactEvmScheme(makeSigner(provider, acct, () => setStep("✍️ Approve the signature in your wallet…"))),
      );
      // Client (`s`) code — use the registered 402.com.tr Builder Code so
      // mini-app payments attribute to this app on the Base dashboard.
      client.registerExtension(new BuilderCodeClientExtension("bc_pa0gqlv1"));
      const pay = wrapFetchWithPayment(fetch, client);

      setStep(`Running ${check.label}…`);
      const r = await withTimeout(pay(`/api/x402/${selected}?address=${addr.trim()}`), 90000, "payment/settlement");
      setStep("Reading report…");
      const text = await r.text();
      if (!r.ok) {
        // Surface the real reason (HTTP status + server body) so failures are diagnosable.
        let msg = text.slice(0, 220) || "no body";
        try {
          msg = (JSON.parse(text).error as string) || msg;
        } catch {
          /* keep raw text */
        }
        // 4xx = the CHECK failed (bad input / token has no data), not the payment.
        // x402 only settles on success, so the wallet was NOT charged.
        throw new Error(
          r.status >= 400 && r.status < 500 && r.status !== 402
            ? `Check failed (${r.status}): ${msg} — you were NOT charged.`
            : `Payment failed — server ${r.status}: ${msg}`,
        );
      }
      let parsed: { data?: Record<string, unknown> };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Unexpected response: ${text.slice(0, 160)}`);
      }
      setOut(formatResult(selected, (parsed.data ?? parsed) as Record<string, unknown>));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      // If the failure looks balance-related, point the user at the Buy-USDC
      // button below (the biggest reason a ready buyer can't pay).
      const needsUsdc = /insufficient|balance|settle|402/i.test(msg);
      setErr(
        `${msg}${needsUsdc ? " — you may be out of USDC on Base. Add some with “Buy USDC on Base” below, then retry." : ""}${step ? ` (at: ${step})` : ""}`,
      );
    } finally {
      setBusy(null);
      setStep(null);
    }
  }

  // Opt-in on-chain payment: broadcast a real USDC transfer(payTo, price) from the
  // user's own wallet, wait for it to confirm, then redeem the report. Because the
  // wallet is the on-chain SENDER, this registers as a Base App transacting user —
  // unlike the gasless path where only the facilitator broadcasts. Fully parallel:
  // it does not touch paidReport / the x402 flow.
  async function payOnchain(chosenConnector?: Connector) {
    if (!valid) return;
    setErr(null);
    setOut(null);
    setStep(null);
    setWalletPicker(null);
    setPreviewShown(false);
    setBusy("paid");
    const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timed out: ${label}`)), ms))]);
    try {
      setStep("Connecting wallet…");
      if (connectors.length === 0) throw new Error("No wallet connector available.");
      let inMiniApp = false;
      try {
        inMiniApp = await sdk.isInMiniApp();
      } catch {
        inMiniApp = false;
      }
      const isFc = (c: Connector) => /farcaster/i.test(c.id) || /farcaster/i.test(c.type);

      // Same connector selection as the gasless path (mini-app host vs web picker).
      let preferred = chosenConnector;
      if (!preferred) {
        if (inMiniApp) {
          preferred = connectors.find(isFc) ?? connectors[0];
        } else {
          const webConnectors = connectors.filter((c) => !isFc(c));
          if (webConnectors.length > 1) {
            setWalletPicker(webConnectors);
            setStep(null);
            setBusy(null);
            return; // re-enters payOnchain(connector) once the user picks one
          }
          preferred = webConnectors[0] ?? connectors[0];
        }
      }

      let acct = address as `0x${string}` | undefined;
      let conn = connector;
      if (!isConnected || !acct || conn?.id !== preferred.id) {
        const res = await withTimeout(connectAsync({ connector: preferred }), 60000, "wallet connect");
        acct = res.accounts?.[0];
        conn = preferred;
      }
      if (!acct || !conn) {
        throw new Error(
          inMiniApp
            ? "Wallet didn't respond — close this mini app and reopen it, then try again."
            : "Couldn't connect a wallet. Approve the connection and try again.",
        );
      }
      const provider = (await conn.getProvider()) as EthProvider;

      // Ensure a plain browser wallet is on Base (mini-app host already is).
      if (!inMiniApp) {
        setStep("Switching to Base…");
        try {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
        } catch (switchErr) {
          if ((switchErr as { code?: number })?.code === 4902) {
            await provider.request({
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: "0x2105",
                  chainName: "Base",
                  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                  rpcUrls: ["https://mainnet.base.org"],
                  blockExplorerUrls: ["https://basescan.org"],
                },
              ],
            });
          }
        }
      }

      // Broadcast the USDC transfer — THIS is the on-chain transaction that makes
      // the wallet a Base App transacting user. Amount = price in 6-dp USDC micro.
      const amount = BigInt(priceToCents(check.price)) * 10_000n;
      const data = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [PAY_TO, amount] });
      setStep("⛽ Confirm the on-chain payment in your wallet…");
      const txHash = (await withTimeout(
        provider.request({ method: "eth_sendTransaction", params: [{ from: acct, to: USDC, data }] }),
        120000,
        "send payment",
      )) as `0x${string}`;

      setStep("Waiting for confirmation…");
      const pub = createPublicClient({ chain: base, transport: http() });
      await withTimeout(pub.waitForTransactionReceipt({ hash: txHash }), 150000, "confirmation");

      // Payment is confirmed — remember it so a redeem hiccup never loses the paid
      // report (the user can retry the same tx, never re-charged).
      const pay = { hash: txHash, service: selected, address: addr.trim(), label: check.label, price: check.price };
      setLastPaid(pay);
      await withTimeout(redeemReport(pay), 90000, "report");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      const needsGas = /insufficient funds|gas|exceeds balance|balance/i.test(msg);
      setErr(
        `${msg}${needsGas ? " — an on-chain payment needs a little ETH on Base for gas (plus USDC for the price). Add funds and retry, or turn off “Pay onchain” to pay gaslessly." : ""}${step ? ` (at: ${step})` : ""}`,
      );
    } finally {
      setBusy(null);
      setStep(null);
    }
  }

  // Redeem a confirmed on-chain payment for its report. Reused by payOnchain and
  // by the "retry" button — same txHash is safe (server serves it once, and only
  // clears the used-key when it genuinely can't deliver).
  async function redeemReport(pay: { hash: string; service: string; address: string; label: string; price: string }) {
    setStep(`Running ${pay.label}…`);
    const r = await fetch(`/api/onchain/${pay.service}?address=${pay.address}&txHash=${pay.hash}`, { method: "POST" });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 220) || "no body";
      try {
        msg = (JSON.parse(text).error as string) || msg;
      } catch {
        /* keep raw text */
      }
      throw new Error(`Payment confirmed but report not delivered (${r.status}): ${msg}`);
    }
    let parsed: { data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response: ${text.slice(0, 160)}`);
    }
    setOut(formatResult(pay.service, (parsed.data ?? parsed) as Record<string, unknown>));
    setLastPaid(null); // delivered — nothing left to retry
  }

  // Retry delivery of an already-confirmed payment (no new charge).
  async function retryRedeem() {
    if (!lastPaid) return;
    setErr(null);
    setOut(null);
    setBusy("paid");
    try {
      await redeemReport(lastPaid);
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : "Failed"} · your txHash: ${lastPaid.hash}`);
    } finally {
      setBusy(null);
      setStep(null);
    }
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <span className="pill w-fit">🛡️ x402 Bazaar</span>
        <h1 className="text-xl font-bold">Base Token Safety Suite</h1>
        <p className="text-xs text-gray-400">
          Paste a Base token — free rug-score, or pick a full check and pay in-app over x402.
        </p>
      </header>

      <div className="flex gap-2">
        <button
          onClick={() => setMode("token")}
          className={`btn-ghost flex-1 !py-2 text-xs ${mode === "token" ? "border-base-blue/50 bg-base-blue/15 text-sky-200" : ""}`}
        >
          🪙 Token safety
        </button>
        <button
          onClick={() => setMode("wallet")}
          className={`btn-ghost flex-1 !py-2 text-xs ${mode === "wallet" ? "border-base-blue/50 bg-base-blue/15 text-sky-200" : ""}`}
        >
          🛡️ Protect wallet
        </button>
      </div>

      {mode === "wallet" ? (
        <WalletProtect />
      ) : (
        <>
          <input
        value={addr}
        onChange={(e) => setAddr(e.target.value)}
        placeholder="0x… token address"
        className="w-full rounded-lg border border-base-line bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-base-blue"
      />

      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="w-full rounded-lg border border-base-line bg-black/40 px-3 py-2 text-sm outline-none focus:border-base-blue"
      >
        {CHECKS.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} · {c.price}
          </option>
        ))}
      </select>

      <div className="flex gap-2">
        <button onClick={freeCheck} disabled={!valid || busy !== null} className="btn-ghost flex-1 !py-2 text-sm disabled:opacity-40">
          {busy === "free" ? "Checking…" : "Free rug-score"}
        </button>
        <button onClick={() => (gasMode ? payOnchain() : paidReport())} disabled={!valid || busy !== null} className="btn-primary flex-1 !py-2 text-sm disabled:opacity-40">
          {busy === "paid" ? "Paying…" : `${gasMode ? "⛽ Pay onchain" : "Run"} · ${check.price}`}
        </button>
      </div>

      <label className="flex items-start gap-2 text-[11px] leading-snug text-gray-400">
        <input
          type="checkbox"
          checked={gasMode}
          onChange={(e) => setGasMode(e.target.checked)}
          className="mt-0.5 accent-base-blue"
        />
        <span>
          ⛽ Pay onchain from my wallet <span className="text-gray-500">(counts on the Base App leaderboard · costs a little ETH for gas)</span>. Off = gasless one-tap, no gas.
        </span>
      </label>

      {!hasWallet && (
        <p className="text-center text-[11px] text-gray-500">Open in the Base App, or use a browser wallet, to pay.</p>
      )}
      {walletPicker && (
        <div className="card space-y-2 border-base-blue/30 bg-base-blue/10 p-3">
          <p className="text-xs text-sky-200">Choose a wallet to pay with:</p>
          <div className="flex flex-wrap gap-2">
            {walletPicker.map((c) => (
              <button
                key={c.uid}
                onClick={() => (gasMode ? payOnchain(c) : paidReport(c))}
                className="btn-ghost !px-3 !py-1.5 text-xs"
              >
                {c.name}
              </button>
            ))}
            <button onClick={() => setWalletPicker(null)} className="btn-ghost !px-3 !py-1.5 text-xs opacity-60">
              Cancel
            </button>
          </div>
        </div>
      )}
      {busy === "paid" && step && (
        <div className="card border-base-blue/30 bg-base-blue/10 p-3 text-xs text-sky-200">{step}</div>
      )}
      {err && <div className="card border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{err}</div>}
      {lastPaid && busy === null && (
        <button onClick={retryRedeem} className="btn-primary !py-2 text-sm">
          🔁 Retry — already paid {lastPaid.price}, no new charge
        </button>
      )}
      {out && <pre className="card whitespace-pre-wrap p-3 text-xs leading-relaxed text-gray-200">{out}</pre>}

      {previewShown && busy === null && (
        <button onClick={() => (gasMode ? payOnchain() : paidReport())} className="btn-primary !py-2 text-sm">
          🔓 Unlock full report · {check.label} · {check.price}
        </button>
      )}

      {/* Fund the connected wallet with USDC on Base when it's short. */}
      <div className="flex justify-center">
        <OnrampButton />
      </div>

      <div className="mt-1 flex gap-2">
        <button
          onClick={() => sdk.actions.addMiniApp().catch(() => {})}
          className="btn-ghost flex-1 !py-2 text-xs"
        >
          ➕ Add to Base App
        </button>
        <button
          onClick={() =>
            sdk.actions
              .composeCast({
                // Share the actual result when there is one → far more viral than a generic pitch.
                text: out
                  ? `Checked ${addr.trim().slice(0, 6)}…${addr.trim().slice(-4)} on 402.com.tr 🛡️\n${out.split("\n").slice(0, 2).join(" · ").slice(0, 140)}`
                  : "Check any Base token before you ape in 🛡️ honeypot, sellability, holder & liquidity checks — pay-per-call over x402.",
                embeds: ["https://402.com.tr/app"],
              })
              .catch(() => {})
          }
          className="btn-ghost flex-1 !py-2 text-xs"
        >
          {out ? "↗ Cast result" : "↗ Share"}
        </button>
      </div>

      <a href="/" className="text-center text-xs text-sky-400 hover:underline">
        Browse all services →
      </a>
        </>
      )}
    </main>
  );
}
