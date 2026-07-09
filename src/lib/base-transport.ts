/**
 * Shared Base RPC transport: the configured endpoint (BASE_RPC_URL — CDP Node)
 * first, with automatic fallback to the public default RPC on errors or rate
 * limits, so chain reads never stop when the paid/limited endpoint is exhausted.
 */

import { fallback, http, type Transport } from "viem";
import { getConfig } from "./config";

export function baseTransport(timeoutMs = 8000): Transport {
  const configured = getConfig().rpcUrl;
  if (!configured) return http(undefined, { timeout: timeoutMs });
  // rank:false keeps the order fixed: CDP primary, public only as the fallback.
  return fallback([http(configured, { timeout: timeoutMs }), http(undefined, { timeout: timeoutMs })], {
    rank: false,
  });
}
