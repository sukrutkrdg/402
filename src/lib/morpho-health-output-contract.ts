/**
 * GET /api/x402/morpho-health success contract.
 *
 * Authority is src/lib/morpho.ts morphoHealth(): two finish() returns (no_borrow
 * and an active-borrow position). Require only keys present on both. Borrow-only
 * fields (healthFactor, LTVs, loanToken, lastAccrual) stay optional.
 *
 * HTTP 200 wraps that payload as { service, builderCode, data }. Bazaar still
 * advertises the inner handler payload, matching the live discovery example.
 */

export const MORPHO_HEALTH_SERVICE_ID = "morpho-health" as const;

/** Keys morphoHealth() returns on every successful finish() branch, plus checkedAt from finish(). */
export const MORPHO_HEALTH_RESULT_REQUIRED = [
  "checkedAt",
  "wallet",
  "market",
  "pair",
  "verdict",
  "collateral",
  "collateralToken",
  "borrowed",
  "recommendation",
  "note",
] as const;

export const MORPHO_HEALTH_VERDICTS = [
  "no_borrow",
  "healthy",
  "moderate",
  "at_risk",
  "critical",
  "liquidatable",
] as const;

const stringProp = { type: "string" as const };

export const morphoHealthResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [...MORPHO_HEALTH_RESULT_REQUIRED],
  properties: {
    checkedAt: stringProp,
    wallet: stringProp,
    market: stringProp,
    pair: stringProp,
    verdict: { type: "string", enum: [...MORPHO_HEALTH_VERDICTS] },
    collateral: stringProp,
    collateralToken: stringProp,
    borrowed: stringProp,
    recommendation: stringProp,
    note: stringProp,
    healthFactor: { type: "number" },
    currentLtvPct: { type: "number" },
    liquidationLtvPct: { type: "number" },
    priceDropToLiquidationPct: { type: "number" },
    loanToken: stringProp,
    lastAccrual: stringProp,
  },
} as const;

/** HTTP 200 body written by src/app/api/x402/[service]/route.ts for this service. */
export const morphoHealthHttp200Schema = {
  type: "object",
  required: ["service", "data"],
  properties: {
    service: { type: "string" },
    builderCode: { type: "string" },
    data: morphoHealthResultSchema,
    related: { type: "object" },
  },
} as const;

export function openApi200For(serviceId: string): {
  description: string;
  content: { "application/json": { schema: Record<string, unknown> } };
} {
  const schema =
    serviceId === MORPHO_HEALTH_SERVICE_ID
      ? (morphoHealthHttp200Schema as unknown as Record<string, unknown>)
      : { type: "object" };
  return {
    description: "Success",
    content: { "application/json": { schema } },
  };
}

/**
 * Bazaar `output` block. Schema is the inner handler payload so it stays valid
 * against the existing discovery example. A missing checkedAt on the static
 * shop-window example is stamped at declaration time (that file forbids frozen
 * timestamps).
 */
export function discoveryOutputFor(
  serviceId: string,
  example: Record<string, unknown> | undefined,
): { example?: Record<string, unknown>; schema?: Record<string, unknown> } | undefined {
  if (serviceId === MORPHO_HEALTH_SERVICE_ID) {
    const stamped =
      example && typeof example.checkedAt === "string"
        ? example
        : example
          ? { checkedAt: new Date().toISOString(), ...example }
          : undefined;
    return {
      ...(stamped ? { example: stamped } : {}),
      schema: morphoHealthResultSchema as unknown as Record<string, unknown>,
    };
  }
  return example ? { example } : undefined;
}
