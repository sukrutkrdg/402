/**
 * Bazaar discovery echo — the missing piece that gets us listed in the CDP Bazaar.
 *
 * THE TRAP (undocumented, confirmed via x402-listing-doctor): the CDP facilitator
 * only indexes a resource when a *settle* arrives whose PaymentPayload carries the
 * seller's `bazaar` discovery extension. The default x402 client does NOT copy the
 * seller's 402 extensions into the payment payload — so our own settlements
 * (bootstrap + mini-app) never triggered indexing, no matter how many times we paid.
 *
 * This client extension copies the seller's `extensions.bazaar` from the 402
 * payment-required response into the outgoing payment payload. Register it on the
 * buyer client alongside the builder-code extension; then a single real payment to
 * an endpoint lists it in the catalog within ~2 minutes.
 *
 * Shared by the server-side buyer (x402-client.ts) and the mini-app client, so it
 * must NOT be server-only.
 */

import { BAZAAR } from "@x402/extensions/bazaar";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";

const KEY = BAZAAR.key; // "bazaar"

/** Client extension: echo the seller's bazaar extension into the settle payload. */
export const bazaarEchoClientExtension = {
  key: KEY,
  async enrichPaymentPayload(payload: PaymentPayload, paymentRequired: PaymentRequired): Promise<PaymentPayload> {
    const bz = (paymentRequired as { extensions?: Record<string, unknown> }).extensions?.[KEY];
    if (bz == null) return payload;
    return { ...payload, extensions: { ...(payload.extensions ?? {}), [KEY]: bz } };
  },
};
