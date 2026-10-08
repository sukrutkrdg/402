/**
 * Bridge route — the safe way to move an agent's funds across chains.
 *
 * Agents increasingly hold and spend across chains, and bridging is the step
 * where they get it most wrong: wrong route, a bridge nobody should trust, fees
 * that eat the transfer, or a tx built blind. This returns the best route for a
 * cross-chain transfer via the LiFi aggregator (which routes across the major
 * bridges), with the numbers that decide whether to send: output amount, which
 * bridge, estimated time, and gas + bridge fees in USD — plus the ready-to-send
 * transaction. We never hold funds or keys.
 *
 * Honest about the source: this is a LiFi quote, so the route and amounts are an
 * estimate at this moment — re-quote with your own sender address immediately
 * before executing, and treat the named bridge as the trust decision it is. A
 * failed upstream is surfaced, never returned as "no route".
 */

import "server-only";

const LIFI = "https://li.quest/v1/quote";

/** Chains an agent is likely to bridge between, name → id. Numeric ids pass through. */
const CHAINS: Record<string, number> = { ethereum: 1, eth: 1, mainnet: 1, base: 8453, arbitrum: 42161, arb: 42161, optimism: 10, op: 10, polygon: 137, matic: 137 };
/** Decimals for the assets worth bridging by symbol. Raw addresses need amountUnits. */
const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6, ETH: 18, WETH: 18, DAI: 18 };

function chainId(raw: string, label: string): number {
  const s = (raw || "").trim().toLowerCase();
  if (!s) throw new Error(`${label} chain is required (e.g. base, arbitrum, optimism, polygon, ethereum)`);
  if (/^\d+$/.test(s)) return Number(s);
  const id = CHAINS[s];
  if (!id) throw new Error(`Unknown ${label} chain "${raw}". Use base, arbitrum, optimism, polygon, ethereum, or a numeric chain id.`);
  return id;
}

export async function bridgeRoute(params: Record<string, string>) {
  const fromChain = chainId(params.from || params.fromChain || "", "from");
  const toChain = chainId(params.to || params.toChain || "", "to");
  if (fromChain === toChain) throw new Error("from and to are the same chain — nothing to bridge.");

  const tokenRaw = (params.token || "USDC").trim();
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(tokenRaw);
  const symbol = isAddr ? null : tokenRaw.toUpperCase();

  // Convert the human amount to base units. Symbols use the known-decimals map;
  // a raw address requires amountUnits (we don't guess an unknown token's decimals).
  let fromAmount: string;
  if (isAddr) {
    fromAmount = (params.amountUnits || "").trim();
    if (!/^\d+$/.test(fromAmount)) throw new Error("For a raw token address, pass amountUnits (smallest units, integer). For USDC/USDT/ETH/WETH/DAI use amount + the symbol.");
  } else {
    const dec = DECIMALS[symbol as string];
    if (dec === undefined) throw new Error(`Unsupported symbol "${tokenRaw}". Supported: ${Object.keys(DECIMALS).join(", ")}, or pass a 0x address + amountUnits.`);
    const amt = (params.amount || "").trim();
    if (!/^\d*\.?\d+$/.test(amt)) throw new Error("Provide amount (e.g. 100) of the token to bridge.");
    const [whole, frac = ""] = amt.split(".");
    fromAmount = (BigInt(whole || "0") * 10n ** BigInt(dec) + BigInt((frac + "0".repeat(dec)).slice(0, dec) || "0")).toString();
  }

  const fromToken = isAddr ? tokenRaw : (symbol as string);
  const toToken = (params.toToken || fromToken).trim(); // same asset both sides by default
  const fromAddress = /^0x[0-9a-fA-F]{40}$/.test((params.fromAddress || params.from_addr || "").trim())
    ? (params.fromAddress || params.from_addr).trim()
    : "0x0000000000000000000000000000000000000001"; // placeholder → quote only; re-quote to execute

  const qs = new URLSearchParams({ fromChain: String(fromChain), toChain: String(toChain), fromToken, toToken, fromAmount, fromAddress });
  let res: Response;
  try {
    res = await fetch(`${LIFI}?${qs}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error("Bridge router unreachable (LiFi) — not charged, retry shortly.");
  }
  const body = (await res.json().catch(() => ({}))) as {
    message?: string; tool?: string;
    action?: { fromToken?: { symbol?: string; decimals?: number }; toToken?: { symbol?: string; decimals?: number } };
    estimate?: { toAmount?: string; executionDuration?: number; fromAmountUSD?: string; toAmountUSD?: string; gasCosts?: Array<{ amountUSD?: string }>; feeCosts?: Array<{ amountUSD?: string }> };
    transactionRequest?: { to?: string; data?: string; value?: string; chainId?: number; gasLimit?: string };
  };
  if (!res.ok || !body.estimate) {
    throw new Error(`No bridge route: ${body.message || `LiFi ${res.status}`}${res.status >= 500 ? " — retry shortly" : ""}`);
  }

  const e = body.estimate;
  const toDec = body.action?.toToken?.decimals ?? (DECIMALS[toToken.toUpperCase()] ?? 18);
  const toAmountHuman = e.toAmount ? Number(BigInt(e.toAmount) * 1_000_000n / 10n ** BigInt(toDec)) / 1_000_000 : null;
  const sumUsd = (arr?: Array<{ amountUSD?: string }>) => (arr ?? []).reduce((s, x) => s + (Number(x.amountUSD) || 0), 0);
  const gasUsd = +sumUsd(e.gasCosts).toFixed(4);
  const feeUsd = +sumUsd(e.feeCosts).toFixed(4);
  const hasRealSender = fromAddress !== "0x0000000000000000000000000000000000000001";

  return {
    from: { chain: fromChain, token: body.action?.fromToken?.symbol ?? fromToken },
    to: { chain: toChain, token: body.action?.toToken?.symbol ?? toToken },
    bridge: body.tool ?? null,
    receiveEstimate: toAmountHuman,
    receiveUsd: e.toAmountUSD ? Number(e.toAmountUSD) : null,
    sendUsd: e.fromAmountUSD ? Number(e.fromAmountUSD) : null,
    estTimeMinutes: e.executionDuration != null ? Math.round(e.executionDuration / 60) : null,
    cost: { gasUsd, bridgeFeeUsd: feeUsd, totalUsd: +(gasUsd + feeUsd).toFixed(4) },
    transaction: hasRealSender && body.transactionRequest
      ? { chainId: body.transactionRequest.chainId ?? fromChain, to: body.transactionRequest.to, data: body.transactionRequest.data, value: body.transactionRequest.value ?? "0", gas: body.transactionRequest.gasLimit ?? null }
      : null,
    steps: [
      hasRealSender
        ? `Send the transaction below from ${fromAddress} on chain ${fromChain}. It routes through ${body.tool ?? "the bridge"} and delivers to the same address on chain ${toChain}.`
        : `Re-run with fromAddress=<your wallet> to get the ready-to-send transaction — this quote used a placeholder sender.`,
      "Re-quote immediately before executing: routes, output and fees move continuously.",
      `Trust check: this routes through "${body.tool ?? "?"}". Bridging is only as safe as the bridge — confirm you are willing to use it for this size.`,
    ],
    note: "Best cross-chain route via the LiFi aggregator (routes across the major bridges): output, time, gas + bridge fees, and the ready-to-send tx. A quote, not a guarantee — re-quote with your own sender before executing. We never hold funds or keys. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
