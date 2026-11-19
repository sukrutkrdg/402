import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Embed token-verdict — x402 Bazaar",
  description:
    "Drop a live SAFE/CAUTION/AVOID token-safety badge into your trading bot, wallet or launchpad in one line. Or install the token-verdict tool in AgentKit, LangChain, CrewAI, ElizaOS, or via MCP/REST.",
  alternates: { canonical: "https://402.com.tr/embed" },
};

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-base-line bg-black/50 p-3 text-[12px] leading-relaxed text-sky-200">
      {children}
    </pre>
  );
}

export default function EmbedPage() {
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-6 text-sm leading-relaxed text-gray-300">
      <header className="flex flex-col gap-2">
        <span className="pill w-fit">⚖️ For platforms</span>
        <h1 className="text-2xl font-bold tracking-tight text-gray-100">
          Put a safety check in front of every buy
        </h1>
        <p className="text-gray-400">
          Give your users a one-glance <strong className="text-gray-200">SAFE / CAUTION / AVOID</strong>{" "}
          verdict for any Base token — so nobody apes into a honeypot. Zero-friction to embed, free to
          trial, $0.03/call at volume, every call attributed onchain.
        </p>
      </header>

      {/* Live badge */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-gray-100">1. The live badge (one line)</h2>
        <p>
          Drop this next to any token address. It renders the live verdict and refreshes itself —
          no API key, no backend:
        </p>
        <Code>{`<img src="https://402.com.tr/embed/badge?address=TOKEN_ADDRESS" alt="token-verdict">`}</Code>
        <div className="flex items-center gap-3 rounded-lg border border-base-line bg-black/30 p-3">
          <span className="text-xs text-gray-500">Live preview:</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/embed/badge?address=${DEGEN}`} alt="token-verdict badge preview" height={22} />
        </div>
        <p>Make it clickable through to the full report:</p>
        <Code>{`<a href="https://402.com.tr/app?token=TOKEN_ADDRESS" target="_blank" rel="noreferrer">
  <img src="https://402.com.tr/embed/badge?address=TOKEN_ADDRESS" alt="token-verdict">
</a>`}</Code>
      </section>

      {/* Agent tools */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-gray-100">2. In your agent / framework</h2>
        <p>token-verdict ships as a drop-in tool for every major agent framework:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-gray-200">Coinbase AgentKit</strong> —{" "}
            <code className="codechip">npm i x402-bazaar-agentkit</code>
          </li>
          <li>
            <strong className="text-gray-200">LangChain</strong> —{" "}
            <code className="codechip">pip install langchain-x402bazaar</code>
          </li>
          <li>
            <strong className="text-gray-200">CrewAI</strong> —{" "}
            <code className="codechip">pip install crewai-x402bazaar</code>
          </li>
          <li>
            <strong className="text-gray-200">ElizaOS</strong> —{" "}
            <code className="codechip">npm i plugin-x402-bazaar</code>
          </li>
          <li>
            <strong className="text-gray-200">MCP</strong> —{" "}
            <code className="codechip">npx x402-bazaar-mcp</code>
          </li>
        </ul>
      </section>

      {/* REST */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-gray-100">3. Plain REST</h2>
        <p>
          One GET. Add <code className="codechip">&amp;free=1</code> for a free daily call while you
          trial; drop it and pay $0.03 in USDC over x402 at volume.
        </p>
        <Code>{`curl "https://402.com.tr/api/x402/token-verdict?address=${DEGEN}&free=1"
# → { "verdict": "CAUTION", "confidence": "high", "headline": "...",
#     "reasons": [...], "recommendedMaxSizeUsd": 4074, "cardUrl": "..." }`}</Code>
      </section>

      <section className="rounded-xl border border-base-blue/30 bg-base-blue/5 p-4">
        <p className="text-gray-300">
          Integrating a bot, wallet or launchpad? We&apos;ll wire a proof-of-concept on your pairs.
          Reach out:{" "}
          <a className="text-sky-400 hover:underline" href="mailto:sukrutkrdg@gmail.com">
            sukrutkrdg@gmail.com
          </a>{" "}
          ·{" "}
          <a className="text-sky-400 hover:underline" href="https://x.com/sukrutkrdg" target="_blank" rel="noreferrer">
            @sukrutkrdg
          </a>
          .
        </p>
      </section>
    </article>
  );
}
