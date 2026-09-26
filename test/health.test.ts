import { describe, it, expect } from "vitest";
import { errorStatus, timed, readHealth } from "@/lib/health";

describe("errorStatus", () => {
  it("maps the caller's input to 400, upstreams to 502, the rest to 500", () => {
    expect(errorStatus("Provide a NEAR account")).toBe(400);
    expect(errorStatus("No LP data for this token")).toBe(400);
    expect(errorStatus("Refused: ghost.near fails near-token-safety — not charged")).toBe(400);
    expect(errorStatus("NEAR Intents unreachable — not charged, retry shortly")).toBe(502);
    expect(errorStatus("NEAR indexer (NearBlocks) rate limit — not charged")).toBe(502);
    expect(errorStatus("Cannot read properties of undefined")).toBe(500);
  });

  it("does not blame the caller for a provider outage or a refused connection", () => {
    // "provide" once matched "provider", so an outage showed as the caller's input and vanished from /status.
    expect(errorStatus("Transfer history unavailable (data provider) — try again shortly")).toBe(502);
    expect(errorStatus("Liquidity data provider unavailable — try again shortly")).toBe(502);
    expect(errorStatus("connect ECONNREFUSED 1.2.3.4:443")).toBe(502);
    expect(errorStatus("Provide a valid 0x… address")).toBe(400);
  });

  it("classifies the NEAR and swap services' own wording", () => {
    expect(errorStatus("from and to are the same asset")).toBe(400);
    expect(errorStatus("slippage is in basis points: 1–1000 (default 100 = 1%)")).toBe(400);
    expect(errorStatus("That is an EVM address. For a Base token use token-risk")).toBe(400);
    expect(errorStatus("NEAR RPC error (TIMEOUT_ERROR) — not charged, retry shortly")).toBe(502);
    expect(errorStatus("NEAR indexer (NearBlocks) error 500 — not charged, retry shortly")).toBe(502);
  });
});

describe("timed + readHealth", () => {
  it("records ok, input and fail separately; input errors do not count against success", async () => {
    await timed("svc-a", async () => 1);
    await timed("svc-a", async () => 2);
    await expect(timed("svc-a", async () => { throw new Error("amount must be positive"); })).rejects.toThrow();
    await expect(timed("svc-a", async () => { throw new Error("upstream unavailable"); })).rejects.toThrow(/unavailable/);
    const h = (await readHealth(1)).services.find((s) => s.service === "svc-a")!;
    expect(h).toMatchObject({ calls: 4, ok: 2, input: 1, fail: 1, successPct: 66.7, p50: "<0.5s", lastDay: { calls: 4, fail: 1 } });
  });

  it("an answer refused because a feed was down counts as a failure, not a success", async () => {
    await timed("svc-b", async () => ({ receipt: { refundable: true } }));
    await timed("svc-b", async () => ({ receipt: { refundable: false } }));
    const h = (await readHealth(1)).services.find((s) => s.service === "svc-b")!;
    expect(h).toMatchObject({ ok: 1, fail: 1 });
  });
});
