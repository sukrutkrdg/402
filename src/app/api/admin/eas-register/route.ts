/**
 * One-time admin endpoint: register the scam-registry EAS schema on Base.
 *
 * Gated by CRON_SECRET. Call once with a funded signer (EAS_SIGNER_KEY or the
 * reused BUYER_PRIVATE_KEY must hold a little ETH on Base for gas), then set
 * EAS_SCHEMA_UID to the returned schemaUid. Also returns the deterministic UID
 * even before sending, so you can pre-set it.
 */

import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/secure";
import { registerScamSchema, computeSchemaUid, easEnabled, signerAddress } from "@/lib/eas-attest";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const schemaUid = computeSchemaUid();
  const signer = signerAddress();
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";
  if (dryRun) {
    return NextResponse.json({
      schemaUid,
      signerAddress: signer,
      fundThisWithEth: signer,
      note: "Fund signerAddress with a little ETH on Base for gas, then call without ?dry=1 to register. Then set EAS_SCHEMA_UID to schemaUid.",
    });
  }

  const result = await registerScamSchema();
  if (!result) {
    return NextResponse.json(
      {
        error: "Register failed — fund the signer with ETH on Base for gas",
        schemaUid,
        signerAddress: signer,
        fundThisWithEth: signer,
      },
      { status: 500 },
    );
  }
  return NextResponse.json({
    registered: true,
    txHash: result.txHash,
    schemaUid: result.schemaUid,
    easEnabledAfterEnvSet: easEnabled(),
    next: "Set EAS_SCHEMA_UID to schemaUid in your env, then scout will publish on-chain scam attestations.",
  });
}
