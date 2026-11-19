import { describe, it, expect, vi, beforeEach } from "vitest";

const { readMock, rugMock, sellMock, shieldMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  rugMock: vi.fn(),
  sellMock: vi.fn(),
  shieldMock: vi.fn(),
}));
vi.mock("@/lib/solana/token-reads", () => ({
  readSplMint: readMock,
  rugcheckSummary: rugMock,
  jupiterSell: sellMock,
  jupiterShield: shieldMock,
}));

import { solTokenVerdict } from "@/lib/sol-token-verdict";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function mint(over: Record<string, unknown> = {}) {
  return { program: "spl-token", mintAuthority: null, freezeAuthority: null, decimals: 5, supply: "1", extensions: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  rugMock.mockResolvedValue({ scoreNormalised: 5, lpLockedPct: 100, risks: [] });
  sellMock.mockResolvedValue({ sellable: true, priceImpactPct: 0.1 });
  shieldMock.mockResolvedValue([]);
});

describe("sol-token-verdict", () => {
  it("rejects a non-base58 mint before any read", async () => {
    await expect(solTokenVerdict({ mint: "0xabc" })).rejects.toThrow(/valid Solana/i);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("clean token (authorities renounced, sellable, LP locked) → SAFE", async () => {
    readMock.mockResolvedValue(mint());
    const r = await solTokenVerdict({ mint: BONK });
    expect(r.verdict).toBe("SAFE");
    expect(r.receipt.refundable).toBe(false);
  });

  it("freeze authority active → CAUTION", async () => {
    readMock.mockResolvedValue(mint({ freezeAuthority: "Fr33zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }));
    const r = await solTokenVerdict({ mint: BONK });
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons.join(" ")).toMatch(/freeze authority/i);
  });

  it("Token-2022 permanent delegate → AVOID (seize)", async () => {
    readMock.mockResolvedValue(mint({ program: "spl-token-2022", extensions: [{ type: "permanentDelegate" }] }));
    const r = await solTokenVerdict({ mint: BONK });
    expect(r.verdict).toBe("AVOID");
    expect(r.recommendedMaxSizeUsd).toBe(0);
  });

  it("buyable but not sellable + freeze authority → AVOID (honeypot)", async () => {
    readMock.mockResolvedValue(mint({ freezeAuthority: "Fr33zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }));
    sellMock.mockResolvedValue({ sellable: false, priceImpactPct: null });
    const r = await solTokenVerdict({ mint: BONK });
    expect(r.verdict).toBe("AVOID");
    expect(r.reasons.join(" ")).toMatch(/honeypot/i);
  });

  it("mint read fails → UNKNOWN and refundable (not charged)", async () => {
    readMock.mockRejectedValue(new Error("RPC down"));
    const r = await solTokenVerdict({ mint: BONK });
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.receipt.refundable).toBe(true);
  });

  it("degrades confidence to medium when a secondary source is missing", async () => {
    readMock.mockResolvedValue(mint());
    sellMock.mockResolvedValue(null); // jupiter down
    const r = await solTokenVerdict({ mint: BONK });
    expect(r.confidence).toBe("medium");
  });
});
