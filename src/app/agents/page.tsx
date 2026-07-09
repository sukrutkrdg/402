import { SERVICES } from "@/lib/services";
import { getSiteUrl } from "@/lib/config";

export const metadata = { title: "For Agents & Developers — x402 Bazaar" };

const SITE_URL = getSiteUrl();

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
        <div className="card mt-1 flex flex-col gap-1 border-base-blue/30 bg-base-blue/10 p-4">
          <div className="text-sm font-semibold text-sky-200">🟦 Works with Base MCP & the Base agent economy</div>
          <p className="text-xs leading-relaxed text-gray-300">
            x402 is a first-class payment rail for Base agents — the same one{" "}
            <strong className="text-gray-200">Base MCP</strong> uses. Drop the{" "}
            <code className="codechip">x402-bazaar-mcp</code> server into any MCP client (or call the
            HTTP endpoints directly) and your agent gets onchain data + AI reports it can pay for
            per-call, right alongside its Base Account actions. No keys held, gasless for the payer.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">⚡ Quickstart — 30 seconds</h2>
        <p className="text-sm text-gray-400">
          Fastest path: add the MCP server to Claude Code (or any MCP client) — one command, then
          just ask it to check a token:
        </p>
        <Code>{`claude mcp add x402-bazaar -e AGENT_PRIVATE_KEY=0xYOUR_KEY -- npx -y x402-bazaar-mcp`}</Code>
        <p className="text-sm text-gray-400">
          Or call any endpoint directly over HTTP — the first call/day per IP is free (no wallet), so
          you can try before wiring payments:
        </p>
        <Code>{`curl "${SITE_URL}/api/x402/${example.id}?${example.params.map((p) => `${p.name}=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed`).join("&")}"`}</Code>
        <p className="text-sm text-gray-400">
          Paying from code (no MCP)? The whole x402 flow is ~10 lines — the SDK handles the 402,
          signs a USDC payment and retries automatically:
        </p>
        <Code>{`import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("${SITE_URL}/api/x402/token-risk?address=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed");
console.log(await res.json()); // verdict + flags — paid in USDC on Base, automatically`}</Code>
        <p className="text-xs text-gray-500">
          After the free daily call you get a teaser preview + an{" "}
          <code className="codechip">HTTP 402</code> — wire the payment below and your agent pays a
          few cents in USDC per call, gasless on Base.
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
        <h2 className="text-lg font-semibold">3. Use as MCP tools (easiest)</h2>
        <p className="text-sm text-gray-400">
          Every service appears as a tool in Claude Desktop, Cursor, or any MCP client — via the
          published{" "}
          <a
            className="text-sky-400 hover:underline"
            href="https://www.npmjs.com/package/x402-bazaar-mcp"
            target="_blank"
            rel="noreferrer"
          >
            x402-bazaar-mcp
          </a>{" "}
          package. No code to write:
        </p>
        <Code>{`{
  "mcpServers": {
    "x402-bazaar": {
      "command": "npx",
      "args": ["-y", "x402-bazaar-mcp"],
      "env": { "AGENT_PRIVATE_KEY": "0xYOUR_BASE_WALLET_KEY" }
    }
  }
}`}</Code>
        <p className="text-xs text-gray-500">
          Add to <code className="codechip">claude_desktop_config.json</code> (or your client&apos;s MCP
          config), restart, and the tools appear. The wallet needs only USDC on Base — the key never
          leaves your machine. Also on the{" "}
          <a
            className="text-sky-400 hover:underline"
            href="https://github.com/sukrutkrdg/x402-bazaar-mcp"
            target="_blank"
            rel="noreferrer"
          >
            GitHub repo
          </a>{" "}
          &amp; the official MCP Registry.
        </p>
        <p className="text-xs text-gray-500">
          Prefer to build your own? See the{" "}
          <a
            className="text-sky-400 hover:underline"
            href="https://github.com/sukrutkrdg/402/tree/main/examples"
            target="_blank"
            rel="noreferrer"
          >
            examples folder
          </a>{" "}
          for a direct <code className="codechip">@x402/fetch</code> caller and a custom AgentKit action.
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
