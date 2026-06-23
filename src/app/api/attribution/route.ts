/**
 * ATTRIBUTION — read Builder Code attribution straight from the chain.
 *
 * Given a settlement tx hash, fetch the transaction, parse its calldata suffix
 * (ERC-8021 Schema 2) and return the decoded `a` / `w` / `s` codes. This is the
 * trustless verification path: no database, just what's onchain.
 */

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import { parseBuilderCodeSuffixFromCalldata } from "@x402/extensions/builder-code";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const hash = new URL(req.url).searchParams.get("hash")?.trim();
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return NextResponse.json({ error: "Provide a valid 0x-prefixed tx hash" }, { status: 400 });
  }

  const cfg = getConfig();
  const client = createPublicClient({
    chain: base,
    transport: http(cfg.rpcUrl),
  });

  let tx;
  try {
    tx = await client.getTransaction({ hash: hash as Hex });
  } catch {
    return NextResponse.json(
      { error: "Transaction not found on Base mainnet (or RPC unavailable)" },
      { status: 404 },
    );
  }

  const attribution = parseBuilderCodeSuffixFromCalldata(tx.input);

  // Normalize `s` (string | string[]) for the UI.
  const serviceCodes =
    attribution?.s === undefined ? [] : Array.isArray(attribution.s) ? attribution.s : [attribution.s];

  return NextResponse.json({
    hash,
    found: Boolean(attribution),
    attribution: attribution
      ? { app: attribution.a ?? null, wallet: attribution.w ?? null, service: serviceCodes }
      : null,
    tx: { from: tx.from, to: tx.to, blockNumber: tx.blockNumber?.toString() ?? null },
  });
}
