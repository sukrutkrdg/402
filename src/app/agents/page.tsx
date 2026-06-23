import { SERVICES } from "@/lib/services";

export const metadata = { title: "For Agents & Developers — x402 Bazaar" };

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://402-eight.vercel.app").replace(
  /\/$/,
  "",
);

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-auto rounded-xl border border-base-line bg-black/50 p-4 text-[12px] leading-relaxed text-sky-200">
      {children}
    </pre>
  );
}

export default function AgentsPage() {
  const example = SERVICES[0];
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">🤖 For agents & developers</span>
        <h1 className="text-3xl font-bold tracking-tight">Call these APIs from your agent</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">
          Every service here is a standard HTTP endpoint protected by{" "}
          <strong className="text-gray-200">x402</strong>. No API keys, no sign-up, no subscription —
          your agent pays a tiny USDC micro-payment per call on Base and gets the result. Built for
          autonomous agents and bots.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">1. Discover services (machine-readable)</h2>
        <p className="text-sm text-gray-400">
          Crawl the catalog for every endpoint, price, and input schema:
        </p>
        <Code>{`GET ${SITE_URL}/.well-known/x402
GET ${SITE_URL}/api/catalog`}</Code>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">2. Call an endpoint with x402</h2>
        <p className="text-sm text-gray-400">
          Hit the endpoint, get a <code className="codechip">402</code>, pay, and the SDK retries
          automatically. Example with <code className="codechip">@x402/fetch</code>:
        </p>
        <Code>{`import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY); // holds USDC on Base
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(account));
const fetchWithPay = wrapFetchWithPayment(fetch, client);

// Example: ${example.name} (${example.price})
const res = await fetchWithPay(
  "${SITE_URL}/api/x402/${example.id}?${example.params.map((p) => `${p.name}=...`).join("&")}"
);
console.log(await res.json());`}</Code>
        <p className="text-xs text-gray-500">
          The agent wallet needs only USDC on Base — gas is paid by the facilitator (x402 is
          gasless for the payer).
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">3. Use as MCP tools</h2>
        <p className="text-sm text-gray-400">
          Drop this minimal MCP server into your agent (Claude Desktop, Cursor, custom) to expose
          these endpoints as tools your model can call. It pays per call with your wallet:
        </p>
        <Code>{`// x402-bazaar-mcp.mjs — run with: node x402-bazaar-mcp.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(account));
const pay = wrapFetchWithPayment(fetch, client);

const server = new McpServer({ name: "x402-bazaar", version: "1.0.0" });

// Auto-register every service from the live catalog as a tool
const catalog = await (await fetch("${SITE_URL}/api/catalog")).json();
for (const s of catalog.services) {
  server.tool(s.id.replace(/-/g, "_"), s.description,
    Object.fromEntries(Object.keys(s.input).map((k) => [k, z.string()])),
    async (args) => {
      const url = new URL(s.endpoint);
      for (const [k, v] of Object.entries(args)) if (v) url.searchParams.set(k, v);
      const r = await pay(url.toString());
      return { content: [{ type: "text", text: await r.text() }] };
    });
}
await server.connect(new StdioServerTransport());`}</Code>
        <p className="text-xs text-gray-500">
          Needs <code className="codechip">@modelcontextprotocol/sdk</code>,{" "}
          <code className="codechip">@x402/fetch</code>, <code className="codechip">@x402/evm</code>,{" "}
          <code className="codechip">viem</code>, <code className="codechip">zod</code>. Set{" "}
          <code className="codechip">AGENT_PRIVATE_KEY</code> to a Base wallet funded with USDC.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Available services</h2>
        <div className="card divide-y divide-base-line/60">
          {SERVICES.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {s.icon} {s.name}
                </div>
                <div className="truncate font-mono text-[11px] text-gray-500">/api/x402/{s.id}</div>
              </div>
              <span className="font-mono text-xs text-emerald-300">{s.price}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
