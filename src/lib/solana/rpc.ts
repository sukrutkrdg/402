/**
 * Minimal Solana JSON-RPC client — isolated from Base/NEAR, plain fetch (no SDK).
 * Mirrors the fallback discipline of base-transport.ts / near-rpc.ts: an env
 * endpoint first (Helius/Triton recommended), then public mainnet-beta.
 */
import "server-only";

const RPCS = [
  process.env.SOLANA_RPC_URL,
  ...(process.env.SOLANA_RPC_FALLBACKS?.split(",").map(s => s.trim()).filter(Boolean) ?? []),
  "https://api.mainnet-beta.solana.com",
].filter(Boolean) as string[];

export async function solanaRpc<T = unknown>(method: string, params: unknown[], timeoutMs = 8000): Promise<T> {
  let lastErr: unknown;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastErr = new Error(`Solana RPC ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error) {
        lastErr = new Error(json.error.message || "Solana RPC error");
        continue;
      }
      return json.result as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Solana RPC unavailable");
}
