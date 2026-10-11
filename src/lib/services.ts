/**
 * The marketplace catalog facade.
 *
 * Each entry is an x402-protected, pay-per-call API. The `handler` produces the
 * actual response a buyer receives *after* their payment settles. Everything is
 * self-contained (no external API keys) so the marketplace runs out of the box — but
 * each handler is a normal async function, so swapping in a real upstream API or
 * an LLM call is a one-line change.
 *
 * Catalog definitions are organized into category modules under `@/lib/catalog/`.
 */

export type { ServiceParam, ServiceDef } from "./catalog/types";
export {
  SERVICES,
  getService,
  ONCHAIN_SERVICES,
  B20_SERVICES,
  NEAR_SERVICES,
  AI_SERVICES,
  MARKETS_SERVICES,
  BUSINESS_SERVICES,
  UTILITY_SERVICES,
} from "./catalog";
