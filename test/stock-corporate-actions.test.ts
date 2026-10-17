import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/covalent", () => ({ cdpSql: vi.fn() }));
vi.mock("@/lib/kv", () => ({ kvGet: vi.fn(async () => null), kvSet: vi.fn(async () => {}) }));

import { foldActions, applyRecord, accrualPct, baseActionId } from "@/lib/stock-corporate-actions";
import { apiStocksToRoster, mergeRoster, type TokenizedStock } from "@/lib/tokenized-stocks";

const NVDA: TokenizedStock = { sym: "NVDAc", ticker: "NVDA", name: "NVIDIA", token: "0xb20000000000000000000078ee7ce2fe4908108c" };
const MU: TokenizedStock = { sym: "MUc", ticker: "MU", name: "Micron", token: "0xb200000000000000000000fd2f87532b90095211" };
const byAddr = new Map([NVDA, MU].map((s) => [s.token, s]));

// Shapes copied from the warehouse on 2026-10-17.
const rows: Array<{ address: string; event_name: string; parameters: Record<string, string>; transaction_hash: string; block_timestamp: string }> = [
  { address: MU.token, event_name: "Announcement", parameters: { description: "Cash Dividend", id: "2937:pre", uri: "u/2937" }, transaction_hash: "0xmu", block_timestamp: "2026-10-02T01:38:15.000Z" },
  { address: NVDA.token, event_name: "MultiplierUpdated", parameters: { multiplier: "1000537939576369481" }, transaction_hash: "0xnv", block_timestamp: "2026-10-01T16:47:47.000Z" },
  { address: NVDA.token, event_name: "Announcement", parameters: { description: "Cash Dividend", id: "0d25", uri: "u/0d25" }, transaction_hash: "0xnv", block_timestamp: "2026-10-01T16:47:47.000Z" },
];

describe("stock corporate actions", () => {
  it("a :pre announcement is pending; an un-suffixed one in the multiplier tx is applied", () => {
    const acts = foldActions(rows, byAddr);
    const mu = acts.find((a) => a.symbol === "MUc")!;
    const nv = acts.find((a) => a.symbol === "NVDAc")!;
    expect(mu.status).toBe("announced");
    expect(mu.id).toBe("2937");
    expect(nv.status).toBe("applied");
    expect(nv.multiplierAfter).toBeCloseTo(1.000537939576, 9);
    expect(nv.applyTx).toBe("0xnv");
  });

  it("pre and applied announcements of one action merge into one", () => {
    const acts = foldActions(
      [
        { address: MU.token, event_name: "Announcement", parameters: { id: "x:pre", description: "Cash Dividend" }, transaction_hash: "0xa", block_timestamp: "2026-10-02T00:00:00Z" },
        { address: MU.token, event_name: "Announcement", parameters: { id: "x", description: "Cash Dividend" }, transaction_hash: "0xb", block_timestamp: "2026-10-09T00:00:00Z" },
        { address: MU.token, event_name: "MultiplierUpdated", parameters: { multiplier: "1002000000000000000" }, transaction_hash: "0xb", block_timestamp: "2026-10-09T00:00:00Z" },
      ],
      byAddr,
    );
    expect(acts).toHaveLength(1);
    expect(acts[0].status).toBe("applied");
    expect(acts[0].announcedAt).toBe("2026-10-02T00:00:00Z");
    expect(acts[0].appliedAt).toBe("2026-10-09T00:00:00Z");
  });

  it("keys by the uri's record id — GOOGLc's first notice said id 2097, its application used the UUID", () => {
    const uri = "https://api.coinbase.com/v1/tokenized-stocks/corporate-actions/e82812a6";
    const acts = foldActions(
      [
        { address: NVDA.token, event_name: "Announcement", parameters: { id: "2097", description: "Cash Dividend", uri }, transaction_hash: "0x1", block_timestamp: "2026-09-14T15:39:01Z" },
        { address: NVDA.token, event_name: "Announcement", parameters: { id: "e82812a6", description: "Cash Dividend", uri }, transaction_hash: "0x2", block_timestamp: "2026-09-14T18:29:45Z" },
        { address: NVDA.token, event_name: "MultiplierUpdated", parameters: { multiplier: "1000377118676784179" }, transaction_hash: "0x2", block_timestamp: "2026-09-14T18:29:45Z" },
      ],
      byAddr,
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ id: "e82812a6", status: "applied", announcedAt: "2026-09-14T15:39:01Z", announceTx: "0x1", applyTx: "0x2" });
  });

  it("an announcement without a multiplier move in its tx is notice, not application", () => {
    const acts = foldActions([{ ...rows[0], parameters: { description: "Cash Dividend", id: "plain" } }], byAddr);
    expect(acts[0].status).toBe("announced");
  });

  it("ignores events from tokens outside the roster", () => {
    expect(foldActions([{ ...rows[0], address: "0xb2000000000000000000000000000000000000ff" }], byAddr)).toHaveLength(0);
  });

  it("Coinbase's record sets status and the accrual", () => {
    const [nv] = foldActions(rows.slice(1), byAddr);
    const r = applyRecord(nv, { status: "CORPORATE_ACTION_STATUS_APPLIED", multiplier_before: 1, multiplier_after: 1.0005379395763694 });
    expect(r.status).toBe("applied");
    expect(r.accrualPct).toBe(0.0538);
  });

  it("accrual is null without both multipliers", () => {
    expect(accrualPct(null, 1.1)).toBeNull();
    expect(accrualPct(1, 1.02)).toBe(2);
    expect(baseActionId("abc:pre")).toBe("abc");
  });
});

describe("live roster", () => {
  it("keeps only B20 ticker+c records from the API", () => {
    const r = apiStocksToRoster([
      { contract_address: "0xB200000000000000000000da6F64c306234127E0", symbol: "SAPc", name: "SAP SE" },
      { contract_address: "0x1234567890123456789012345678901234567890", symbol: "FAKEc" },
      { contract_address: "0xb20000000000000000000024170488e788CBbCb4", symbol: "BRK.Bc", name: "Berkshire" },
      { contract_address: "0xb200000000000000000000000000000000000001", symbol: "NOSUFFIX" },
    ]);
    expect(r.map((s) => s.sym)).toEqual(["SAPc", "BRK.Bc"]);
    expect(r[0]).toMatchObject({ ticker: "SAP", token: "0xb200000000000000000000da6f64c306234127e0" });
  });

  it("the API can only add — seed entries are kept and not duplicated", () => {
    const merged = mergeRoster([NVDA], [{ ...NVDA, name: "renamed" }, MU, MU]);
    expect(merged).toEqual([NVDA, MU]);
  });
});
