/**
 * Shared Base RPC transport: the configured endpoint (BASE_RPC_URL — CDP Node)
 * first, then any fallbacks the operator listed explicitly, then the public
 * Base RPC — so chain reads never stop when the paid/limited endpoint is
 * exhausted. Nothing is added implicitly: a provider key that happens to be set
 * for another module (ALCHEMY_API_KEY) must not start absorbing Base traffic,
 * and customer queries should not fan out to third-party mirrors unasked.
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

  // Explicit opt-in only: BASE_ALCHEMY_RPC_URL / BASE_INFURA_RPC_URL and a
  // comma-separated BASE_RPC_FALLBACKS, in that order.
  const endpoints: string[] = [];
  const add = (u: string | undefined) => {
    const t = u?.trim();
    if (t && !endpoints.includes(t)) endpoints.push(t);
  };
  add(configured);
  add(process.env.BASE_ALCHEMY_RPC_URL);
  add(process.env.BASE_INFURA_RPC_URL);
  for (const u of (process.env.BASE_RPC_FALLBACKS ?? "").split(",")) add(u);

  if (!endpoints.length) return http(undefined, opts);
  // rank:false keeps the order fixed; the public Base RPC (viem default) is last.
  return fallback([...endpoints.map((url) => http(url, opts)), http(undefined, opts)], { rank: false });
}
