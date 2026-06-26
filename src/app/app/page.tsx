"use client";

/**
 * Base App mini-app experience: a mobile token-safety checker.
 *  - Free instant rug-score check (free tier, no wallet needed).
 *  - Full AI report paid in-app over x402 using the user's Base wallet
 *    (gasless EIP-3009 signature) — a real transacting user → Base App WTU.
 */

import { useEffect, useState } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";

type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

// Build the minimal ClientEvmSigner x402 needs from the mini-app wallet provider.
function makeSigner(provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }, address: `0x${string}`) {
  const domainType = (d: Record<string, unknown>) => {
    const f: Array<{ name: string; type: string }> = [];
    if (d.name !== undefined) f.push({ name: "name", type: "string" });
    if (d.version !== undefined) f.push({ name: "version", type: "string" });
    if (d.chainId !== undefined) f.push({ name: "chainId", type: "uint256" });
    if (d.verifyingContract !== undefined) f.push({ name: "verifyingContract", type: "address" });
    if (d.salt !== undefined) f.push({ name: "salt", type: "bytes32" });
    return f;
  };
  return {
    address,
    async signTypedData(msg: TypedData): Promise<`0x${string}`> {
      const typedData = {
        types: { EIP712Domain: domainType(msg.domain), ...msg.types },
        domain: msg.domain,
        primaryType: msg.primaryType,
        message: msg.message,
      };
      return (await provider.request({
        method: "eth_signTypedData_v4",
        params: [address, JSON.stringify(typedData)],
      })) as `0x${string}`;
    },
  };
}

export default function MiniApp() {
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<"free" | "paid" | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hasWallet, setHasWallet] = useState(false);

  useEffect(() => {
    sdk.actions.ready().catch(() => {});
    sdk.wallet.getEthereumProvider().then((p) => setHasWallet(Boolean(p))).catch(() => setHasWallet(false));
  }, []);

  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());

  async function freeCheck() {
    if (!valid) return;
    setErr(null);
    setOut(null);
    setBusy("free");
    try {
      const r = await fetch(`/api/x402/rug-score?address=${addr.trim()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Check failed");
      const d = j.data;
      setOut(`Rug score: ${d.rugScore}/100 (${d.level})\n${(d.signals || []).join("\n")}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function paidReport() {
    if (!valid) return;
    setErr(null);
    setOut(null);
    setBusy("paid");
    try {
      const provider = await sdk.wallet.getEthereumProvider();
      if (!provider) throw new Error("Open this inside the Base App to pay with your wallet.");
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts?.[0] as `0x${string}`;
      if (!address) throw new Error("No wallet account found");

      const client = new x402Client();
      client.register("eip155:8453", new ExactEvmScheme(makeSigner(provider, address)));
      client.registerExtension(new BuilderCodeClientExtension("x402_bazaar_cli"));
      const pay = wrapFetchWithPayment(fetch, client);

      const r = await pay(`/api/x402/ai-token-report?address=${addr.trim()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Payment or report failed");
      const d = j.data;
      const factors = (d.factors || []).map((f: { name: string; status: string }) => `• ${f.name}: ${f.status}`).join("\n");
      setOut(`${d.verdict?.toUpperCase()} · safety ${d.safetyScore}/100\n\n${d.summary}\n\n${factors}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <span className="pill w-fit">🛡️ x402 Bazaar</span>
        <h1 className="text-xl font-bold">Base Token Safety</h1>
        <p className="text-xs text-gray-400">
          Paste a Base token — get a free rug-score, or pay $0.05 in-app for a full AI verdict.
        </p>
      </header>

      <input
        value={addr}
        onChange={(e) => setAddr(e.target.value)}
        placeholder="0x… token address"
        className="w-full rounded-lg border border-base-line bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-base-blue"
      />

      <div className="flex gap-2">
        <button onClick={freeCheck} disabled={!valid || busy !== null} className="btn-ghost flex-1 !py-2 text-sm disabled:opacity-40">
          {busy === "free" ? "Checking…" : "Free check"}
        </button>
        <button onClick={paidReport} disabled={!valid || busy !== null} className="btn-primary flex-1 !py-2 text-sm disabled:opacity-40">
          {busy === "paid" ? "Paying…" : "AI report · $0.05"}
        </button>
      </div>

      {!hasWallet && (
        <p className="text-center text-[11px] text-gray-500">Open in the Base App to pay with your wallet.</p>
      )}
      {err && <div className="card border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{err}</div>}
      {out && <pre className="card whitespace-pre-wrap p-3 text-xs leading-relaxed text-gray-200">{out}</pre>}

      <a href="/" className="text-center text-xs text-sky-400 hover:underline">
        Browse all 48 services →
      </a>
    </main>
  );
}
