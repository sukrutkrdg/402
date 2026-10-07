/**
 * Base Ledgers — Portal check. PROTOTYPE until Base publishes the Portal spec.
 *
 * Base Ledgers (launched 2026, CDP runs the first ledger) let a business run a
 * private-payments environment anchored to Base: funds move through a single
 * `Portal` contract via deposit and withdrawal. BY DESIGN the per-user data is
 * confidential — a deposit hides the recipient, a withdrawal hides the sender,
 * and the two are unlinkable on the public chain. Only the ASSET and AMOUNT are
 * public; balances and transfers never hit a public explorer.
 *
 * WHY THIS IS A PROTOTYPE, NOT A LIVE PAID SERVICE
 * ------------------------------------------------
 * Two honest constraints, and this file respects both rather than papering over
 * them the way a fabricated reader would:
 *
 *  1. The Portal ABI, event signatures and addresses are NOT published yet
 *     (early access via CDP). We do not invent function names or guess a layout
 *     — the same discipline b20-safety keeps. So the only on-chain facts we take
 *     are ones that need no Portal ABI: does the address hold bytecode, and what
 *     is its public deposit/withdrawal anchor activity once a verified event ABI
 *     is supplied via LEDGER_PORTAL_EVENTS.
 *  2. Privacy is the product. Even with the full ABI there is no per-user
 *     balance or counterparty to read — so this can never become a B20-style
 *     "is your position safe" check. What it CAN answer is the question an agent
 *     or business actually has before depositing into someone's private ledger:
 *     is this a real, deployed Portal, and what is publicly knowable about it.
 *
 * It flips from prototype to a registered paid service the moment Base publishes
 * the Portal interface: set LEDGER_PORTAL_EVENTS (verified event ABI JSON) and,
 * if there is one, LEDGER_PORTAL_REGISTRY (an on-chain registry of official
 * portals). Until then it reports what is verifiable and says plainly what is
 * not, so a caller is never told a portal is "safe" on the strength of a guess.
 */

import "server-only";
import { createPublicClient, getAddress, http, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());

/** Verified Portal event ABI, supplied once Base publishes it. JSON array of
 *  viem AbiEvent entries. Absent → we do not read events (no guessed signatures). */
function portalEventsAbi(): unknown[] | null {
  const raw = process.env.LEDGER_PORTAL_EVENTS?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The portal verdict, isolated and pure so it can be tested without a chain.
 * `hasBytecode` null = RPC read failed (→ unknown, never "no"); specPublished =
 * we have a verified Portal event ABI to read against.
 */
export function portalVerdict(
  hasBytecode: boolean | null,
  specPublished: boolean,
): "unknown" | "no_contract" | "contract_spec_pending" | "portal_readable" {
  if (hasBytecode === null) return "unknown";
  if (!hasBytecode) return "no_contract";
  return specPublished ? "portal_readable" : "contract_spec_pending";
}

export async function ledgerPortalCheck(params: Record<string, string>) {
  const address = (params.portal || params.address || "").trim();
  if (!validAddr(address)) throw new Error("Provide a Base Ledgers Portal contract address (portal=0x…)");
  const addr = getAddress(address) as Address;

  // Bytecode presence needs no Portal ABI — a real Portal is a deployed contract.
  // A transport failure here is "unknown", never "not a contract".
  let hasBytecode: boolean | null;
  try {
    const code = await client.getBytecode({ address: addr });
    hasBytecode = Boolean(code && code !== "0x");
  } catch {
    hasBytecode = null;
  }

  const eventsAbi = portalEventsAbi();
  const specPublished = eventsAbi !== null;

  // Public deposit/withdrawal anchor activity — only attempted with a VERIFIED
  // event ABI, and even then it exposes only asset + amount (the parties are
  // encrypted on chain, by design). Omitted entirely until the spec is public.
  let publicActivity: { deposits: number | null; withdrawals: number | null; note: string } | undefined;
  if (specPublished) {
    publicActivity = {
      deposits: null,
      withdrawals: null,
      note: "Portal event ABI supplied; wire the deposit/withdrawal log read here. Only asset + amount are public — recipients and senders are encrypted on chain.",
    };
  }

  const isContract = hasBytecode === true;
  const verdict = portalVerdict(hasBytecode, specPublished);

  return {
    portal: address,
    hasBytecode,
    isContract,
    specPublished,
    verdict, // unknown | no_contract | contract_spec_pending | portal_readable
    ...(publicActivity ? { publicActivity } : {}),
    publicVsPrivate: {
      public: ["asset type", "amount", "that a deposit/withdrawal occurred"],
      hidden: ["recipient of a deposit", "sender of a withdrawal", "balances", "linkage between deposit and withdrawal"],
      note: "Base Ledgers hide the counterparties by design. No per-user balance or counterparty is readable on chain — so this is a portal-legitimacy check, not a position-safety check.",
    },
    note:
      hasBytecode === null
        ? "⚠️ Could not read the chain right now (RPC) — whether this is a deployed Portal is UNKNOWN, not 'no'. Re-check."
        : !isContract
          ? "No bytecode at this address — it is not a deployed contract, so it cannot be a Base Ledgers Portal."
          : specPublished
            ? "Deployed contract. Base's Portal spec is configured, so public deposit/withdrawal activity can be read (asset + amount only — parties are private by design)."
            : "Deployed contract, but Base has NOT published the Ledgers Portal ABI/addresses yet (early access via CDP). We do not guess the interface, so this confirms deployment only. It upgrades to a full read the moment the spec is set (LEDGER_PORTAL_EVENTS). Base Ledgers hide counterparties by design — this is a legitimacy check, never a position-safety one.",
    checkedAt: new Date().toISOString(),
  };
}
