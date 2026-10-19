import { describe, expect, it } from "vitest";
import { treasuryHealth } from "../src/lib/treasury-health";

describe("treasury-health", () => {
  it("throws error if address is missing", async () => {
    await expect(treasuryHealth({})).rejects.toThrow("Missing treasury address");
  });
});
