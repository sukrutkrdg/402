/**
 * ON-CHAIN pay rail (opt-in) — the leaderboard-friendly alternative to gasless x402.
 *
 * The default mini-app flow pays gaslessly (EIP-3009 signature settled by the
 * facilitator), so the buyer never broadcasts a transaction — which means the
 * Base App dashboard never counts them as a "transacting user". This route lets a
 * user instead broadcast a REAL USDC transfer from their own Base App wallet and
 * then redeem the report: the wallet is the on-chain sender, so it registers as a
 * Base App transacting user and can climb the App Rankings.
 *
 * Flow: client sends USDC transfer(payTo, price) → gets txHash → POSTs it here.
 * We verify the transfer on-chain (success, to=payTo, value≥price, recent, not
 * already redeemed) and run the SAME service handler. Fully parallel to the x402
 * route — nothing about the gasless path changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, decodeEventLog, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "@/lib/base-transport";
import { getService } from "@/lib/services";
import { getConfig, USDC_BASE } from "@/lib/config";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { logUsage, srcHash } from "@/lib/usage";
import { kvGet, kvSet, kvDel } from "@/lib/kv";
import { saveSample } from "@/lib/sample-cache";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const USDC = USDC_BASE.toLowerCase();

/** Service price string ("$0.03") → integer cents (3). */
function priceCents(price: string): number {
  return Math.round((parseFloat(price.replace(/[^0-9.]/g, "")) || 0) * 100);
}

function paramsFrom(req: NextRequest, service: NonNullable<ReturnType<typeof getService>>): Record<string, string> {
  const url = new URL(req.url);
  const params: Record<string, string> = {};
  for (const p of service.params) {
    const v = url.searchParams.get(p.name);
    if (v) params[p.name] = v.slice(0, 2000);
  }
  return params;
}

/** Same honest error mapping as the x402 route: 400 bad input, 502 upstream, else 500. */
function handlerErrorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "Service error";
  const m = message.toLowerCase();
  const status = /provide|missing|valid|invalid|required|no .*found|no .*data|no .*available|no price/.test(m)
    ? 400
    : /unavailable|failed|responded \d|timeout|fetch/.test(m)
      ? 502
      : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service: serviceId } = await ctx.params;
  const service = getService(serviceId);
  if (!service) return NextResponse.json({ error: `Unknown service: ${serviceId}` }, { status: 404 });
  // buy-credits mints spendable balance — it must only be bought through a real
  // x402 settlement, never this redemption rail.
  if (service.id === "buy-credits") {
    return NextResponse.json({ error: "buy-credits is not available on the on-chain rail — use x402." }, { status: 400 });
  }

  const rl = await rateLimitKv(`onchain:${clientIp(req)}`, 30, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const cfg = getConfig();
  if (!cfg.payTo) return NextResponse.json({ error: "Seller wallet not configured." }, { status: 503 });
  const payTo = cfg.payTo.toLowerCase();

  const url = new URL(req.url);
  const txHash = (url.searchParams.get("txHash") || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    return NextResponse.json({ error: "Provide the on-chain payment txHash (?txHash=0x…)." }, { status: 400 });
  }

  // One report per settlement tx. Reserve the hash up front so a double-submit
  // (or a retry mid-flight) can't redeem the same payment twice; released below
  // only if we never actually serve (verification fails / handler throws).
  const usedKey = `onchain:tx:${txHash}`;
  if (await kvGet(usedKey)) {
    return NextResponse.json({ error: "This payment was already redeemed." }, { status: 409 });
  }
  await kvSet(usedKey, "1", 60 * 60 * 24 * 30);

  try {
    const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

    // Wait (don't just look up once) — the client's RPC may have seen the receipt
    // a beat before ours, so a bare getTransactionReceipt races and 404s a valid
    // payment. waitForTransactionReceipt returns instantly if we already have it,
    // otherwise polls until it appears or the short timeout elapses.
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 25000, pollingInterval: 2000, confirmations: 1 });
    } catch {
      await kvDel(usedKey); // truly not mined yet — let the client retry with the same hash
      return NextResponse.json({ error: "Transaction not confirmed yet — wait a few seconds and retry (you were NOT charged again)." }, { status: 400 });
    }
    if (receipt.status !== "success") {
      await kvDel(usedKey);
      return NextResponse.json({ error: "That transaction failed on-chain — you were not charged for a report." }, { status: 400 });
    }

    // Recency guard: only a freshly-broadcast payment can be redeemed, so an old
    // unrelated transfer to the seller (e.g. a prior x402 settlement) can't be reused.
    try {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      const ageSec = Math.floor(Date.now() / 1000) - Number(block.timestamp);
      if (ageSec > 7200) {
        await kvDel(usedKey);
        return NextResponse.json({ error: "Payment is too old to redeem — make a fresh payment and retry." }, { status: 400 });
      }
    } catch {
      /* if the block read fails, fall through — replay is still bounded by the used-key */
    }

    // Sum USDC transfers to the seller in this tx; also capture the payer (from).
    const needMicro = BigInt(priceCents(service.price)) * 10_000n; // cents → 6-dp USDC micro
    let paidMicro = 0n;
    let payer = "";
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC) continue;
      try {
        const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
        if (ev.eventName === "Transfer" && String(ev.args.to).toLowerCase() === payTo) {
          paidMicro += ev.args.value as bigint;
          payer = String(ev.args.from).toLowerCase();
        }
      } catch {
        /* not a Transfer we can decode — ignore */
      }
    }
    if (paidMicro < needMicro) {
      await kvDel(usedKey);
      return NextResponse.json(
        {
          error: "No matching USDC payment to the seller wallet in that transaction (or amount below price).",
          needUsd: +(Number(needMicro) / 1e6).toFixed(2),
          paidUsd: +(Number(paidMicro) / 1e6).toFixed(2),
        },
        { status: 402 },
      );
    }

    // Payment verified → run the same handler the x402/credit paths run.
    let data: unknown;
    try {
      data = await service.handler(paramsFrom(req, service));
    } catch (err) {
      await kvDel(usedKey); // paid but couldn't deliver → let them retry the redemption
      return handlerErrorResponse(err);
    }

    await saveSample(service.id, data);
    await logUsage(
      service.id,
      true,
      srcHash(clientIp(req)),
      req.headers.get("user-agent") || "",
      req.headers.get("referer") || "",
      false,
      false,
      false,
      payer && /^0x[0-9a-f]{40}$/.test(payer) ? srcHash(payer) : "",
    );

    return NextResponse.json({ service: service.id, builderCode: cfg.appBuilderCode, data, paidVia: "onchain", txHash });
  } catch (err) {
    await kvDel(usedKey);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
