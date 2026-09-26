"use client";

/**
 * Swap on Base with your own wallet: connect, preview the route (which DEXes, in
 * what share), the minimum you receive and every fee, then approve (the exact
 * amount, if needed) and sign. Wraps /api/swap/base-quote, which is the same 0x
 * swap agents get from base-swap. Nothing is held by us; the wallet sends it.
 */

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useSendTransaction, useWriteContract, usePublicClient } from "wagmi";
import { erc20Abi } from "viem";
import { BASE_PAGE_TOKENS } from "@/lib/swap-page-tokens";

const TOKENS = BASE_PAGE_TOKENS;
const BASE_ID = 8453;

interface BaseQuote {
  sell: { symbol: string; address: string; amount: string; amountBaseUnits: string };
  buy: { symbol: string; amount: string | null; minAmount: string | null };
  route: { source: string; sharePct: number }[];
  fees: { integratorFeeBps: number; integratorFee: string | null; zeroExFee: string | null; networkFeeEth: string | null };
  needsApproval: { token: string; spender: string } | null;
  insufficientBalance: boolean;
  tokenSafety: { canSell: boolean | null; riskLevel: string } | null;
  transaction: { to: string; data: string; value: string; gas: string | null };
}

const pretty = (s: string) => s.replace(/_/g, " ");

export default function BaseSwapClient() {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: BASE_ID });

  const [sell, setSell] = useState<string>("USDC");
  const [buy, setBuy] = useState<string>("ETH");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<BaseQuote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Picking the token already on the other side swaps the two, so sell ≠ buy always.
  const pickSell = (v: string) => {
    if (v === buy) setBuy(sell);
    setSell(v);
    setQuote(null);
  };
  const pickBuy = (v: string) => {
    if (v === sell) setSell(buy);
    setBuy(v);
    setQuote(null);
  };
  const flip = () => {
    setSell(buy);
    setBuy(sell);
    setQuote(null);
  };

  // A quote is built for one wallet (its balance, allowance and the tx sender); a different wallet needs a new one.
  useEffect(() => {
    setQuote(null);
    setDone(null);
  }, [address, chainId]);

  const web = connectors.filter((c) => !/farcaster/i.test(c.id + c.name));
  const input = "w-full rounded-xl border border-base-line bg-black/50 px-3 py-2 text-sm outline-none focus:border-sky-400";

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      const m = (e as { shortMessage?: string; message?: string }).shortMessage || (e as Error).message;
      setError(m);
    } finally {
      setBusy(null);
    }
  }

  const getQuote = () =>
    run("Getting the best route…", async () => {
      setDone(null);
      const qs = new URLSearchParams({ sell, buy, amount, taker: address! });
      const r = await fetch(`/api/swap/base-quote?${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      setQuote(j as BaseQuote);
    });

  const ensureBase = async () => {
    if (chainId !== BASE_ID) await switchChainAsync({ chainId: BASE_ID });
  };

  const approve = () =>
    run("Approve in your wallet…", async () => {
      if (!quote?.needsApproval) return;
      await ensureBase();
      const hash = await writeContractAsync({
        address: quote.needsApproval.token as `0x${string}`,
        abi: erc20Abi,
        functionName: "approve",
        args: [quote.needsApproval.spender as `0x${string}`, BigInt(quote.sell.amountBaseUnits)],
        chainId: BASE_ID,
      });
      setBusy("Waiting for the approval to confirm…");
      await client?.waitForTransactionReceipt({ hash });
      // Quotes are short-lived; take a fresh one now that the allowance is set.
      const qs = new URLSearchParams({ sell, buy, amount, taker: address! });
      const r = await fetch(`/api/swap/base-quote?${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      setQuote(j as BaseQuote);
    });

  const swap = () =>
    run("Confirm the swap in your wallet…", async () => {
      if (!quote) return;
      await ensureBase();
      const hash = await sendTransactionAsync({
        to: quote.transaction.to as `0x${string}`,
        data: quote.transaction.data as `0x${string}`,
        value: BigInt(quote.transaction.value || "0"),
        ...(quote.transaction.gas ? { gas: BigInt(quote.transaction.gas) } : {}),
        chainId: BASE_ID,
      });
      setBusy("Waiting for confirmation…");
      const rc = await client?.waitForTransactionReceipt({ hash });
      if (rc && rc.status !== "success") throw new Error("The swap reverted (price moved beyond slippage). Nothing but gas was spent — get a new quote.");
      setDone(hash);
      setQuote(null);
    });

  if (!isConnected) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-sky-500/30 bg-sky-500/5 p-5">
        <div className="text-sm text-gray-300">Connect a wallet on Base to swap at the best price across Base DEXes.</div>
        <div className="flex flex-wrap gap-2">
          {web.map((c) => (
            <button
              key={c.uid}
              type="button"
              onClick={() => run("Connecting…", () => connectAsync({ connector: c, chainId: BASE_ID }))}
              className="rounded-xl border border-base-line px-4 py-2 text-sm hover:border-sky-400"
            >
              {c.id === "injected" ? "Browser wallet (MetaMask, Rabby…)" : c.name}
            </button>
          ))}
        </div>
        {busy && <div className="text-xs text-gray-400">{busy}</div>}
        {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</div>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-sky-500/30 bg-sky-500/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
        <span>
          Wallet <code className="text-sky-200">{address?.slice(0, 6)}…{address?.slice(-4)}</code>
          {chainId !== BASE_ID && <span className="text-amber-300"> · will switch to Base</span>}
        </span>
        <button type="button" onClick={() => disconnect()} className="hover:text-white">
          Disconnect
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          You sell
          <select className={input} value={sell} onChange={(e) => pickSell(e.target.value)}>
            {TOKENS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Amount
          <input className={input} inputMode="decimal" placeholder="10" value={amount} onChange={(e) => (setAmount(e.target.value), setQuote(null))} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          You buy
          <select className={input} value={buy} onChange={(e) => pickBuy(e.target.value)}>
            {TOKENS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={flip} title="Swap direction" className="rounded-xl border border-base-line px-3 py-2 text-sm hover:border-sky-400">
          ⇅ {buy} → {sell}
        </button>
        <button
          type="button"
          disabled={!!busy || !amount || sell === buy}
          onClick={getQuote}
          className="rounded-xl border border-sky-500/50 px-5 py-2 text-sm font-semibold hover:bg-sky-500/10 disabled:opacity-50"
        >
          Preview route
        </button>
      </div>

      {quote && (
        <div className="flex flex-col gap-3 rounded-xl border border-base-line bg-black/40 p-4 text-sm">
          <div>
            {quote.sell.amount} {quote.sell.symbol} →{" "}
            <strong className="text-emerald-300">
              {Number(quote.buy.amount).toPrecision(6)} {quote.buy.symbol}
            </strong>{" "}
            <span className="text-xs text-gray-500">(at least {Number(quote.buy.minAmount).toPrecision(6)})</span>
          </div>
          <div>
            <div className="label mb-1">Route</div>
            <div className="flex flex-col gap-1">
              {quote.route.map((r) => (
                <div key={r.source} className="flex items-center gap-2 text-xs">
                  <div className="h-2 rounded bg-sky-400/70" style={{ width: `${Math.max(4, r.sharePct)}%` }} />
                  <span className="text-gray-300">{pretty(r.source)}</span>
                  <span className="font-mono text-gray-500">{r.sharePct}%</span>
                </div>
              ))}
            </div>
            <div className="mt-1 text-[11px] text-gray-500">Found by 0x across Base DEXes for the best price at this size.</div>
          </div>
          <div className="text-xs text-gray-400">
            Fees: service {quote.fees.integratorFeeBps / 100}%{quote.fees.integratorFee ? ` (${quote.fees.integratorFee})` : ""}
            {quote.fees.zeroExFee ? ` · 0x ${quote.fees.zeroExFee}` : ""}
            {quote.fees.networkFeeEth ? ` · network ≈ ${Number(quote.fees.networkFeeEth).toPrecision(2)} ETH` : ""}
          </div>
          {quote.tokenSafety && quote.tokenSafety.riskLevel !== "low" && (
            <div className="text-xs text-amber-200">Token check: risk {quote.tokenSafety.riskLevel}</div>
          )}
          {quote.insufficientBalance ? (
            <div className="text-xs text-rose-200">Your wallet does not hold enough {quote.sell.symbol} for this amount.</div>
          ) : quote.needsApproval ? (
            <button type="button" disabled={!!busy} onClick={approve} className="w-fit rounded-xl bg-sky-500 px-5 py-2 text-sm font-semibold text-black disabled:opacity-50">
              1. Approve {quote.sell.amount} {quote.sell.symbol}
            </button>
          ) : (
            <button type="button" disabled={!!busy} onClick={swap} className="w-fit rounded-xl bg-emerald-500 px-5 py-2 text-sm font-semibold text-black disabled:opacity-50">
              Swap
            </button>
          )}
        </div>
      )}

      {busy && <div className="text-xs text-gray-400">{busy}</div>}
      {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</div>}
      {done && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
          Swapped.{" "}
          <a className="underline" href={`https://basescan.org/tx/${done}`} target="_blank" rel="noreferrer">
            View on BaseScan ↗
          </a>
        </div>
      )}
    </div>
  );
}
