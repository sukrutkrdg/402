"use client";

/**
 * Shared browser-wallet x402 payment hook.
 *
 * Lets any client component charge the visitor's own wallet for an x402 service:
 * picks the right connector (Base App/Farcaster host wallet in a mini-app; the
 * installed browser wallet otherwise, with a picker when several exist), ensures
 * the wallet is on Base, signs the x402 payment, and returns the fetch Response.
 * Used by the marketplace ("Pay & call" on every service) and the /app checker.
 */

import { useState } from "react";
import { useAccount, useConnect, type Connector } from "wagmi";
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
export type EthProvider = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

// Minimal ClientEvmSigner x402 needs, from any EIP-1193 provider.
function makeSigner(provider: EthProvider, address: `0x${string}`, onSigning?: () => void) {
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
      const json = JSON.stringify(typedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      onSigning?.();
      return (await provider.request({ method: "eth_signTypedData_v4", params: [address, json] })) as `0x${string}`;
    },
  };
}

const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timed out: ${label}`)), ms))]);

/** Sentinel returned by pay() when it needs the user to choose a wallet first. */
export const PICK_WALLET = "PICK_WALLET" as const;

export function useX402Pay() {
  const { address, isConnected, connector } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const [picker, setPicker] = useState<Connector[] | null>(null);
  const [step, setStep] = useState<string | null>(null);

  const isFc = (c: Connector) => /farcaster/i.test(c.id) || /farcaster/i.test(c.type);

  /**
   * Pay for and call an x402 resource. `path` is `/api/x402/<id>?<query>`.
   * Returns the fetch Response, or PICK_WALLET when a wallet choice is needed
   * (the caller shows `picker` and calls pay again with the chosen connector).
   */
  async function pay(path: string, chosenConnector?: Connector): Promise<Response | typeof PICK_WALLET> {
    setPicker(null);
    if (connectors.length === 0) throw new Error("No wallet connector available.");

    let inMiniApp = false;
    try {
      inMiniApp = await sdk.isInMiniApp();
    } catch {
      inMiniApp = false;
    }

    let preferred = chosenConnector;
    if (!preferred) {
      if (inMiniApp) {
        preferred = connectors.find(isFc) ?? connectors[0];
      } else {
        const web = connectors.filter((c) => !isFc(c));
        if (web.length > 1) {
          setPicker(web);
          return PICK_WALLET;
        }
        preferred = web[0] ?? connectors[0];
      }
    }

    setStep("Connecting wallet…");
    let acct = address as `0x${string}` | undefined;
    let conn = connector;
    if (!isConnected || !acct || conn?.id !== preferred.id) {
      const res = await withTimeout(connectAsync({ connector: preferred }), 60000, "wallet connect");
      acct = res.accounts?.[0];
      conn = preferred;
    }
    if (!acct || !conn) throw new Error("Couldn't connect a wallet. Approve the connection and try again.");

    const provider = (await conn.getProvider()) as EthProvider;

    // Ensure the wallet is on Base (8453) before signing — x402 settles on Base.
    if (!inMiniApp) {
      setStep("Switching to Base…");
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
      } catch (switchErr) {
        if ((switchErr as { code?: number })?.code === 4902) {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0x2105",
                chainName: "Base",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://mainnet.base.org"],
                blockExplorerUrls: ["https://basescan.org"],
              },
            ],
          });
        }
      }
    }

    const client = new x402Client();
    client.register("eip155:8453", new ExactEvmScheme(makeSigner(provider, acct, () => setStep("✍️ Approve the signature in your wallet…"))));
    client.registerExtension(new BuilderCodeClientExtension("bc_pa0gqlv1"));
    const payingFetch = wrapFetchWithPayment(fetch, client);

    setStep("Paying & calling…");
    const res = await withTimeout(payingFetch(path), 90000, "payment/settlement");
    setStep(null);
    return res;
  }

  return { pay, picker, setPicker, step, setStep, hasWallet: connectors.length > 0 };
}
