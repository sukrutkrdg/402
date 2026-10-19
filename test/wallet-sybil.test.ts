import { describe, expect, it } from "vitest";
import { walletSybilScore } from "../src/lib/wallet-sybil";

describe("wallet-sybil-score", () => {
  it("throws error if address is missing", async () => {
    await expect(walletSybilScore({})).rejects.toThrow("Missing wallet address");
  });
});
