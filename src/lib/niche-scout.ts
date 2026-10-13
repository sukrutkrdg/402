export interface NicheScoutFeed {
  id: string;
  title: string;
  category: "ZK_ML_AI" | "CROSS_CHAIN_MEV" | "FORENSIC_SECURITY" | "REAL_WORLD_ORACLE";
  popularityRank: number;
  status: "INDEXED_NATIVE" | "PROXIED_X402" | "BOUNTY_REQUESTED";
  nativeServiceMatch?: string;
  description: string;
  targetPriceUsdc: number;
}

export const NICHE_SCOUT_FEEDS: NicheScoutFeed[] = [
  {
    id: "niche-clanker-audit",
    title: "Clanker Deployer Forensic & HoneyPot Audit",
    category: "FORENSIC_SECURITY",
    popularityRank: 1,
    status: "INDEXED_NATIVE",
    nativeServiceMatch: "clanker-token-audit",
    description: "Deep byte-code disassembly of newly launched Clanker & Farcaster tokens to prevent honeypots.",
    targetPriceUsdc: 0.05,
  },
  {
    id: "niche-polymarket-alpha",
    title: "Polymarket Event Probability & Volume Skew",
    category: "REAL_WORLD_ORACLE",
    popularityRank: 2,
    status: "INDEXED_NATIVE",
    nativeServiceMatch: "polymarket-odds",
    description: "Real-time orderbook depth and predictive probabilities on world events, elections, and tech shifts.",
    targetPriceUsdc: 0.02,
  },
  {
    id: "niche-aerodrome-cl-rebalancer",
    title: "Aerodrome Concentrated Liquidity Tick Oracle",
    category: "CROSS_CHAIN_MEV",
    popularityRank: 3,
    status: "INDEXED_NATIVE",
    nativeServiceMatch: "dex-spread",
    description: "Optimal narrow tick ranges and fee APY capture projections for autonomous LP rebalancers.",
    targetPriceUsdc: 0.02,
  },
  {
    id: "niche-farcaster-sentiment",
    title: "Farcaster Social Velocity & Organic Momentum",
    category: "REAL_WORLD_ORACLE",
    popularityRank: 4,
    status: "INDEXED_NATIVE",
    nativeServiceMatch: "farcaster-social-velocity",
    description: "Cast velocity, bot-filtered mentions, and key influencer quote analysis across the Base social graph.",
    targetPriceUsdc: 0.03,
  },
  {
    id: "niche-near-intents-bridge",
    title: "NEAR 1-Click Cross-Chain Intents Fast Bridge",
    category: "CROSS_CHAIN_MEV",
    popularityRank: 5,
    status: "INDEXED_NATIVE",
    nativeServiceMatch: "near-swap-quote",
    description: "Zero-slippage intent-driven swaps settling from Bitcoin, Solana, and NEAR into Base USDC.",
    targetPriceUsdc: 0.01,
  },
  {
    id: "niche-zk-proof-verifier",
    title: "Zero-Knowledge State Proof Verifier for AI Agents",
    category: "ZK_ML_AI",
    popularityRank: 6,
    status: "PROXIED_X402",
    description: "Groth16 & Plonk ZK-SNARK proof verification for decentralized agent inference validation.",
    targetPriceUsdc: 0.04,
  },
  {
    id: "niche-satellite-weather-oracle",
    title: "Hyper-Local Precipitation & Solar Micro-Oracle",
    category: "REAL_WORLD_ORACLE",
    popularityRank: 7,
    status: "BOUNTY_REQUESTED",
    description: "Sub-kilometer meteorological feeds for decentralized parametric catastrophe insurance bots.",
    targetPriceUsdc: 0.01,
  },
];
