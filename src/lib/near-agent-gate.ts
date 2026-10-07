/**
 * NEAR agent pay gate — the NEAR counterpart of agent-pay-gate.
 *
 * agent-pay-gate screens a Base recipient before an agent sends USDC. NEAR has no
 * single pre-send gate: near-account describes an account, near-transfer-preflight
 * says whether a NEP-141 transfer will mechanically clear, but nothing composes
 * "should I pay this account, and will it even go through" into one verdict. This
 * does, from checks that already exist:
 *
 *   recipient posture (near-account) — does `to` exist, is it a contract (sending
 *     to a contract that does not expect a bare transfer can lose funds), does it
 *     carry control flags worth seeing.
 *   transfer mechanics (near-transfer-preflight) — when token (+amount) is given,
 *     will the transfer clear, or does `to` need storage registration first.
 *   amount awareness — a material amount to a non-existent named account, or to a
 *     contract, escalates rather than sitting beside the verdict.
 *
 * STOP = do not send; HOLD = will fail or needs a fix / warrants a look; GO =
 * nothing found that should stop it. A read we could not complete is surfaced,
 * never silently treated as clear.
 */

import "server-only";
import { nearAccount } from "./near-account";
import { nearTransferPreflight } from "./near-transfer-preflight";

type Verdict = "GO" | "HOLD" | "STOP";
const rank: Record<Verdict, number> = { GO: 0, HOLD: 1, STOP: 2 };
const worse = (a: Verdict, b: Verdict) => (rank[a] >= rank[b] ? a : b);

const MATERIAL_NEAR = 50; // a send at/above this to a shaky recipient escalates

export async function nearAgentGate(params: Record<string, string>) {
  const to = (params.to || params.account || params.recipient || "").trim().toLowerCase();
  if (!to) throw new Error("Provide the NEAR account you are about to pay (to=alice.near)");
  const token = (params.token || "").trim();
  const amount = (params.amount || "").trim();
  const nearAmount = (params.near || "").trim(); // native NEAR amount, for material-size sizing
  const material = nearAmount ? Number(nearAmount) >= MATERIAL_NEAR : false;

  const observed: string[] = [];
  let verdict: Verdict = "GO";

  // ---- recipient posture ----
  const acct = (await nearAccount({ account: to })) as {
    exists?: boolean;
    kind?: string;
    contract?: { deployed?: boolean; isToken?: boolean };
    flags?: string[];
  };
  const isContract = acct.contract?.deployed === true;
  if (acct.exists === false) {
    if (acct.kind === "implicit" || acct.kind === "eth-implicit") {
      observed.push("recipient does not exist yet but is an implicit id — a transfer can create it. Double-check the id; there is no way to recover funds sent to a mistyped implicit account.");
      verdict = worse(verdict, "HOLD");
    } else {
      observed.push(`recipient ${to} does NOT exist on NEAR — a transfer to a non-existent named account fails (or is unrecoverable if the id is wrong)`);
      verdict = worse(verdict, "STOP");
    }
  }
  if (isContract) {
    observed.push("recipient is a CONTRACT, not a plain account — sending to a contract that does not expect a bare transfer can lose the funds. Confirm it is meant to receive this.");
    verdict = worse(verdict, material ? "STOP" : "HOLD");
  }
  for (const f of acct.flags ?? []) observed.push(f);

  // ---- transfer mechanics (only when a token transfer is actually described) ----
  let preflight: { decision?: Verdict; verdict?: Verdict } | null = null;
  if (token) {
    const pf = (await nearTransferPreflight({ token, to, ...(params.from ? { from: params.from } : {}), ...(amount ? { amount } : {}) })) as {
      decision?: Verdict; verdict?: Verdict;
    };
    preflight = pf;
    const pv = (pf.decision || pf.verdict) as Verdict | undefined;
    if (pv) {
      verdict = worse(verdict, pv);
      if (pv !== "GO") observed.push(`token transfer preflight: ${pv} — see transferPreflight for the failing leg (often the recipient needs storage_deposit first)`);
    }
  }

  return {
    chain: "near" as const,
    to,
    token: token || null,
    decision: verdict, // GO | HOLD | STOP
    recipient: { exists: acct.exists ?? null, kind: acct.kind ?? null, isContract, flags: acct.flags ?? [] },
    ...(preflight ? { transferPreflight: preflight } : {}),
    observed,
    recommendation:
      verdict === "STOP"
        ? "Do NOT send — the recipient does not exist, or a material amount is heading to a contract that may not expect it. Resolve first."
        : verdict === "HOLD"
          ? "Hold — it will fail until a named fix (e.g. storage_deposit), or the recipient warrants a look before you send."
          : "Nothing found that should stop this send. On NEAR a mistyped account is unrecoverable, so confirm the id regardless.",
    note: "Pre-send gate for paying a NEAR account: composes the recipient's account posture (exists / contract / control flags) with the NEP-141 transfer preflight into one GO/HOLD/STOP. Pass token (+amount) for a token transfer, near= for native-amount sizing. The NEAR counterpart of agent-pay-gate. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
