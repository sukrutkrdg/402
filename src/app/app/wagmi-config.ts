import { http, createConfig } from "wagmi";
import { base } from "wagmi/chains";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";

/**
 * wagmi config for the mini-app. The farcasterMiniApp connector is the wallet
 * path Coinbase documents as working in BOTH the Base App and Farcaster clients
 * — it auto-connects to the host wallet and, critically, opens the Base App
 * connect prompt correctly (the manual eth_requestAccounts flow did not).
 */
export const wagmiConfig = createConfig({
  chains: [base],
  transports: { [base.id]: http() },
  connectors: [farcasterMiniApp()],
});
