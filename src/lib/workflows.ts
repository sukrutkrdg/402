/**
 * Workflows — several paid calls in one request, each one paid like a direct call.
 *
 * A workflow is up to MAX_STEPS calls to catalogue services. There is no second
 * billing path here: every step is handed to the same GET handler that serves
 * /api/x402/<id>, carrying the caller's own `x-credit-token`. That handler debits
 * the step's price before running it, refunds it if the handler throws or
 * returns a refusal, and reports what it actually took (`chargedUsd`). This
 * module only decides WHICH calls to make and in what order, and reports what
 * each one said.
 *
 * What it adds on top:
 *  - validation of every step (service id, parameter names, required inputs,
 *    reference syntax) before any step is called, so a typo in step 3 cannot
 *    cost the caller steps 1 and 2;
 *  - a quote from the same `effectivePriceFor` the route charges by;
 *  - references: a step parameter may be "$input.<name>" (the workflow's
 *    inputs) or "$<N>.<path>" (a scalar from step N's JSON response, e.g.
 *    "$1.data.address"). Resolution is a plain own-property walk — no eval, no
 *    templates, no prototype access;
 *  - stop-on-STOP: when a step's decision is STOP, later steps are not called,
 *    so they are not charged.
 *
 * Only the credit rail is supported: a run is several payments, and a prepaid
 * token is the one payment instrument that can cover several calls in one
 * request. Free-tier calls are not used — a direct call carrying a credit token
 * is billed to the token too, and a workflow step is exactly such a call.
 */

import { NextRequest } from "next/server";
import { getService } from "@/lib/services";
import type { ServiceDef } from "@/lib/catalog/types";
import { effectivePriceFor } from "@/lib/effective-price";
import { priceMills } from "@/lib/price";

export const MAX_STEPS = 5;

/** Services a workflow may not call. buy-credits mints credit and cannot be paid FROM credit. */
const NOT_IN_WORKFLOWS = new Set(["buy-credits"]);

/**
 * Services whose price depends on a parameter (see effectivePriceFor). When such
 * a parameter is a step reference its value is unknown until the run, so the
 * quote for that step is the declared price and is marked inexact.
 */
const PARAM_PRICED: Record<string, string[]> = {
  "url-to-json": ["list"],
  "exa-contents": ["urls"],
  "exa-search": ["text"],
  "ai-translate": ["text"],
  "ai-token-report": ["address"],
};

export interface StepSpec {
  service: string;
  params?: Record<string, unknown>;
}

export interface TemplateInput {
  name: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  inputs: TemplateInput[];
  steps: StepSpec[];
}

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: "pre-buy",
    name: "Pre-buy check (Base)",
    description:
      "token-risk → sellability → swap-route on one Base token. If token-risk or sellability returns decision STOP, the later steps are not called and not charged.",
    inputs: [
      { name: "address", label: "Token contract address", required: true, placeholder: "0x… token" },
      { name: "amountUsd", label: "Trade size in USD (optional)", placeholder: "1000" },
    ],
    steps: [
      { service: "token-risk", params: { address: "$input.address" } },
      { service: "sellability", params: { address: "$input.address", size: "$input.amountUsd" } },
      { service: "swap-route", params: { tokenOut: "$input.address", amountUsd: "$input.amountUsd" } },
    ],
  },
  {
    id: "wallet-dd",
    name: "Wallet due diligence (Base)",
    description:
      "sanctions → address-trust → wallet-drain-watch on one address. A sanctions STOP ends the run before the other two are charged.",
    inputs: [{ name: "address", label: "Wallet address", required: true, placeholder: "0x… wallet" }],
    steps: [
      { service: "sanctions", params: { address: "$input.address" } },
      { service: "address-trust", params: { address: "$input.address" } },
      { service: "wallet-drain-watch", params: { wallet: "$input.address" } },
    ],
  },
  {
    id: "near-pre-trade",
    name: "NEAR pre-trade",
    description:
      "near-pre-trade-gate (contract control + round-trip exit test) → near-swap-quote from USDC into the same token, at your size. The quote's `to` is taken from the gate's own answer ($1.data.token). A STOP from the gate skips the quote.",
    inputs: [
      { name: "token", label: "NEAR token contract account", required: true, placeholder: "usdt.tether-token.near" },
      { name: "size", label: "Trade size in USD", required: true, placeholder: "100" },
    ],
    steps: [
      { service: "near-pre-trade-gate", params: { token: "$input.token", size: "$input.size" } },
      { service: "near-swap-quote", params: { from: "USDC", to: "$1.data.token", amount: "$input.size" } },
    ],
  },
];

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

// ─── References ────────────────────────────────────────────────────────────

/** Path segments a reference may never walk through, whatever the object holds. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}|\d{1,4})$/;
const MAX_PATH = 8;

export type ParsedValue =
  | { kind: "literal"; value: string }
  | { kind: "input"; name: string }
  | { kind: "step"; step: number; path: string[] }
  | { kind: "error"; error: string };

/**
 * Read one parameter value. A string starting with "$" is a reference and must
 * be a well-formed one — anything else is rejected rather than passed on as a
 * literal, so a mistyped reference cannot silently become the input. "$$x" is
 * the literal "$x".
 */
export function parseValue(v: unknown): ParsedValue {
  if (typeof v === "number" || typeof v === "boolean") {
    if (typeof v === "number" && !Number.isFinite(v)) return { kind: "error", error: "numbers must be finite" };
    return { kind: "literal", value: String(v) };
  }
  if (typeof v !== "string") return { kind: "error", error: "values must be strings, numbers or booleans" };
  if (v.startsWith("$$")) return { kind: "literal", value: v.slice(1) };
  if (!v.startsWith("$")) return { kind: "literal", value: v };
  const parts = v.slice(1).split(".");
  const root = parts.shift() ?? "";
  if (parts.length > MAX_PATH) return { kind: "error", error: `reference ${JSON.stringify(v)} is deeper than ${MAX_PATH} segments` };
  for (const seg of parts) {
    if (!SEGMENT.test(seg) || FORBIDDEN_SEGMENTS.has(seg)) {
      return { kind: "error", error: `reference ${JSON.stringify(v)} has an invalid segment ${JSON.stringify(seg)}` };
    }
  }
  if (root === "input") {
    if (parts.length !== 1) return { kind: "error", error: `"$input" references name exactly one input, e.g. "$input.address"` };
    return { kind: "input", name: parts[0] };
  }
  if (/^[1-9]$/.test(root)) {
    if (parts.length === 0) return { kind: "error", error: `reference ${JSON.stringify(v)} needs a path, e.g. "$${root}.data.address"` };
    return { kind: "step", step: Number(root), path: parts };
  }
  return {
    kind: "error",
    error: `${JSON.stringify(v)} is not a valid reference — use "$input.<name>" or "$<step>.<path>" (e.g. "$1.data.address"); write "$$" for a literal "$"`,
  };
}

/** Walk own properties only. Returns the scalar as a string, or an error. */
export function resolvePath(root: unknown, path: string[]): { ok: true; value: string } | { ok: false; error: string } {
  let cur: unknown = root;
  for (const seg of path) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return { ok: false, error: `segment ${JSON.stringify(seg)} is not allowed` };
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg) || Number(seg) >= cur.length) return { ok: false, error: `no element ${seg}` };
      cur = cur[Number(seg)];
    } else if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return { ok: false, error: `no field ${JSON.stringify(seg)}` };
    }
  }
  if (typeof cur === "string") return { ok: true, value: cur };
  if (typeof cur === "number" && Number.isFinite(cur)) return { ok: true, value: String(cur) };
  if (typeof cur === "boolean") return { ok: true, value: String(cur) };
  return { ok: false, error: cur === null || cur === undefined ? "value is empty" : "value is not a string, number or boolean" };
}

// ─── Planning (validation, before anything is charged) ─────────────────────

export interface PlannedStep {
  index: number; // 1-based
  service: ServiceDef;
  /** Literal values, including resolved $input references. */
  literal: Record<string, string>;
  /** Parameters taken from an earlier step's response at run time. */
  refs: Record<string, { step: number; path: string[]; raw: string }>;
}

export interface Plan {
  name: string;
  steps: PlannedStep[];
  stopOnStop: boolean;
}

type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string; details?: string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Longest value a parameter may carry; the route clamps to these same widths. */
const maxLen = (name: string) => (/^(text(s|\d+)?|input)$/i.test(name) ? 45000 : 2000);

/**
 * Turn a request body into a validated plan. Nothing is called and nothing is
 * charged here; any problem is reported for every step at once.
 */
export function planWorkflow(body: unknown): PlanResult {
  if (!isPlainObject(body)) return { ok: false, error: "Body must be a JSON object: { template, input } or { steps: [{ service, params }] }" };
  const { template, steps: rawSteps, input: rawInput, stopOnStop } = body;

  if (stopOnStop !== undefined && typeof stopOnStop !== "boolean") return { ok: false, error: "stopOnStop must be true or false" };
  if (rawInput !== undefined && !isPlainObject(rawInput)) return { ok: false, error: "input must be an object of named values" };

  let specs: StepSpec[];
  let name = "custom";
  const errors: string[] = [];
  const input: Record<string, string> = {};
  for (const [k, v] of Object.entries((rawInput as Record<string, unknown>) ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    const p = parseValue(v);
    if (p.kind !== "literal") errors.push(`input.${k}: must be a plain value, not a reference`);
    else if (p.value.length > maxLen(k)) errors.push(`input.${k}: longer than ${maxLen(k)} characters`);
    else input[k] = p.value;
  }

  if (template !== undefined) {
    if (rawSteps !== undefined) return { ok: false, error: "Send either `template` or `steps`, not both" };
    const t = typeof template === "string" ? getTemplate(template) : undefined;
    if (!t) return { ok: false, error: `Unknown template ${JSON.stringify(template)}. Known: ${TEMPLATES.map((x) => x.id).join(", ")}` };
    name = t.id;
    specs = t.steps;
    for (const k of Object.keys(input)) {
      if (!t.inputs.some((i) => i.name === k)) errors.push(`input.${k}: not an input of ${t.id} (inputs: ${t.inputs.map((i) => i.name).join(", ")})`);
    }
    for (const i of t.inputs) {
      if (i.required && !input[i.name]) errors.push(`input.${i.name}: required by ${t.id} (${i.label})`);
    }
  } else {
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) return { ok: false, error: "steps must be a non-empty array of { service, params }" };
    if (rawSteps.length > MAX_STEPS) return { ok: false, error: `At most ${MAX_STEPS} steps per workflow (got ${rawSteps.length})` };
    specs = rawSteps as StepSpec[];
  }

  const planned: PlannedStep[] = [];
  specs.forEach((spec, i) => {
    const index = i + 1;
    const at = `step ${index}`;
    if (!isPlainObject(spec)) {
      errors.push(`${at}: must be an object { service, params }`);
      return;
    }
    const service = typeof spec.service === "string" ? getService(spec.service) : undefined;
    if (!service) {
      errors.push(`${at}: unknown service ${JSON.stringify(spec.service)}`);
      return;
    }
    if (NOT_IN_WORKFLOWS.has(service.id)) {
      errors.push(`${at}: ${service.id} cannot be run inside a workflow`);
      return;
    }
    if (spec.params !== undefined && !isPlainObject(spec.params)) {
      errors.push(`${at}: params must be an object`);
      return;
    }
    const declared = new Set(service.params.map((p) => p.name));
    const literal: Record<string, string> = {};
    const refs: PlannedStep["refs"] = {};
    for (const [k, v] of Object.entries(spec.params ?? {})) {
      if (!declared.has(k)) {
        errors.push(`${at} (${service.id}): unknown parameter ${JSON.stringify(k)}; accepted: ${[...declared].join(", ") || "none"}`);
        continue;
      }
      const p = parseValue(v);
      if (p.kind === "error") errors.push(`${at} (${service.id}).${k}: ${p.error}`);
      else if (p.kind === "literal") {
        if (p.value.length > maxLen(k)) errors.push(`${at} (${service.id}).${k}: longer than ${maxLen(k)} characters`);
        else if (p.value !== "") literal[k] = p.value;
      } else if (p.kind === "input") {
        if (input[p.name] !== undefined) literal[k] = input[p.name];
        // A missing optional input simply leaves the parameter out.
      } else if (p.step >= index) {
        errors.push(`${at} (${service.id}).${k}: "${String(v)}" must refer to an EARLIER step (1–${index - 1})`);
      } else {
        refs[k] = { step: p.step, path: p.path, raw: String(v) };
      }
    }
    for (const p of service.params) {
      if (p.required && literal[p.name] === undefined && !refs[p.name]) {
        errors.push(`${at} (${service.id}): missing required parameter ${JSON.stringify(p.name)} (${p.label})`);
      }
    }
    planned.push({ index, service, literal, refs });
  });

  if (errors.length) return { ok: false, error: `Workflow rejected before anything was charged: ${errors[0]}`, details: errors };
  return { ok: true, plan: { name, steps: planned, stopOnStop: stopOnStop !== false } };
}

// ─── Quote ─────────────────────────────────────────────────────────────────

/** Headers carried from the caller to each step: identity for rate limits and coupons, nothing that pays or bypasses. */
const FORWARDED_HEADERS = [
  "cf-connecting-ip",
  "x-vercel-forwarded-for",
  "x-real-ip",
  "x-forwarded-for",
  "x-402-client-ip",
  "x-402-client-sig",
  "user-agent",
];

function stepRequest(origin: string, serviceId: string, params: Record<string, string>, from: Request, creditToken?: string): NextRequest {
  const url = new URL(`/api/x402/${encodeURIComponent(serviceId)}`, origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = new Headers();
  for (const h of FORWARDED_HEADERS) {
    const v = from.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("referer", `${origin}/workflows`);
  if (creditToken) headers.set("x-credit-token", creditToken);
  return new NextRequest(url, { method: "GET", headers });
}

export interface StepQuote {
  index: number;
  service: string;
  price: string;
  priceUsd: number;
  /** False when a price-setting parameter comes from an earlier step and is unknown until the run. */
  exact: boolean;
}

export interface Quote {
  totalUsd: number;
  totalMills: number;
  exact: boolean;
  steps: StepQuote[];
}

/** Price every step with the route's own price function. */
export async function quotePlan(plan: Plan, from: Request): Promise<Quote> {
  const origin = new URL(from.url).origin;
  const steps: StepQuote[] = [];
  let totalMills = 0;
  for (const s of plan.steps) {
    const price = await effectivePriceFor(s.service, stepRequest(origin, s.service.id, s.literal, from));
    const mills = priceMills(price);
    totalMills += mills;
    const exact = !(PARAM_PRICED[s.service.id] ?? []).some((p) => s.refs[p]);
    steps.push({ index: s.index, service: s.service.id, price, priceUsd: mills / 1000, exact });
  }
  return { totalUsd: totalMills / 1000, totalMills, exact: steps.every((s) => s.exact), steps };
}

// ─── Run ───────────────────────────────────────────────────────────────────

/** Calls one paid endpoint. Production: the /api/x402/[service] GET handler itself. */
export type PaidCaller = (req: NextRequest, serviceId: string) => Promise<Response>;

export type StepStatus = "ok" | "refunded" | "failed" | "skipped";

export interface StepResult {
  index: number;
  service: string;
  status: StepStatus;
  httpStatus: number | null;
  params: Record<string, string>;
  chargedUsd: number;
  decision: string | null;
  error?: string;
  /** The endpoint's JSON response, exactly as a direct call would have received it. */
  output?: unknown;
}

export interface RunResult {
  workflow: string;
  stopOnStop: boolean;
  completed: boolean;
  haltedAt: number | null;
  haltReason: string | null;
  insufficientCredits: boolean;
  totalChargedUsd: number;
  creditBalanceUsd: number | null;
  steps: StepResult[];
}

const DECISIONS = new Set(["GO", "HOLD", "REVIEW", "STOP", "REFUSE"]);

/** The verdict a step returned: its receipt's decision first, then `decision`, then `verdict`. */
export function stepDecision(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const receipt = d.receipt && typeof d.receipt === "object" ? (d.receipt as Record<string, unknown>) : {};
  for (const v of [receipt.decision, d.decision, d.verdict]) {
    if (typeof v === "string" && DECISIONS.has(v.toUpperCase())) return v.toUpperCase();
  }
  return null;
}

/**
 * Run a validated plan step by step. Each step is one call to the paid endpoint
 * with the caller's credit token; the endpoint does the debiting and refunding.
 * After a failed step, an insufficient balance or a STOP, the remaining steps are
 * not called — so they are not charged.
 */
export async function runPlan(plan: Plan, from: Request, creditToken: string, callPaid: PaidCaller): Promise<RunResult> {
  const origin = new URL(from.url).origin;
  const results: StepResult[] = [];
  const outputs = new Map<number, unknown>();
  let haltedAt: number | null = null;
  let haltReason: string | null = null;
  let insufficient = false;
  let totalMills = 0;
  let balance: number | null = null;

  for (const s of plan.steps) {
    const params = { ...s.literal };
    if (haltedAt !== null) {
      results.push({ index: s.index, service: s.service.id, status: "skipped", httpStatus: null, params, chargedUsd: 0, decision: null, error: `not called (${haltReason})` });
      continue;
    }

    let refError: string | null = null;
    for (const [k, r] of Object.entries(s.refs)) {
      const got = resolvePath(outputs.get(r.step), r.path);
      if (!got.ok) {
        refError = `parameter ${k} = "${r.raw}" could not be resolved: ${got.error}`;
        break;
      }
      if (got.value.length > maxLen(k)) {
        refError = `parameter ${k} = "${r.raw}" resolved to more than ${maxLen(k)} characters`;
        break;
      }
      params[k] = got.value;
    }
    if (refError) {
      results.push({ index: s.index, service: s.service.id, status: "failed", httpStatus: null, params, chargedUsd: 0, decision: null, error: `${refError} — not called, not charged` });
      haltedAt = s.index;
      haltReason = `step ${s.index} could not be prepared`;
      continue;
    }

    let res: Response;
    try {
      res = await callPaid(stepRequest(origin, s.service.id, params, from, creditToken), s.service.id);
    } catch (err) {
      // An exception escaping the endpoint is what a direct caller would see as a
      // 500. The endpoint refunds around its handler, but we cannot read what it
      // did from here, so say so instead of reporting a charge we did not see.
      results.push({
        index: s.index,
        service: s.service.id,
        status: "failed",
        httpStatus: null,
        params,
        chargedUsd: 0,
        decision: null,
        error: `endpoint error: ${err instanceof Error ? err.message : String(err)} — the charge for this step could not be read; check your balance at /api/credits/balance`,
      });
      haltedAt = s.index;
      haltReason = `step ${s.index} failed`;
      continue;
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    // What the endpoint reports it took. Only a delivered (2xx) response can carry a charge.
    const charged = res.ok && typeof b.chargedUsd === "number" ? b.chargedUsd : 0;
    totalMills += Math.round(charged * 1000);
    if (typeof b.creditBalanceUsd === "number") balance = b.creditBalanceUsd;

    if (!res.ok) {
      const message = typeof b.error === "string" ? b.error : `HTTP ${res.status}`;
      if (res.status === 402) {
        insufficient = message === "Insufficient credits";
        if (typeof b.balanceUsd === "number") balance = b.balanceUsd;
      }
      results.push({ index: s.index, service: s.service.id, status: "failed", httpStatus: res.status, params, chargedUsd: 0, decision: null, error: message, output: body });
      haltedAt = s.index;
      haltReason = insufficient ? `insufficient credits at step ${s.index}` : `step ${s.index} failed (${message})`;
      continue;
    }

    outputs.set(s.index, body);
    const decision = stepDecision(b.data);
    const refunded = b.refunded === true;
    results.push({ index: s.index, service: s.service.id, status: refunded ? "refunded" : "ok", httpStatus: res.status, params, chargedUsd: charged, decision, output: body });
    if (plan.stopOnStop && decision === "STOP") {
      haltedAt = s.index;
      haltReason = `step ${s.index} (${s.service.id}) returned decision STOP`;
    }
  }

  return {
    workflow: plan.name,
    stopOnStop: plan.stopOnStop,
    completed: haltedAt === null,
    haltedAt,
    haltReason,
    insufficientCredits: insufficient,
    totalChargedUsd: totalMills / 1000,
    creditBalanceUsd: balance,
    steps: results,
  };
}
