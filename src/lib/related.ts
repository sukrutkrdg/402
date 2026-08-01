/**
 * "What else can this seller do" — attached to PAID responses.
 *
 * WHY: the only moment an agent is certain to read our JSON closely is the one
 * where it just paid and got an answer. Until now that response told it nothing
 * about the rest of the catalogue: the 402 body advertises payment on-ramps and
 * the free preview advertises the paid version, but a successful purchase said
 * only "here is your data". The measurable consequence is visible on chain —
 * buyers call one endpoint once and never discover a second one.
 *
 * Deliberately small: at most three entries, each a real capability with its
 * live price and callable URL. Prices are read from the catalogue, never typed
 * here — a stale price in a suggestion is a lie the buyer acts on.
 */

import "server-only";
import { SERVICES } from "./services";
import { getSiteUrl } from "./config";

/**
 * Hand-picked follow-ons, keyed by the service just called. These are the pairs
 * where the second call genuinely completes the first, rather than being the
 * nearest thing alphabetically.
 */
const PAIRS: Record<string, string[]> = {
  "url-extract": ["url-to-json", "ai-summarize", "file-publish"],
  "url-to-json": ["url-extract", "file-convert"],
  "ai-summarize": ["file-publish", "url-extract"],
  "ai-extract": ["file-convert", "url-to-json"],
  "file-convert": ["file-publish", "file-slot"],
  "file-slot": ["file-publish", "file-convert"],
  "file-publish": ["file-slot", "file-convert"],
  "email-verify": ["counterparty-check", "domain-check"],
  "domain-check": ["counterparty-check", "email-verify"],
  "company-lei": ["counterparty-check", "sanctions-name"],
  "sanctions-name": ["counterparty-check", "sanctions"],
  "counterparty-check": ["company-lei", "business-days"],
  "fx-convert": ["inflation-adjust", "business-days"],
  "business-days": ["fx-convert", "counterparty-check"],
  "inflation-adjust": ["fx-convert", "business-days"],
  "token-risk": ["pre-trade-gate", "sellability"],
  "rug-score": ["pre-trade-gate", "token-risk"],
  "sellability": ["pre-trade-gate", "rug-score"],
  "b20-safety": ["b20-gate", "b20-policy-watch"],
};

/**
 * The capability every agent needs and almost none of our callers know we have:
 * somewhere to put what they just produced. Appended once, and only when the
 * caller is not already using that side of the catalogue.
 */
const OUTPUT_SIDE = ["file-slot", "file-publish"];

/** Services whose response is a credential or a subscription — leave them alone. */
const NO_SUGGESTIONS = new Set(["buy-credits", "secure-token", "rug-monitor", "price-alert", "watchlist-diff"]);

export interface Related {
  id: string;
  price: string;
  what: string;
  endpoint: string;
}

export function relatedFor(serviceId: string): Related[] {
  if (NO_SUGGESTIONS.has(serviceId)) return [];
  const visible = new Map(SERVICES.filter((s) => !s.hidden).map((s) => [s.id, s]));
  const self = visible.get(serviceId);
  if (!self) return [];

  const picks: string[] = [];
  const add = (id: string) => {
    if (id !== serviceId && visible.has(id) && !picks.includes(id) && picks.length < 3) picks.push(id);
  };

  for (const id of PAIRS[serviceId] ?? []) add(id);
  // Nothing curated for this one → offer its nearest siblings by category.
  if (!picks.length) {
    for (const s of SERVICES) {
      if (s.category === self.category && !s.hidden) add(s.id);
      if (picks.length >= 2) break;
    }
  }
  // One line about the output side, for callers who have never seen it.
  if (!OUTPUT_SIDE.includes(serviceId) && !picks.some((p) => OUTPUT_SIDE.includes(p))) {
    picks.length = Math.min(picks.length, 2);
    add(OUTPUT_SIDE[0]);
  }

  const site = getSiteUrl();
  return picks.map((id) => {
    const s = visible.get(id)!;
    return { id, price: s.price, what: s.tagline, endpoint: `${site}/api/x402/${id}` };
  });
}

/**
 * Attach the block to a paid response body. No-op when there is nothing worth
 * suggesting, so a response never carries an empty ornament.
 */
export function withRelated(body: Record<string, unknown>, serviceId: string): Record<string, unknown> {
  const related = relatedFor(serviceId);
  if (!related.length) return body;
  return {
    ...body,
    related: {
      note: "Other capabilities from this seller, callable the same way with the same payment method.",
      services: related,
    },
  };
}
