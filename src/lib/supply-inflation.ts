/**
 * supply-inflation — "is_mintable" tells you the owner CAN mint; this tells you
 * whether they ARE, and how fast. A token can advertise a fixed supply and quietly
 * inflate it, diluting every holder before the dump. owner-powers flags the
 * capability; this measures the behaviour.
 *
 * Mints are Transfer events from the zero address; burns are transfers to zero /
 * dead. Summed over a window from address-filtered, time-bounded CDP SQL (the
 * reliable warehouse path), expressed as a share of the live totalSupply read
 * on-chain, and annualised.
 *
 * Honest about context: bridges, staking rewards and LP programs mint legitimately
 * — this flags the RATE, not intent, and only catches standard zero-address mints.
 * A signal, not proof. Not financial advice.
 */

import "server-only";
import { createPublicClient, getAddress, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { cdpSql } from "./covalent";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());
const TRANSFER = "Transfer(address,address,uint256)";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

const erc20 = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export async function supplyInflation(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!validAddr(raw)) throw new Error("Provide a valid 0x… token address");
  const address = getAddress(raw);
  const token = address.toLowerCase();
  const days = Math.min(Math.max(Number(params.days) || 30, 1), 365);

  const mintQ = `SELECT count() AS c, sum(toFloat64OrZero(toString(parameters['value']))) AS v, toString(max(block_timestamp)) AS last FROM base.events WHERE address='${token}' AND event_signature='${TRANSFER}' AND lower(toString(parameters['from']))='${ZERO}' AND block_timestamp > now() - INTERVAL ${days} DAY`;
  const burnQ = `SELECT count() AS c, sum(toFloat64OrZero(toString(parameters['value']))) AS v FROM base.events WHERE address='${token}' AND event_signature='${TRANSFER}' AND lower(toString(parameters['to'])) IN ('${ZERO}','${DEAD}') AND block_timestamp > now() - INTERVAL ${days} DAY`;

  const [mintR, burnR] = await Promise.all([
    cdpSql<{ c?: string; v?: string; last?: string }>(mintQ),
    cdpSql<{ c?: string; v?: string }>(burnQ),
  ]);
  if (mintR === null || burnR === null) throw new Error("Mint/burn data unavailable (warehouse) — not charged, retry shortly");

  const mintCount = Number(mintR[0]?.c ?? 0);
  const burnCount = Number(burnR[0]?.c ?? 0);
  const mintedWei = Number(mintR[0]?.v ?? 0); // float64 — fine for a ratio
  const burnedWei = Number(burnR[0]?.v ?? 0);
  const lastMintAt = mintR[0]?.last && !/^0{4}/.test(mintR[0].last) ? mintR[0].last : null;

  // Live supply on-chain to turn raw mint volume into a % of supply.
  let decimals: number | null = null;
  let supplyTokens: number | null = null;
  try {
    const [ts, dec] = await Promise.all([
      client.readContract({ address: address as Address, abi: erc20, functionName: "totalSupply" }),
      client.readContract({ address: address as Address, abi: erc20, functionName: "decimals" }),
    ]);
    decimals = Number(dec);
    supplyTokens = Number(formatUnits(ts as bigint, decimals));
  } catch {
    // supply unreadable — we still report counts/volume, just not the %.
  }

  const scale = decimals != null ? 10 ** decimals : 1;
  const mintedTokens = mintedWei / scale;
  const burnedTokens = burnedWei / scale;
  const netTokens = mintedTokens - burnedTokens;

  const canPct = supplyTokens != null && supplyTokens > 0;
  const mintedPct = canPct ? +((mintedTokens / (supplyTokens as number)) * 100).toFixed(2) : null;
  const netPct = canPct ? +((netTokens / (supplyTokens as number)) * 100).toFixed(2) : null;
  // Annualise the NET change so a 30-day read is comparable to a yearly rate.
  const annualNetPct = netPct != null ? +((netPct * 365) / days).toFixed(1) : null;

  let verdict: "fixed_in_window" | "deflationary" | "low_inflation" | "moderate_inflation" | "high_inflation" | "hyperinflation" | "unknown";
  if (mintCount === 0 && burnCount === 0) verdict = "fixed_in_window";
  else if (annualNetPct == null) verdict = "unknown";
  else if (annualNetPct < 0) verdict = "deflationary";
  else if (annualNetPct < 5) verdict = "low_inflation";
  else if (annualNetPct < 25) verdict = "moderate_inflation";
  else if (annualNetPct < 100) verdict = "high_inflation";
  else verdict = "hyperinflation";

  const num = (n: number | null) => (n == null ? "?" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  return {
    address,
    windowDays: days,
    mintEvents: mintCount,
    burnEvents: burnCount,
    lastMintAt,
    decimals,
    totalSupply: supplyTokens,
    mintedInWindow: mintedTokens || 0,
    burnedInWindow: burnedTokens || 0,
    mintedPctOfSupply: mintedPct, // minted / current supply, over the window
    netInflationPct: netPct, // (minted − burned) / supply, over the window
    annualizedNetInflationPct: annualNetPct,
    verdict, // fixed_in_window | deflationary | low_inflation | moderate_inflation | high_inflation | hyperinflation | unknown
    recommendation:
      verdict === "fixed_in_window"
        ? `No mints or burns in the last ${days}d — supply held fixed over the window. (A fixed window isn't a permanent guarantee; pair with owner-powers to see if minting is still possible.)`
        : verdict === "unknown"
          ? `${mintCount} mint event(s) seen in ${days}d but totalSupply couldn't be read on-chain, so the rate can't be sized. Treat inflation as unquantified.`
          : verdict === "deflationary"
            ? `Net supply SHRANK (~${num(annualNetPct)}%/yr equivalent) — more burned than minted over ${days}d. Deflationary in this window.`
            : verdict === "low_inflation"
              ? `Mild net inflation (~${num(annualNetPct)}%/yr equivalent over ${days}d) — ${mintCount} mints. Normal for a rewards/bridge token; watch it doesn't accelerate.`
              : verdict === "moderate_inflation"
                ? `Meaningful inflation (~${num(annualNetPct)}%/yr equivalent): ${num(mintedPct)}% of supply minted in ${days}d. Dilution is real — make sure the emissions are disclosed and priced in.`
                : verdict === "high_inflation"
                  ? `⚠️ High inflation (~${num(annualNetPct)}%/yr equivalent): ${num(mintedPct)}% of supply minted in just ${days}d. Holders are being diluted fast — a classic pre-dump setup unless there's a clear, disclosed reason.`
                  : `🛑 HYPERINFLATION: ~${num(mintedPct)}% of supply minted in ${days}d (~${num(annualNetPct)}%/yr equivalent). Supply is being printed; your share is evaporating. Treat as a dilution trap unless proven otherwise.`,
    note: "Net supply change from zero-address mints and burns (CDP SQL) versus live on-chain totalSupply, annualised. Bridges, staking rewards and LP programs mint legitimately — this flags the RATE, not intent, and catches only standard zero-address mints. A signal, not proof. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
