/**
 * Seller-side x402 wiring.
 *
 * Builds a single `x402ResourceServer` backed by the Coinbase CDP facilitator
 * (required for Base mainnet settlement) and the EVM "exact" scheme. The server
 * is cached across requests so we don't re-handshake the facilitator each call.
 */

import "server-only";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { NETWORK, getConfig, sellerReady } from "./config";

let cached: x402ResourceServer | undefined;

/**
 * Returns the shared resource server, or throws a clear error if the seller
 * credentials aren't configured yet.
 */
export function getResourceServer(): x402ResourceServer {
  if (cached) return cached;

  const cfg = getConfig();
  const ready = sellerReady(cfg);
  if (!ready.ok) {
    throw new Error(`Seller not configured. Missing env: ${ready.missing.join(", ")}`);
  }

  const facilitator = new HTTPFacilitatorClient(
    createFacilitatorConfig(cfg.cdpApiKeyId, cfg.cdpApiKeySecret),
  );

  cached = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  return cached;
}
