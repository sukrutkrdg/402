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
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";
import OnrampButton from "@/components/OnrampButton";

type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

// Consumer-friendly "paste a token → get an answer" checks for the mini-app.
const CHECKS = [
  { id: "ai-token-report", label: "🛡️ AI Token Safety", price: "$0.08" },
  { id: "sellability", label: "🔒 Can I sell? (honeypot)", price: "$0.05" },
  { id: "deep-dd", label: "🏛️ Deep Due-Diligence", price: "$0.50" },
  { id: "position-health", label: "🩺 Position Health (I'm in it)", price: "$0.04" },
  { id: "deployer-rep", label: "🕵️ Deployer Reputation", price: "$0.04" },
  { id: "holder-forensics", label: "🧬 Holder Forensics", price: "$0.03" },
  { id: "exit-liquidity", label: "🚪 Exit Liquidity", price: "$0.02" },
  { id: "token-unlock", label: "📆 LP Unlock Calendar", price: "$0.02" },
  { id: "contract-danger", label: "⚠️ Contract Danger", price: "$0.04" },
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
    case "contract-danger":
      return `Danger: ${s(d.dangerLevel).toUpperCase()}\n${(Array.isArray(d.dangerCategories) ? d.dangerCategories : []).join(", ") || "no dangerous owner functions"}\n\n➡️ ${s(d.recommendation)}`;
    case "token-risk":
      return `Risk: ${s(d.level).toUpperCase()} (${s(d.score)}/100)\n${(Array.isArray(d.flags) ? d.flags : []).join(", ") || "no flags"}`;
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
      if (r.status === 402) {
        setErr("Free daily check used — pick a check below and pay in-app for a full report.");
        return;
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Check failed");
      const d = j.data;
      setOut(`Rug score: ${d.rugScore}/100 (${d.level})\n${(d.signals || []).join("\n")}`);
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
      setErr(`${e instanceof Error ? e.message : "Failed"}${step ? ` (at: ${step})` : ""}`);
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
        <button onClick={() => paidReport()} disabled={!valid || busy !== null} className="btn-primary flex-1 !py-2 text-sm disabled:opacity-40">
          {busy === "paid" ? "Paying…" : `Run · ${check.price}`}
        </button>
      </div>

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
                onClick={() => paidReport(c)}
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
      {out && <pre className="card whitespace-pre-wrap p-3 text-xs leading-relaxed text-gray-200">{out}</pre>}

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
                text: "Check any Base token before you ape in 🛡️ honeypot, sellability, holder & liquidity checks — pay-per-call over x402.",
                embeds: ["https://402.com.tr/app"],
              })
              .catch(() => {})
          }
          className="btn-ghost flex-1 !py-2 text-xs"
        >
          ↗ Share
        </button>
      </div>

      <a href="/" className="text-center text-xs text-sky-400 hover:underline">
        Browse all 59 services →
      </a>
    </main>
  );
}
