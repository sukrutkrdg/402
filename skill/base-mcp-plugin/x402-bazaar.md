---
title: "x402 Bazaar Plugin"
description: "The onchain intelligence layer for Base agents: 43+ read-only APIs — token safety & rug detection, wallet net worth/age/risk, OFAC sanctions screening, prices & momentum, NFTs — plus two Claude-written AI reports (token & wallet). Reached via the x402-bazaar-mcp server; paid per call in USDC over x402. Returns data only — no transactions (Submission: none)."
tags: [data, token-risk, wallet-intel, compliance, x402]
name: x402-bazaar
version: 0.1.0
integration: external-mcp
chains: [base]
requires:
  shell: none
  allowlist: []
  externalMcp: x402-bazaar-mcp
  cliPackage: null
auth: none
risk: []
---

# x402 Bazaar Plugin

> [!IMPORTANT]
> Run Base MCP onboarding first (see SKILL.md). This plugin is read-only — it
> returns intelligence the user/agent can act on; it never builds a transaction.

## Overview

**x402 Bazaar is the onchain intelligence layer for Base agents** — the data an
agent should consult *before* it acts. It exposes **43+ read-only services** on
Base across five areas:

- **Token safety** — risk score, honeypot/tax checks, holder concentration,
  **rug-probability score**, contract verification/ABI.
- **Wallet intelligence** — net worth (accurate USD), age & activity (sybil/rug
  screening), token approvals (allowance risk), transfers, NFT holdings.
- **Compliance** — OFAC sanctions screening (single & batch), combined verdict.
- **Markets** — price, 1h/6h/24h momentum, pools, historical price, trending &
  newly-listed tokens, gas & chain status.
- **AI flagships (Claude-written)** — **AI Token Report** and **AI Wallet
  Report**: aggregate the raw signals into a single structured verdict with
  reasons (the kind of synthesis you can't get from a raw data feed).

Reached through the **`x402-bazaar-mcp`** server (also on the official MCP
registry). Each call settles a tiny **USDC micro-payment over x402** on Base —
no API keys, gasless for the payer, and the wallet key never leaves the caller's
machine. Every settlement is attributed onchain via Builder Codes (ERC-8021).

It complements Base MCP cleanly: **Base MCP lets an agent *act*; x402 Bazaar lets
it *know what to act on*.** No onchain transaction is produced here, so there is
no `send_calls` handoff — this is a pure read/intelligence skill.

## Detection

Consider this plugin available when the host has the `x402-bazaar` MCP server
connected (tools prefixed `x402-bazaar` / e.g. `token_risk`, `ai_token_report`,
`wallet_networth`). The agent reads the MCP's own tool catalog at runtime; the
live service list is also at `https://402.com.tr/.well-known/x402`.

## Installation

Add the MCP server to the host config (Claude Desktop / Cursor / any MCP client):

```json
{
  "mcpServers": {
    "x402-bazaar": {
      "command": "npx",
      "args": ["-y", "x402-bazaar-mcp"],
      "env": { "AGENT_PRIVATE_KEY": "0xYOUR_BASE_WALLET_KEY" }
    }
  }
}
```

The wallet needs only USDC on Base. Package: `x402-bazaar-mcp` (npm) ·
registry `io.github.sukrutkrdg/x402-bazaar-mcp`.

## Surface Routing

| Capability | Surface | Execution path |
|---|---|---|
| Any read (token/wallet/compliance/AI report) | MCP client (Claude Desktop, Cursor, Code) | `x402-bazaar` MCP tool → pays x402 → returns JSON |
| Same | chat-only host without the MCP server | Not available — instruct the user to add `x402-bazaar-mcp` (see Installation) |

Shell-less fallback: none required — all access is via the MCP server's tools.

## Orchestration

1. Confirm the `x402-bazaar` MCP server is connected (Detection); if not, point the user to Installation.
2. Pick the tool matching the user's intent (e.g. `ai_token_report` for "is this token safe?", `wallet_networth` for "what's in this wallet?", `sanctions` for OFAC screening).
3. Call the tool with the address/params; the server settles the x402 USDC micro-payment and returns JSON.
4. Use the returned data in the answer. If the user then wants to act (swap, send), hand that off to Base MCP separately — this plugin does not transact.

## Submission

Tool: `none`. This plugin is read-only; it returns data and never calls a Base
MCP submission tool (`send_calls`/`swap`/`sign`).

## Example Prompts

1. "Is `0x…` a safe token to buy on Base?" → call `ai_token_report` (or `token_risk` + `rug_score` + `token_price`), summarize the verdict and risks.
2. "Before I swap into `0x…`, check it's safe and not sanctioned." → run `ai_token_report` + `sanctions`; only if it's clear, hand the swap off to Base MCP.
3. "Profile wallet `0x…` — net worth, age, what can drain it." → call `wallet_networth`, `wallet_summary`, `token_approvals`; summarize risk.
4. "Is this counterparty `0x…` OK to send funds to?" → call `compliance_check`; report blocked / review / clear.
5. "What's the 24h price & momentum of `0x…`?" → call `token_momentum`; report price and 1h/6h/24h change.
6. "Give me a verdict on wallet `0x…` — sybil or established?" → call `ai_wallet_report`.
