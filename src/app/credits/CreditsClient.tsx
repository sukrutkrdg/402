"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Connector } from "wagmi";
import { useX402Pay, PICK_WALLET } from "@/lib/x402-wallet";
import OnrampButton from "@/components/OnrampButton";

interface Tier {
  tier: string;
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
}

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ERC20_BALANCE = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export default function CreditsClient({ tiers }: { tiers: Tier[] }) {
  const { address, isConnected } = useAccount();
  const { pay, picker, setPicker, step } = useX402Pay();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: balance } = useReadContract({
    address: USDC,
    abi: ERC20_BALANCE,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });
  const usdc = balance !== undefined ? Number(balance) / 1e6 : null;

  async function buy(tier: string, connector?: Connector) {
    setBusy(tier);
    setError(null);
    try {
      const r = await pay(`/api/x402/buy-credits?tier=${encodeURIComponent(tier)}`, connector);
      if (r === PICK_WALLET) return; // picker is showing; the user will choose
      const text = await r.text();
      if (!r.ok) {
        let msg = text.slice(0, 200) || `server ${r.status}`;
        try {
          msg = (JSON.parse(text).error as string) || msg;
        } catch {
          /* keep raw */
        }
        throw new Error(
          r.status === 402
            ? `Payment didn't settle: ${msg}`
            : `Purchase failed (${r.status}): ${msg} — you were NOT charged.`,
        );
      }
      const parsed = JSON.parse(text) as { data?: Minted } & Minted;
      // Paid responses are wrapped by the gateway; unwrap when present.
      setMinted(parsed.data?.creditToken ? parsed.data : parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(null);
    }
  }

  if (minted) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-5">
        <div>
          <h2 className="text-lg font-semibold text-emerald-300">${minted.balanceUsd.toFixed(2)} credit is live</h2>
          <p className="mt-1 text-sm text-gray-400">
            Paid ${minted.paidUsd.toFixed(2)}
            {minted.bonusUsd > 0 && <span className="text-emerald-400"> · bonus ${minted.bonusUsd.toFixed(2)}</span>} ·
            expires in {minted.expiresInDays} days
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
          <span className="text-xs uppercase tracking-wide text-gray-500">
            From here your agent needs no wallet
          </span>
          <pre className="overflow-auto rounded-xl border border-base-line bg-black/50 p-4 text-[12px] leading-relaxed text-sky-200">
{`curl -H "x-credit-token: ${minted.creditToken}" \\
  "https://402.com.tr/api/x402/token-risk?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# MCP clients: set this once and every tool just works
X402_CREDIT_TOKEN=${minted.creditToken} npx x402-bazaar-mcp`}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="rounded-xl border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300">{error}</p>}

      {/* Step 1 — fund. Shown first because "I have no USDC" is the real blocker
          for anyone who isn't already onchain. */}
      <div className="flex flex-col gap-3 rounded-2xl border border-base-line bg-black/30 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">1 · Fund a wallet with USDC on Base</h2>
          {isConnected && (
            <span className="text-xs text-gray-400">
              balance:{" "}
              <strong className={usdc !== null && usdc > 0 ? "text-emerald-300" : "text-gray-300"}>
                {usdc === null ? "…" : `$${usdc.toFixed(2)}`}
              </strong>
            </span>
          )}
        </div>
        {isConnected ? (
          <>
            <p className="text-xs text-gray-500">
              No USDC yet? Buy it with a card or Apple Pay through Coinbase — it lands directly in your wallet
              on Base, usually within a minute.
            </p>
            <OnrampButton className="w-fit" />
          </>
        ) : (
          <p className="text-xs text-gray-500">
            Pick a pack below and you&apos;ll be asked to connect a wallet first. A Coinbase Smart Wallet takes
            about half a minute to create with a passkey — no seed phrase, no extension. Once connected, you can
            buy USDC here with a card.
          </p>
        )}
      </div>

      {picker && (
        <div className="flex flex-col gap-2 rounded-xl border border-base-blue/30 bg-base-blue/10 p-3">
          <span className="text-[11px] text-sky-200">Choose a wallet:</span>
          <div className="flex flex-wrap gap-2">
            {picker.map((c) => (
              <button
                key={c.uid}
                onClick={() => buy(busy ?? tiers[0].tier, c)}
                className="btn-ghost !px-3 !py-1.5 text-xs"
              >
                {c.name}
              </button>
            ))}
            <button onClick={() => setPicker(null)} className="btn-ghost !px-3 !py-1.5 text-xs opacity-60">
              Cancel
            </button>
          </div>
        </div>
      )}

      {busy && step && (
        <div className="rounded-xl border border-base-blue/30 bg-base-blue/10 px-3 py-2 text-xs text-sky-200">{step}</div>
      )}

      {/* Step 2 — buy. One x402 settlement, then the wallet is out of the picture. */}
      <div className="flex flex-col gap-3 rounded-2xl border border-base-line bg-black/30 p-5">
        <h2 className="text-sm font-semibold">2 · Buy a credit pack</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map((t) => {
            const bonus = t.credits - t.usd * 100;
            const short = usdc !== null && usdc < t.usd;
            return (
              <button
                key={t.tier}
                type="button"
                disabled={busy !== null}
                onClick={() => buy(t.tier)}
                className="flex flex-col gap-1 rounded-2xl border border-base-line bg-black/40 p-4 text-left transition hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="text-2xl font-bold">${t.usd.toFixed(2)}</span>
                <span className="text-sm text-gray-400">
                  ${(t.credits / 100).toFixed(2)} of credit
                  {bonus > 0 && <span className="text-emerald-400"> · +${(bonus / 100).toFixed(2)}</span>}
                </span>
                <span className="mt-2 text-xs text-gray-500">
                  {busy === t.tier ? "Paying…" : short ? "Top up first" : "Pay with USDC →"}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-gray-500">
          One signature, one on-chain settlement. After that the token is all your agent needs — no wallet, no
          signature per call, no API key.
        </p>
      </div>
    </div>
  );
}
