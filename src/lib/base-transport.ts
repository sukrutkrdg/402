/**
 * Shared Base RPC transport: the configured endpoint (BASE_RPC_URL — CDP Node)
 * first, with automatic fallback to the public default RPC on errors or rate
 * limits, so chain reads never stop when the paid/limited endpoint is exhausted.
 */

import { fallback, http, type Transport } from "viem";
import { getConfig } from "./config";

/**
 * @param batch collapse concurrent reads into ONE JSON-RPC request. Pass true
 * wherever a handler fires several independent reads at once: the public Base
 * RPC rate-limits parallel eth_calls and answers 502, which is how a handler
 * that read name/symbol/decimals/totalSupply in parallel ended up reporting
 * that USDC is not a standard ERC-20. Batched, those four are one round trip
 * and cannot trip the limiter against each other.
 */
export function baseTransport(timeoutMs = 8000, batch = false): Transport {
  const configured = getConfig().rpcUrl;
  const opts = batch ? { timeout: timeoutMs, batch: { wait: 0 } } : { timeout: timeoutMs };
  if (!configured) return http(undefined, opts);
  // rank:false keeps the order fixed: CDP primary, public only as the fallback.
  return fallback([http(configured, opts), http(undefined, opts)], { rank: false });
}
