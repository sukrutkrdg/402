# x402 Bazaar LangChain Integration

This SDK allows you to easily connect LangChain agents to the x402 Bazaar marketplace.

## Installation

```bash
npm install x402-bazaar-langchain
```

## Usage

```typescript
import { createX402BazaarTool } from "x402-bazaar-langchain";

// Pass in your Base API credit token, OR a signer (for direct x402 EVM payments)
const x402Tool = createX402BazaarTool({
  baseUrl: "https://402.com.tr",
  creditToken: "ck_..." // Example: Using a prepaid credit token
});

// Add to your LangChain tools array and bind it to an LLM
const tools = [x402Tool];
// const agent = createToolCallingAgent({ llm, tools, prompt });
```
