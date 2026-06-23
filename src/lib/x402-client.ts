/**
 * Buyer-side x402 wiring.
 *
 * Builds a payment-enabled `fetch` from the demo buyer's signer. The
 * `BuilderCodeClientExtension` attaches our client code (`s`) to every payment
 * and automatically echoes the seller's app code (`a`) from the 402 response.
 */

import "server-only";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { NETWORK, getConfig } from "./config";

let cachedFetch: ReturnType<typeof wrapFetchWithPayment> | undefined;

export function getPayingFetch(): ReturnType<typeof wrapFetchWithPayment> {
  if (cachedFetch) return cachedFetch;

  const cfg = getConfig();
  if (!cfg.buyerPrivateKey) {
    throw new Error("Buyer not configured. Missing env: BUYER_PRIVATE_KEY");
  }

  const key = (cfg.buyerPrivateKey.startsWith("0x")
    ? cfg.buyerPrivateKey
    : `0x${cfg.buyerPrivateKey}`) as Hex;
  const account = privateKeyToAccount(key);

  const client = new x402Client();
  client.register(NETWORK, new ExactEvmScheme(account));
  client.registerExtension(new BuilderCodeClientExtension(cfg.clientBuilderCode));

  cachedFetch = wrapFetchWithPayment(fetch, client);
  return cachedFetch;
}

export function getBuyerAddress(): string | undefined {
  const cfg = getConfig();
  if (!cfg.buyerPrivateKey) return undefined;
  const key = (cfg.buyerPrivateKey.startsWith("0x")
    ? cfg.buyerPrivateKey
    : `0x${cfg.buyerPrivateKey}`) as Hex;
  return privateKeyToAccount(key).address;
}
