# Go-to-market / submission copy

Ready-to-paste text for getting x402 Bazaar discovered by agents and humans.
Everything here is copy-paste — no code changes needed.

---

## 1. npm publish (the MCP server)

```bash
cd mcp
npm login
npm publish --access public
npm view x402-bazaar-mcp   # verify
```

---

## 2. awesome-x402 (GitHub PR)

Repo: https://github.com/xpaysh/awesome-x402 — fork it, add the lines below under
the most fitting sections (e.g. "Services" / "Resource Servers" and "MCP"), open a PR.

**Service / resource server entry:**
```markdown
- [x402 Bazaar](https://402.com.tr) — Pay-per-call API marketplace on Base. Onchain risk/intel (token risk, address intel, gas, price, tx decode) + AI utilities (summarize/extract/translate). USDC micro-payments, free trial tier, machine-readable catalog at `/.well-known/x402`.
```

**MCP entry:**
```markdown
- [x402-bazaar-mcp](https://www.npmjs.com/package/x402-bazaar-mcp) — MCP server exposing x402 Bazaar's paid Base APIs as agent tools; pays per call in USDC. `npx x402-bazaar-mcp`.
```

---

## 3. MCP registries (after npm publish)

- **glama.ai/mcp** — sign in with GitHub; it auto-indexes public MCP packages. Claim/submit `x402-bazaar-mcp`.
- **smithery.ai** — sign in with GitHub → Add server. Uses `mcp/smithery.yaml` (in this repo).
- **mcp.so** — submit via the site's add/submit form.
- **registry.modelcontextprotocol.io** (official) — optional; follow their publish flow.

**One-line description for any registry:**
```
Call paid Base APIs (token risk, prices, gas, AI utilities) from your agent — pay per call in USDC over x402, no API keys.
```

---

## 4. x402 Bazaar (automatic — no form)

Already wired in code (bazaarResourceServerExtension + per-route discovery).
Each endpoint is indexed by the CDP facilitator after its first settled payment,
then shows up on https://www.x402scan.com/ . Bootstrap: let the first real agent
payments flow, or trigger one paid call per endpoint.

---

## 5. Farcaster cast (announcement)

```
Just shipped x402 Bazaar on Base 🟦

Pay-per-call APIs for agents — no API keys, no signup. Your agent pays in USDC over x402.

🛡️ Token risk / honeypot checks
📊 Prices, gas, wallet intel, tx decode
🧠 AI summarize / extract / translate

MCP-ready: npx x402-bazaar-mcp
→ https://402.com.tr/agents
```

---

## 6. Where to share

- Base Discord (#developers / showcase)
- x402 / Coinbase Developer Platform communities
- AI agent builder communities (MCP, autonomous agents)
- A short GitHub README / blog post → indexed by Google + AI crawlers (which read `/llms.txt`)
