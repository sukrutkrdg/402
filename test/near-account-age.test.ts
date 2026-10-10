import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * near-account-age: creation date (age) + creator (provenance) + deletion status
 * from NearBlocks. The indexer is mocked (account call, then best-effort txns
 * call) so the age classification + creator lookup are what's under test.
 */
const { nbMock } = vi.hoisted(() => ({ nbMock: { nearblocks: vi.fn() } }));
vi.mock("@/lib/nearblocks", () => ({
  nearblocks: nbMock.nearblocks,
  nsToIso: (ns: unknown) => { const s = String(ns ?? ""); return /^\d{13,}$/.test(s) ? new Date(Number(s.slice(0, s.length - 6))).toISOString() : null; },
}));

import { nearAccountAge } from "@/lib/near-account-age";

const daysAgoNs = (d: number) => String(Date.now() - d * 86_400_000) + "000000";

// account call resolves first; the txns (creator) call resolves second.
function feed(createdNs: string | null, creator: string | null = null, deletedNs: string | null = null) {
  const acct = createdNs === null
    ? { account: [{}] }
    : { account: [{ created: { transaction_hash: "cHash", block_timestamp: createdNs }, deleted: { transaction_hash: deletedNs ? "dHash" : null, block_timestamp: deletedNs } }] };
  nbMock.nearblocks.mockResolvedValueOnce(acct);
  if (createdNs !== null) nbMock.nearblocks.mockResolvedValueOnce({ txns: creator ? [{ signer_account_id: creator }] : [] });
}

beforeEach(() => nbMock.nearblocks.mockReset());

describe("near-account-age", () => {
  it("brand_new for an account created today, with creator", async () => {
    feed(daysAgoNs(0), "real_og.near");
    const r = await nearAccountAge({ account: "fresh.near" });
    expect(r.verdict).toBe("brand_new");
    expect(r.creator).toBe("real_og.near");
    expect(r.creatorType).toBe("account");
  });

  it("mature + system creator for an old registrar-made account", async () => {
    feed(daysAgoNs(800), "near");
    const r = await nearAccountAge({ account: "old.near" });
    expect(r.verdict).toBe("mature");
    expect(r.creatorType).toBe("system");
  });

  it("new for ~2 weeks old", async () => {
    feed(daysAgoNs(14));
    const r = await nearAccountAge({ account: "two.near" });
    expect(r.verdict).toBe("new");
  });

  it("deleted when the account was deleted", async () => {
    feed(daysAgoNs(100), null, daysAgoNs(2));
    const r = await nearAccountAge({ account: "gone.near" });
    expect(r.verdict).toBe("deleted");
    expect(r.deleted).toBe(true);
  });

  it("not_created when there is no creation record", async () => {
    feed(null);
    const r = await nearAccountAge({ account: "ghost.near" });
    expect(r.verdict).toBe("not_created");
  });

  it("age still returned if the creator lookup fails (best-effort)", async () => {
    nbMock.nearblocks
      .mockResolvedValueOnce({ account: [{ created: { transaction_hash: "cHash", block_timestamp: daysAgoNs(500) }, deleted: {} }] })
      .mockRejectedValueOnce(new Error("tx lookup down"));
    const r = await nearAccountAge({ account: "x.near" });
    expect(r.verdict).toBe("mature");
    expect(r.creator).toBeNull();
  });

  it("rejects a bad account id", async () => {
    await expect(nearAccountAge({ account: "BAD CAPS!!" })).rejects.toThrow(/NEAR account/i);
  });
});
