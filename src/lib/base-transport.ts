/**
 * Shared Base RPC transport: the configured endpoint (BASE_RPC_URL — CDP Node)
 * first, with automatic fallback across multiple premium and public providers
 * (Alchemy, Infura, LlamaNodes, PublicNode, Base default) on errors or rate limits,
 * so chain reads never stop when any single endpoint is throttled or exhausted.
 */

import { fallback, http, type Transport } from "viem";
import { getConfig } from "./config";

/** Known reliable Base mainnet RPC fallbacks */
const PUBLIC_BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
];

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

  const endpoints: string[] = [];
  if (configured) endpoints.push(configured);

  // Optional provider keys from environment
  if (process.env.BASE_ALCHEMY_RPC_URL) {
    endpoints.push(process.env.BASE_ALCHEMY_RPC_URL);
  } else if (process.env.ALCHEMY_API_KEY) {
    endpoints.push(`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
  }

  if (process.env.BASE_INFURA_RPC_URL) {
    endpoints.push(process.env.BASE_INFURA_RPC_URL);
  } else if (process.env.INFURA_API_KEY) {
    endpoints.push(`https://base-mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`);
  }

  // Comma-separated custom fallbacks if configured
  if (process.env.BASE_RPC_FALLBACKS) {
    for (const u of process.env.BASE_RPC_FALLBACKS.split(",")) {
      const trimmed = u.trim();
      if (trimmed && !endpoints.includes(trimmed)) endpoints.push(trimmed);
    }
  }

  // Include primary public mirrors
  for (const pub of PUBLIC_BASE_RPCS) {
    if (!endpoints.includes(pub)) endpoints.push(pub);
  }

  if (endpoints.length <= 1) {
    return endpoints.length === 1 ? http(endpoints[0], opts) : http(undefined, opts);
  }

  // rank: false keeps the preferred order: configured/CDP first, Alchemy/Infura second, public mirrors as backstops.
  return fallback(endpoints.map((url) => http(url, opts)), { rank: false, retryCount: 2 });
}
