"use client";

import { useEffect, useState } from "react";

interface Pack {
  pack: string;
  usd: number;
  credits: number;
}

interface Minted {
  creditToken: string;
  balanceUsd: number;
  paidUsd: number;
  creditedUsd: number;
  bonusUsd: number;
  expiresInDays: number;
  replay?: boolean;
}

export default function CreditsClient({ packs, enabled }: { packs: Pack[]; enabled: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [copied, setCopied] = useState(false);

  // Coming back from checkout: claim the token for this checkout, once.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("checkout_id");
    if (!id) return;
    setClaiming(true);
    fetch(`/api/credits/claim?checkout_id=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not retrieve your credit token");
        setMinted(j as Minted);
        // Drop the checkout id from the URL so a shared link can't be used to
        // fetch the token from someone else's browser history.
        window.history.replaceState({}, "", "/credits");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setClaiming(false));
  }, []);

  async function buy(pack: string) {
    setBusy(pack);
    setError(null);
    try {
      const r = await fetch("/api/credits/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pack }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Checkout failed");
      window.location.href = j.checkoutUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
      setBusy(null);
    }
  }

  if (claiming) {
    return <p className="text-sm text-gray-400">Confirming your payment…</p>;
  }

  if (minted) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-5">
        <div>
          <h2 className="text-lg font-semibold text-emerald-300">
            ${minted.balanceUsd.toFixed(2)} credit is live
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            Paid ${minted.paidUsd.toFixed(2)}
            {minted.bonusUsd > 0 && <> · bonus ${minted.bonusUsd.toFixed(2)}</>} · expires in{" "}
            {minted.expiresInDays} days
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wide text-gray-500">
            Your credit token — shown once, save it now
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 overflow-auto rounded-xl border border-base-line bg-black/60 p-3 text-[13px] text-emerald-200">
              {minted.creditToken}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(minted.creditToken);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-xl border border-base-line px-4 py-2 text-sm hover:border-emerald-400"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-gray-500">
            This is a bearer key: anyone holding it can spend the balance. It cannot be recovered if lost.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wide text-gray-500">Spend it</span>
          <pre className="overflow-auto rounded-xl border border-base-line bg-black/50 p-4 text-[12px] leading-relaxed text-sky-200">
{`curl -H "x-credit-token: ${minted.creditToken}" \\
  "https://402.com.tr/api/x402/token-risk?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# MCP clients: set X402_CREDIT_TOKEN and every tool just works
X402_CREDIT_TOKEN=${minted.creditToken} npx x402-bazaar-mcp`}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="rounded-xl border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300">{error}</p>
      )}
      {!enabled && (
        <p className="rounded-xl border border-base-line bg-black/40 p-3 text-sm text-gray-400">
          Card checkout isn&apos;t enabled on this deployment yet. You can still buy credits with USDC over
          x402 at <code className="text-sky-300">/api/x402/buy-credits</code>.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {packs.map((t) => {
          const bonus = t.credits - t.usd * 100;
          return (
            <button
              key={t.pack}
              type="button"
              disabled={!enabled || busy !== null}
              onClick={() => buy(t.pack)}
              className="flex flex-col gap-1 rounded-2xl border border-base-line bg-black/40 p-4 text-left transition hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="text-2xl font-bold">${t.usd.toFixed(2)}</span>
              <span className="text-sm text-gray-400">
                ${(t.credits / 100).toFixed(2)} of credit
                {bonus > 0 && <span className="text-emerald-400"> · +${(bonus / 100).toFixed(2)} bonus</span>}
              </span>
              <span className="mt-2 text-xs text-gray-500">
                {busy === t.pack ? "Opening checkout…" : "Pay by card →"}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-gray-500">
        Card packs credit 1:1 and start at $5 — card fees make smaller amounts uneconomic. Paying with USDC
        over x402 costs us almost nothing, so that rail goes down to $0.25 and pays a bonus:{" "}
        <code className="text-sky-300">/api/x402/buy-credits?tier=0.25|1|5|20</code>.
      </p>
    </div>
  );
}
