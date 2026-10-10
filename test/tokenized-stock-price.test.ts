import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * tokenized-stock-price: roster directory + live onchain price of a Coinbase
 * tokenized equity. DexScreener mocked; the roster is real.
 */
const { ucMock } = vi.hoisted(() => ({ ucMock: { dexTokenPairs: vi.fn() } }));
vi.mock("@/lib/upstream-cache", () => ucMock);

import { tokenizedStockPrice } from "@/lib/tokenized-stock-price";
import { TOKENIZED_STOCKS } from "@/lib/tokenized-stocks";

const AAPL = TOKENIZED_STOCKS.find((s) => s.ticker === "AAPL")!;

function pool(liq: number, price = "230.5", change = 1.2) {
  return [{ baseToken: { address: AAPL.token.toLowerCase() }, quoteToken: { symbol: "USDC" }, dexId: "aerodrome", pairAddress: "0xp", priceUsd: price, liquidity: { usd: liq }, volume: { h24: 10000 }, priceChange: { h24: change } }];
}

beforeEach(() => ucMock.dexTokenPairs.mockReset());

describe("tokenized-stock-price", () => {
  it("directory mode lists every tracked stock, no upstream call", async () => {
    const r = await tokenizedStockPrice({});
    expect(r.mode).toBe("directory");
    expect(r.count).toBe(TOKENIZED_STOCKS.length);
    expect(ucMock.dexTokenPairs).not.toHaveBeenCalled();
  });

  it("prices a liquid tokenized stock by ticker", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(pool(200_000));
    const r = (await tokenizedStockPrice({ symbol: "AAPL" })) as Record<string, unknown>;
    expect(r.verdict).toBe("liquid");
    expect(r.priceUsd).toBe(230.5);
    expect(r.ticker).toBe("AAPL");
  });

  it("accepts the on-chain symbol form (AAPLc)", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(pool(80_000));
    const r = (await tokenizedStockPrice({ symbol: "AAPLc" })) as Record<string, unknown>;
    expect(r.ticker).toBe("AAPL");
    expect(r.verdict).toBe("liquid");
  });

  it("flags a thin market", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(pool(8_000));
    const r = await tokenizedStockPrice({ symbol: "AAPL" });
    expect(r.verdict).toBe("thin");
  });

  it("not_trading when there is no pool", async () => {
    ucMock.dexTokenPairs.mockResolvedValue([]);
    const r = await tokenizedStockPrice({ symbol: "AAPL" });
    expect(r.verdict).toBe("not_trading");
  });

  it("unknown_ticker for a non-tokenized symbol", async () => {
    const r = await tokenizedStockPrice({ symbol: "ZZZZ" });
    expect(r.verdict).toBe("unknown_ticker");
  });

  it("does not charge when DexScreener is unavailable", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(null);
    await expect(tokenizedStockPrice({ symbol: "AAPL" })).rejects.toThrow(/not charged/);
  });
});
