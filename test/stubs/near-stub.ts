import { vi } from "vitest";

/**
 * A fake NEAR RPC + 1Click, answering in the real response shapes, for the
 * NEAR-native service tests. Describe the world; the stub answers from it.
 */
export interface NearWorld {
  accounts?: Record<string, { amount?: string; locked?: string; code_hash?: string; storage_usage?: number } | "unknown">;
  /** account → access key permissions */
  keys?: Record<string, ({ FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } | "FullAccess")[]>;
  /** `${contract}.${method}` → JSON answer, or a function of the call args. Missing = method not found. */
  views?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  tokens?: { assetId: string; decimals: number; blockchain: string; symbol: string; price?: number; contractAddress?: string }[];
  /** 1Click POST /v0/quote handler */
  quote?: (body: Record<string, unknown>) => unknown;
}

export const EMPTY = "11111111111111111111111111111111";
export const CODE = "E8jZ1giWcVrps8PcV75ATauu6gFRkcwjNtKp7NKmipZG";

export function stubNear(w: NearWorld) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url: u, body });
      if (u.endsWith("/v0/tokens")) return new Response(JSON.stringify(w.tokens ?? []));
      if (u.endsWith("/v0/quote")) {
        const r = w.quote?.(body ?? {});
        return r instanceof Response ? r : new Response(JSON.stringify(r ?? {}));
      }
      const p = (body?.params ?? {}) as Record<string, unknown>;
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "402", result }));
      const unknownAccount = () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "402", error: { cause: { name: "UNKNOWN_ACCOUNT" }, message: "Server error" } }));
      const id = String(p.account_id ?? "");
      if (p.request_type === "view_account") {
        const a = w.accounts?.[id];
        if (!a || a === "unknown") return unknownAccount();
        return ok({ amount: "0", locked: "0", code_hash: EMPTY, storage_usage: 182, ...a });
      }
      if (p.request_type === "view_access_key_list") {
        if (!w.accounts?.[id] || w.accounts[id] === "unknown") return unknownAccount();
        return ok({ keys: (w.keys?.[id] ?? []).map((perm, i) => ({ public_key: `ed25519:${i}`, access_key: { nonce: 1, permission: perm } })) });
      }
      if (p.request_type === "call_function") {
        const key = `${id}.${p.method_name}`;
        if (w.views && key in w.views) {
          const v = w.views[key];
          const args = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString("utf8"));
          const answer = typeof v === "function" ? (v as (a: Record<string, unknown>) => unknown)(args) : v;
          return ok({ result: Array.from(Buffer.from(JSON.stringify(answer))), logs: [] });
        }
        return ok({ error: "wasm execution failed: MethodNotFound", logs: [] });
      }
      return new Response("?", { status: 400 });
    }),
  );
  return calls;
}
