import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A note in a paid response is the only channel that reaches whoever runs an
 * agent — there is no email on a wallet. It is also the easiest thing to ruin:
 * a caller who learns our payloads carry filler starts skipping fields that
 * matter, and they are paying for the bytes.
 *
 * So the rules are the test: not on a first call, not twice, never at the cost
 * of the response, and nothing in it that is not cheaper for them.
 */
const { kvMock, usageMock } = vi.hoisted(() => ({
  kvMock: { kvGet: vi.fn(), kvSet: vi.fn() },
  usageMock: { getPayerServices: vi.fn() },
}));
vi.mock("@/lib/kv", () => kvMock);
vi.mock("@/lib/usage", () => usageMock);

import { returningCallerNote } from "@/lib/repeat-caller";

const HASH = "a1b2c3";
const ORIGIN = "https://402.com.tr";

describe("returningCallerNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvGet.mockResolvedValue(null);
    kvMock.kvSet.mockResolvedValue(undefined);
  });

  it("says nothing to a first-time caller", async () => {
    usageMock.getPayerServices.mockResolvedValue({ "token-risk": 1 });
    expect(await returningCallerNote("token-risk", HASH, ORIGIN)).toBeNull();
    expect(kvMock.kvSet).not.toHaveBeenCalled();
  });

  it("appears once several calls in, counting across services", async () => {
    // A workflow that buys three different checks is a returning caller just as
    // much as one that buys the same check three times.
    usageMock.getPayerServices.mockResolvedValue({ "token-risk": 1, sanctions: 1, "safe-to-send": 1 });
    const note = await returningCallerNote("token-risk", HASH, ORIGIN);
    expect(note).not.toBeNull();
    expect(note!.callsSoFar).toBe(3);
    expect(note!.cheaper).toContain("buy-credits");
    expect(note!.contact).toContain("@");
  });

  it("never appears twice", async () => {
    usageMock.getPayerServices.mockResolvedValue({ "token-risk": 9 });
    kvMock.kvGet.mockResolvedValue("1"); // already noted
    expect(await returningCallerNote("token-risk", HASH, ORIGIN)).toBeNull();
  });

  it("claims the flag before returning, so two calls cannot both attach it", async () => {
    usageMock.getPayerServices.mockResolvedValue({ "token-risk": 5 });
    await returningCallerNote("token-risk", HASH, ORIGIN);
    expect(kvMock.kvSet).toHaveBeenCalledWith(expect.stringContaining(HASH), "1", expect.any(Number));
  });

  it("points at the batch endpoint when one exists", async () => {
    usageMock.getPayerServices.mockResolvedValue({ "token-risk": 5 });
    const note = await returningCallerNote("token-risk", HASH, ORIGIN);
    expect(note!.batch).toContain("batch-risk");
    // And omits it rather than inventing one where none exists.
    kvMock.kvGet.mockResolvedValue(null);
    const other = await returningCallerNote("gas-oracle", HASH, ORIGIN);
    expect(other!.batch).toBeUndefined();
  });

  it("stays silent when there is no payer, and survives a broken ledger", async () => {
    expect(await returningCallerNote("token-risk", "", ORIGIN)).toBeNull();
    usageMock.getPayerServices.mockRejectedValue(new Error("kv down"));
    expect(await returningCallerNote("token-risk", HASH, ORIGIN)).toBeNull();
  });
});
