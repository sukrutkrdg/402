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
const approveZeroData = (spender: string) =>
  ("0x095ea7b3" + spender.slice(2).toLowerCase().padStart(64, "0") + "0".repeat(64)) as `0x${string}`;

export default function WalletProtect() {
  const { address, isConnected, connector } = useAccount();
  const { pay, picker, setPicker, step } = useX402Pay();
  const { sendTransactionAsync } = useSendTransaction();

  /**
   * Gas-free path: EIP-5792 wallet_sendCalls with our paymaster proxy as the
   * paymasterService capability. Smart wallets (Base App / Coinbase Smart
   * Wallet) sponsor the revoke; wallets without support return null and the
   * caller falls back to a normal (user-pays-gas) transaction.
   */
  async function sendCallsGasless(calls: Array<{ to: `0x${string}`; data: `0x${string}` }>): Promise<string | null> {
    try {
      if (!connector || !address) return null;
      const provider = (await connector.getProvider()) as {
        request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
      };
      const res = await provider.request({
        method: "wallet_sendCalls",
        params: [
          {
            version: "1.0",
            chainId: "0x2105",
            from: address,
            calls,
            capabilities: { paymasterService: { url: `${window.location.origin}/api/paymaster` } },
          },
        ],
      });
      return typeof res === "string" ? res : ((res as { id?: string })?.id ?? "submitted");
    } catch {
      return null;
    }
  }

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
      const data = approveZeroData(item.spender);
      // Gas-free first (smart wallets via paymaster); fall back to a normal tx.
      const gasless = await sendCallsGasless([{ to: item.tokenAddress as `0x${string}`, data }]);
      if (!gasless) await sendTransactionAsync({ to: item.tokenAddress as `0x${string}`, data });
      setDone((s) => new Set(s).add(id));
    } catch (e) {
      setErr(e instanceof Error ? e.message.slice(0, 160) : "Revoke failed");
    } finally {
      setRevoking(null);
    }
  }

  /** One-signature, gas-free batch revoke (smart wallets only). */
  async function revokeAll() {
    if (!isConnected || !queue) return;
    const pending = queue.filter((it) => it.tokenAddress && it.spender && !done.has(`${it.tokenAddress}-${it.spender}`));
    if (pending.length === 0) return;
    setRevoking("all");
    setErr(null);
    try {
      const calls = pending.map((it) => ({ to: it.tokenAddress as `0x${string}`, data: approveZeroData(it.spender!) }));
      const gasless = await sendCallsGasless(calls);
      if (gasless) {
        setDone((s) => {
          const n = new Set(s);
          for (const it of pending) n.add(`${it.tokenAddress}-${it.spender}`);
          return n;
        });
      } else {
        setErr("One-tap batch revoke needs a smart wallet (Base App). Revoke items individually instead.");
      }
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
        one tap each. Scan costs a few cents (x402). Revoking is{" "}
        <strong className="text-emerald-300">gas-free on smart wallets</strong> (Base App — we
        sponsor it); other wallets pay normal gas.
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

      {queue && queue.filter((it) => !done.has(`${it.tokenAddress}-${it.spender}`)).length > 1 && isConnected && (
        <button
          onClick={revokeAll}
          disabled={revoking !== null}
          className="btn-primary !py-2 text-sm disabled:opacity-40"
        >
          {revoking === "all" ? "Revoking all…" : "⚡ Revoke all · one signature · gas-free"}
        </button>
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
