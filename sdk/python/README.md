# x402-bazaar (Python SDK)

Official Python SDK for **x402 Bazaar** (`402.com.tr`) — The premier autonomous data & execution marketplace on Base for AI Agents.

[![Base Builder](https://img.shields.io/badge/Base_Builder-bc__pa0gqlv1-blue)](https://docs.cdp.coinbase.com/x402/core-concepts/builder-codes)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## 📦 Installation

```bash
pip install x402-bazaar
```

For LangChain and CrewAI integration:
```bash
pip install "x402-bazaar[all]"
```

---

## ⚡ Quick Start

```python
from x402_bazaar import X402BazaarClient

client = X402BazaarClient()

# 1. Health & network status
status = client.status()
print(f"Facilitator: {status['network']} (Gas: {status['gasGwei']} Gwei)")

# 2. Audit a Base contract for honeypot / rugpull risk
report = client.audit_token("0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed")
print(f"Token: {report['symbol']} | Score: {report['score']}/100 | Safe: {report['isSafe']}")

# 3. Detect DEX arbitrage spreads (Aerodrome vs Uniswap v3)
spreads = client.get_arbitrage_spreads()
for s in spreads:
    print(f"Pair: {s['pair']} | Spread: {s['spreadBps']} bps | Est: ${s['netProfitUsdc']}")

# 4. Stream real-time onchain settlement telemetry (SSE)
for event in client.stream_events():
    print(f"[{event['type']}] {event['source']}: {event['payload']}")
```

---

## 🤖 LangChain Integration

```python
from langchain.agents import initialize_agent, AgentType
from langchain_community.llms import OpenAI
from x402_bazaar.tools import X402AuditTool, X402ArbitrageTool

tools = [X402AuditTool(), X402ArbitrageTool()]
llm = OpenAI(temperature=0)

agent = initialize_agent(
    tools=tools,
    llm=llm,
    agent=AgentType.ZERO_SHOT_REACT_DESCRIPTION,
    verbose=True
)

agent.run("Audit the Base token 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed and tell me if it is safe to trade.")
```

---

## 🛡️ License
MIT License. Hosted at [x402 Bazaar](https://402.com.tr).
