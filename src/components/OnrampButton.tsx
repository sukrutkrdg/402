"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

/**
 * "Buy USDC on Base" — mints a Coinbase Onramp session token for the connected
 * wallet and opens Coinbase Onramp so the user can fund it with USDC on Base,
 * then come back and pay. Renders nothing until a wallet is connected.
 */
export default function OnrampButton({ className = "" }: { className?: string }) {
  const { address } = useAccount();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!address) return null;

  async function buy() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/onramp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const j = await r.json();
      if (!r.ok || !j.token) throw new Error(j.error || "Onramp unavailable");
      window.open(
        `https://pay.coinbase.com/buy?sessionToken=${encodeURIComponent(j.token)}&defaultAsset=USDC&defaultNetwork=base&presetFiatAmount=5`,
        "_blank",
        "noopener,noreferrer",
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Onramp unavailable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button onClick={buy} disabled={busy} className={`btn-ghost !py-2 text-xs ${className}`}>
        {busy ? "Opening Coinbase…" : "＋ Buy USDC on Base"}
      </button>
      {err && <span className="text-[11px] text-amber-300">{err}</span>}
      <span className="text-[10px] text-gray-500">
        Coinbase Onramp isn’t available in every country. If it says “not supported”, buy USDC on a
        local exchange (or another on-ramp) and withdraw to <strong className="text-gray-400">Base</strong>.
      </span>
    </div>
  );
}
