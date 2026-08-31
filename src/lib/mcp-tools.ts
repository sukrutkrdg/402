/**
 * The MCP tool list — built once, served everywhere.
 *
 * There are three places that declare our tools: the hosted endpoint
 * (/api/mcp), the server card (/.well-known/mcp/server-card.json) and the npm
 * stdio package. They are read by different consumers and they have drifted
 * from each other twice:
 *
 *   - The card published `token_risk` while the endpoint served `token-risk`,
 *     so an agent that bound its names from the card missed on every call.
 *   - `outputSchema` and `annotations` were added to the endpoint on 2026-08-30
 *     and the registry quality score did not move for a day, because Smithery
 *     never calls `tools/list` — its publish log reads
 *     `Using .well-known/mcp/server-card.json: (137 tools)`. The card was the
 *     surface being scored, and it was the one surface that had not been
 *     updated.
 *
 * The card's own header claimed it was "generated live from the same catalog…
 * so it never drifts". It was generated from the same catalog and still drifted,
 * because it built its own tool objects. Sharing the catalog is not enough; the
 * builder has to be shared. That is what this module is.
 *
 * The npm package cannot import from here (it ships standalone), so it stays a
 * manual mirror — see the note in mcp/src/index.mjs.
 */

import { SERVICES } from "./services";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: "string"; description?: string }>; required?: string[] };
  outputSchema: object;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

/** Services an outside caller can see. */
export const visibleServices = () => SERVICES.filter((s) => !s.hidden);

/**
 * What every tool returns. Declared loosely and with nothing required: the inner
 * `data` differs per service, and an error path genuinely has no `data`, so
 * promising one would make the schema a claim rather than a contract.
 */
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    service: { type: "string", description: "The service id that answered." },
    data: {
      type: "object",
      description: "The result payload. Shape is service-specific; every field is documented in the tool description.",
    },
    checkedAt: { type: "string", description: "ISO-8601 timestamp of when the underlying reads were taken." },
  },
} as const;

/**
 * Catalog → MCP tool list. One tool per visible service.
 *
 * Names are snake_case: MCP allows `[A-Za-z0-9_-]`, but underscores are what
 * every scorer and most model prompts assume, and the card has always published
 * `token_risk`. The hosted endpoint still accepts both spellings on tools/call
 * so nothing that bound the dashed name breaks.
 */
export function mcpToolList(): McpTool[] {
  return visibleServices().map((s) => {
    const properties: Record<string, { type: "string"; description?: string }> = {};
    const required: string[] = [];
    for (const p of s.params) {
      properties[p.name] = { type: "string", description: p.label };
      if (p.required) required.push(p.name);
    }

    // Rich, self-contained description: purpose (tagline) + the full catalog
    // blurb (stripped of the 🆕 marker) + explicit required inputs + how it is
    // paid. Registries score description quality, and an agent choosing between
    // 137 tools has nothing else to go on.
    const blurb = s.description.replace(/^\s*🆕\s*/u, "").trim();
    const reqNote = required.length ? ` Required input${required.length > 1 ? "s" : ""}: ${required.join(", ")}.` : "";

    // Nearly every endpoint is a read: it answers from live chain or third-party
    // data and changes nothing on the caller's behalf. `buy-credits` is the
    // exception — it takes a USDC payment and mints a token, so calling it
    // read-only and idempotent would invite an agent to retry and pay twice.
    const mutates = s.id === "buy-credits";

    return {
      name: s.id.replace(/-/g, "_"),
      description: `${s.tagline} — ${blurb}${reqNote} Priced ${s.price} per call over x402 on Base; send a prepaid x-credit-token header for unlimited calls, or get 1 free call/day per tool. No wallet or API key required.`,
      inputSchema: { type: "object" as const, properties, ...(required.length ? { required } : {}) },
      outputSchema: OUTPUT_SCHEMA,
      annotations: {
        title: s.name,
        readOnlyHint: !mutates,
        destructiveHint: false,
        idempotentHint: !mutates,
        // Almost every answer comes from live chain or third-party data, not
        // from a closed table.
        openWorldHint: true,
      },
    };
  });
}
