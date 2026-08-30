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
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { ALL_NETWORKS, getConfig, sellerReady } from "./config";

let cached: x402ResourceServer | undefined;
let initOnce: Promise<void> | undefined;

/**
 * Returns the shared resource server, initialised exactly once per instance.
 *
 * The initialisation is the whole point, and getting it wrong was costing us
 * 503s. `withX402` builds a fresh HTTP wrapper per call and its `isInitialized`
 * flag lives in that wrapper's closure, so with the default
 * `syncFacilitatorOnStart = true` every request re-ran `initialize()`. That does:
 *
 *     this.supportedResponsesMap.clear();          // on the SHARED server
 *     await facilitatorClient.getSupported();      // network call to CDP
 *
 * — it empties the shared map and then goes to the network. Any concurrent
 * request that reached `getSupportedKind()` inside that window found nothing and
 * threw "Facilitator does not support exact on eip155:8453", which surfaced as a
 * 503. It also meant one authenticated CDP round trip per request, on all 141
 * endpoints, including unpaid 402 probes — by far our largest traffic class.
 *
 * So we initialise once here and pass `syncFacilitatorOnStart = false` at the
 * call site. A failed init is not cached: the promise is cleared so the next
 * request retries instead of the instance being permanently poisoned.
 */
export async function getResourceServer(): Promise<x402ResourceServer> {
  const server = buildResourceServer();
  if (!initOnce) {
    initOnce = server.initialize().catch((err: unknown) => {
      initOnce = undefined; // let the next request try again
      throw err;
    });
  }
  await initOnce;
  return server;
}

/** Construct (or reuse) the server itself, without initialising it. */
function buildResourceServer(): x402ResourceServer {
  if (cached) return cached;

  const cfg = getConfig();
  const ready = sellerReady(cfg);
  if (!ready.ok) {
    throw new Error(`Seller not configured. Missing env: ${ready.missing.join(", ")}`);
  }

  const facilitator = new HTTPFacilitatorClient(
    createFacilitatorConfig(cfg.cdpApiKeyId, cfg.cdpApiKeySecret),
  );

  // Register the Bazaar extension so routes that declare a discovery extension
  // get auto-indexed in the x402 Bazaar (CDP's discovery layer) after settlement.
  // One scheme instance per network we advertise. `ExactEvmScheme` is
  // chain-agnostic, so the extra EVM chains cost a registration and nothing
  // else — same code path, same payTo, same settlement shape.
  let server = new x402ResourceServer(facilitator);
  for (const net of ALL_NETWORKS) server = server.register(net, new ExactEvmScheme());
  cached = server.registerExtension(bazaarResourceServerExtension);
  return cached;
}
