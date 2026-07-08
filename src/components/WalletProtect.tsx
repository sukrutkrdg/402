"use client";

import { useState } from "react";
import { useAccount, useSendTransaction } from "wagmi";
import { useX402Pay, PICK_WALLET } from "@/lib/x402-wallet";
import type { Connector } from "wagmi";
import OnrampButton from "./OnrampButton";

interface RevokeItem {
  token: string | null;
  tokenAddress: string | null;
  spender: string | null;
  spenderLabel: string | null;
  unlimited: boolean;
  usdAtRisk: number;
  priority: "high" | "medium" | "low";
}

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

/**
 * "Protect your wallet" — scans a wallet's token approvals (via the paid
 * approval-advisor service) and lets the user revoke risky ones one tap at a
 * time. Revoke is a real approve(spender, 0) transaction from the connected
 * wallet (needs a little ETH for gas on Base); the scan is the x402 micro-payment.
 */
export default function WalletProtect() {
  const { address, isConnected } = useAccount();
  const { pay, picker, setPicker, step } = useX402Pay();
  const { sendTransactionAsync } = useSendTransaction();

  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [queue, setQueue] = useState<RevokeItem[] | null>(null);
  const [summary, setSummary] = useState<{ totalUsdAtRisk: number; highPriorityCount: number; recommendation: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const target = (addr.trim() || address || "").trim();
  const valid = /^0x[0-9a-fA-F]{40}$/.test(target);

  async function scan(chosen?: Connector) {
    if (!valid) {
      setErr("Enter a wallet address, or connect your wallet.");
      return;
    }
    setBusy(true);
    setErr(null);
    setQueue(null);
    setSummary(null);
    try {
      const r = await pay(`/api/x402/approval-advisor?address=${target}`, chosen);
      if (r === PICK_WALLET) {
        setBusy(false);
        return;
      }
      const text = await r.text();
      const j = JSON.parse(text);
      if (!r.ok) {
        const m = (j.error as string) || `Scan failed (${r.status})`;
        throw new Error(/insufficient|balance|settle|402/i.test(m) ? `${m} — you may be out of USDC on Base.` : m);
      }
      const d = j.data ?? {};
      setQueue((d.revokeQueue ?? []) as RevokeItem[]);
      setSummary({
        totalUsdAtRisk: d.totalUsdAtRisk ?? 0,
        highPriorityCount: d.highPriorityCount ?? 0,
        recommendation: d.recommendation ?? "",
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item: RevokeItem) {
    if (!item.tokenAddress || !item.spender) return;
    if (!isConnected) {
      setErr("Connect your wallet to revoke (revoking is a transaction from your wallet).");
      return;
    }
    const id = `${item.tokenAddress}-${item.spender}`;
    setRevoking(id);
    setErr(null);
    try {
      // approve(spender, 0) — sets the allowance to zero, killing the approval.
      const data = ("0x095ea7b3" +
        item.spender.slice(2).toLowerCase().padStart(64, "0") +
        "0".repeat(64)) as `0x${string}`;
      await sendTransactionAsync({ to: item.tokenAddress as `0x${string}`, data });
      setDone((s) => new Set(s).add(id));
    } catch (e) {
      setErr(e instanceof Error ? e.message.slice(0, 160) : "Revoke failed");
    } finally {
      setRevoking(null);
    }
  }

  const prCls = (p: string) =>
    p === "high" ? "text-red-300" : p === "medium" ? "text-amber-300" : "text-gray-400";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] leading-relaxed text-gray-400">
        Token approvals are the #1 way wallets get drained. Scan yours, then revoke anything risky —
        one tap each. Scan costs a few cents (x402); revoking is a normal transaction from your
        wallet (needs a little ETH for gas on Base).
      </p>

      <input
        className="rounded-xl border border-base-line bg-black/40 px-4 py-2.5 text-sm outline-none focus:border-base-blue"
        placeholder={address ? `${short(address)} (connected) — or paste another 0x…` : "0x… wallet address"}
        value={addr}
        onChange={(e) => setAddr(e.target.value)}
      />

      <button
        onClick={() => scan()}
        disabled={busy || !valid}
        className="btn-primary !py-2 text-sm disabled:opacity-40"
      >
        {busy ? (step ?? "Scanning…") : "🛡️ Scan approvals · $0.05"}
      </button>

      {picker && (
        <div className="card flex flex-col gap-2 border-base-blue/30 bg-base-blue/10 p-3">
          <span className="text-[11px] text-sky-200">Choose a wallet to pay with:</span>
          <div className="flex flex-wrap gap-2">
            {picker.map((c) => (
              <button key={c.uid} onClick={() => scan(c)} className="btn-ghost !px-3 !py-1.5 text-xs">
                {c.name}
              </button>
            ))}
            <button onClick={() => setPicker(null)} className="btn-ghost !px-3 !py-1.5 text-xs opacity-60">
              Cancel
            </button>
          </div>
        </div>
      )}

      {err && (
        <div className="flex flex-col gap-2">
          <div className="card border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{err}</div>
          {/insufficient|balance|settle|402/i.test(err) && <OnrampButton />}
        </div>
      )}

      {summary && (
        <div className="card p-3 text-xs">
          <div className="font-semibold">
            {queue?.length ?? 0} approval{(queue?.length ?? 0) === 1 ? "" : "s"} ·{" "}
            <span className="text-emerald-300">${summary.totalUsdAtRisk}</span> at risk ·{" "}
            <span className="text-red-300">{summary.highPriorityCount} high-priority</span>
          </div>
          <p className="mt-1 text-gray-400">{summary.recommendation}</p>
        </div>
      )}

      {queue && queue.length > 0 && (
        <div className="card divide-y divide-base-line/60">
          {queue.map((it) => {
            const id = `${it.tokenAddress}-${it.spender}`;
            const isDone = done.has(id);
            return (
              <div key={id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-semibold ${prCls(it.priority)}`}>{it.priority.toUpperCase()}</span>
                    <span className="truncate font-medium">{it.token ?? short(it.tokenAddress)}</span>
                    {it.unlimited && <span className="pill !px-1.5 !py-0 !text-[9px] text-amber-300">∞</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-gray-500">
                    → {it.spenderLabel ?? short(it.spender)} · ${it.usdAtRisk} at risk
                  </div>
                </div>
                {isDone ? (
                  <span className="shrink-0 text-emerald-300">✓ revoked</span>
                ) : (
                  <button
                    onClick={() => revoke(it)}
                    disabled={revoking === id}
                    className="btn-ghost shrink-0 !px-3 !py-1 text-[11px]"
                  >
                    {revoking === id ? "…" : "Revoke"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {queue && queue.length === 0 && (
        <div className="card p-3 text-xs text-emerald-300">✓ No risky approvals found — your wallet looks clean.</div>
      )}
    </div>
  );
}
