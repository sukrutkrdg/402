/**
 * The three tool-declaring surfaces must not drift.
 *
 * They have drifted twice. Once on naming: the card published `token_risk`
 * while the hosted endpoint served `token-risk`, so an agent that bound its
 * names from the card missed on every call. Once on schema: `outputSchema` and
 * `annotations` were added to the hosted endpoint and the registry score did not
 * move, because Smithery reads the card
 * (`Using .well-known/mcp/server-card.json: (137 tools)`) and never calls
 * tools/list. Both times the code was correct somewhere and scored somewhere
 * else.
 *
 * These tests assert the properties a registry actually reads, so the next
 * change to the builder cannot quietly drop them again.
 */

import { describe, it, expect } from "vitest";
import { mcpToolList } from "@/lib/mcp-tools";
import { GET as serverCard } from "@/app/api/mcp-server-card/route";

describe("mcp tool surfaces", () => {
  it("declares an output schema and annotations on every tool", () => {
    const tools = mcpToolList();
    expect(tools.length).toBeGreaterThan(100);
    for (const t of tools) {
      expect(t.outputSchema, `${t.name} has no outputSchema`).toBeTruthy();
      expect(t.annotations, `${t.name} has no annotations`).toBeTruthy();
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
    }
  });

  it("promises no output field it does not always return", () => {
    // An error path genuinely has no `data`; a required field we sometimes omit
    // would make the schema a claim rather than a contract.
    for (const t of mcpToolList()) {
      expect(t.outputSchema).not.toHaveProperty("required");
    }
  });

  it("does not call buy_credits read-only or idempotent", () => {
    // It takes a USDC payment and mints a token. Telling an agent it is safe to
    // retry invites a second payment for one intent.
    const buy = mcpToolList().find((t) => t.name === "buy_credits");
    expect(buy, "buy_credits missing from the tool list").toBeTruthy();
    expect(buy!.annotations.readOnlyHint).toBe(false);
    expect(buy!.annotations.idempotentHint).toBe(false);
  });

  it("uses snake_case names, which is what the card has always published", () => {
    for (const t of mcpToolList()) expect(t.name).toMatch(/^[a-z0-9_]+$/);
  });

  it("serves the same tools on the server card as the endpoint lists", async () => {
    const card = await serverCard().json();
    const listed = mcpToolList();
    expect(card.tools).toHaveLength(listed.length);
    expect(card.tools.map((t: { name: string }) => t.name)).toEqual(listed.map((t) => t.name));
    // The registry scores the card, so assert the scored fields on the card
    // itself rather than trusting that it shares a builder.
    for (const t of card.tools) {
      expect(t.outputSchema, `card: ${t.name} has no outputSchema`).toBeTruthy();
      expect(t.annotations, `card: ${t.name} has no annotations`).toBeTruthy();
    }
  });
});
