import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * owner-powers: the latent rug surface. Maps GoPlus mutable-control booleans to
 * the concrete attack each enables, and grades the token from renounced_clean to
 * owner_controlled_danger. GoPlus mocked so the mapping/verdict is under test.
 */
const { ucMock } = vi.hoisted(() => ({ ucMock: { goPlusSecurity: vi.fn() } }));
vi.mock("@/lib/upstream-cache", () => ucMock);

import { ownerPowers } from "@/lib/owner-powers";

const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const ZERO = "0x0000000000000000000000000000000000000000";

beforeEach(() => ucMock.goPlusSecurity.mockReset());

describe("owner-powers", () => {
  it("renounced_clean when ownership is truly renounced and no powers remain", async () => {
    ucMock.goPlusSecurity.mockResolvedValue({ is_open_source: "1", owner_address: ZERO });
    const r = await ownerPowers({ address: TOKEN });
    expect(r.verdict).toBe("renounced_clean");
    expect(r.renounceIsReal).toBe(true);
    expect(r.powerCount).toBe(0);
  });

  it("owner_controlled_danger on a critical power (owner can zero your balance)", async () => {
    ucMock.goPlusSecurity.mockResolvedValue({ is_open_source: "1", owner_change_balance: "1", owner_address: "0xowner" });
    const r = await ownerPowers({ address: TOKEN });
    expect(r.verdict).toBe("owner_controlled_danger");
    expect(r.severity.critical).toBe(1);
    expect(r.powers[0].attack).toMatch(/balance/i);
  });

  it("weaponizable when two+ high-severity powers are present", async () => {
    ucMock.goPlusSecurity.mockResolvedValue({ is_open_source: "1", slippage_modifiable: "1", transfer_pausable: "1", owner_address: "0xowner" });
    const r = await ownerPowers({ address: TOKEN });
    expect(r.verdict).toBe("weaponizable");
    expect(r.severity.high).toBeGreaterThanOrEqual(2);
  });

  it("a reclaimable renounce is not a real renounce", async () => {
    ucMock.goPlusSecurity.mockResolvedValue({ is_open_source: "1", owner_address: ZERO, can_take_back_ownership: "1" });
    const r = await ownerPowers({ address: TOKEN });
    expect(r.ownershipRenounced).toBe(true);
    expect(r.renounceIsReal).toBe(false);
  });

  it("unverified source is itself a high-severity threat", async () => {
    ucMock.goPlusSecurity.mockResolvedValue({ is_open_source: "0", owner_address: "0xowner" });
    const r = await ownerPowers({ address: TOKEN });
    expect(r.isOpenSource).toBe(false);
    expect(r.powers.some((p) => p.flag === "not_open_source")).toBe(true);
  });

  it("does not charge when GoPlus is unavailable", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(null);
    await expect(ownerPowers({ address: TOKEN })).rejects.toThrow(/not charged/);
  });

  it("treats empty security data as unknown, not safe", async () => {
    ucMock.goPlusSecurity.mockResolvedValue({});
    await expect(ownerPowers({ address: TOKEN })).rejects.toThrow(/unknown/i);
  });
});
