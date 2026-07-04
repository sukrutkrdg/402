import { http, createConfig } from "wagmi";
import { base } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";

/**
 * Multi-wallet config so the mini-app works in every context:
 *  - farcasterMiniApp  → inside the Base App / Farcaster host wallet.
 *  - coinbaseWallet     → normal web browser (Coinbase Wallet / Smart Wallet).
 *  - injected           → normal web browser (MetaMask, Rabby, …).
 *
 * The page picks the right connector at connect time (mini-app host vs. plain
 * web), so 402.com.tr/app is payable BOTH from the Base App and from any desktop
 * browser with a wallet — no Base App dependency for humans to pay.
 */
export const wagmiConfig = createConfig({
  chains: [base],
  transports: { [base.id]: http() },
  connectors: [
    farcasterMiniApp(),
    coinbaseWallet({ appName: "x402 Bazaar", preference: "all" }),
    injected({ shimDisconnect: true }),
  ],
});
