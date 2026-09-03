import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decisionReceipt } from "@/lib/envelope";

/**
 * A refusal is not billed — on EITHER rail.
 *
 * The credit rail always honoured this: it debits first, and hands the debit
 * back when `receipt.refundable` comes out true. The x402 rail could not, and
 * nobody noticed, because the two rails fail the customer in opposite ways. On
 * the credit rail an unbilled refusal is a refund you can see in the balance; on
 * the x402 rail settlement had already been authorised by the time the handler
 * ran, and returning 200 captured it. So the same upstream outage cost an x402
 * buyer money and a credit buyer nothing, while both responses carried a receipt
 * saying the call was refundable.
 *
 * The lever is the status code: `withX402` settles on the handler's response and
 * only when it is under 400. Returning the refusal as 502 means the payment is
 * never captured — not refunded, never taken. That is why the x402 body says
 * `not-settled` rather than reusing the credit rail's `credits-refunded`: an
 * agent reconciling its own spend would look for a refund that does not exist.
 */
const route = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The paid x402 handler — the closure `withX402` wraps. */
const paidHandler = code.slice(
  code.indexOf("const handler = async (request: NextRequest)"),
  code.indexOf("const inputSchema ="),
);

describe("a refusal is never billed on the x402 rail", () => {
  it("answers a refusal with a status withX402 will not settle", () => {
    expect(paidHandler).toMatch(/if \(isRefundable\(data\)\)/);
    const branch = paidHandler.slice(paidHandler.indexOf("if (isRefundable(data))"));
    expect(branch).toMatch(/status: 502/);
    // 402 would be read as "pay me" by a client that just did.
    expect(branch).not.toMatch(/status: (200|402)/);
  });

  it("still delivers the body, because the receipt is what names the missing input", () => {
    const branch = paidHandler.slice(paidHandler.indexOf("if (isRefundable(data))"));
    expect(branch).toMatch(/\bdata,/);
    expect(branch).toMatch(/"x-refunded": "true"/);
  });

  it("does not call it a refund — nothing was ever taken", () => {
    const branch = paidHandler.slice(paidHandler.indexOf("if (isRefundable(data))"));
    expect(branch).toMatch(/not-settled/);
    expect(branch).not.toMatch(/credits-refunded/);
  });

  it("books no sale: no sample, no index refresh, no paid call", () => {
    const branch = paidHandler.slice(
      paidHandler.indexOf("if (isRefundable(data))"),
      paidHandler.indexOf("await saveSample"),
    );
    // The shop window must not advertise a refusal, and only a settlement may
    // mark the discovery row fresh.
    expect(branch).not.toMatch(/saveSample/);
    expect(branch).not.toMatch(/indexFreshKey/);
    // Logged, but as an unpaid call — `true` in the second position is "paid".
    expect(branch).toMatch(/logUsage\(service\.id, false,/);
  });

  it("runs before the sale bookkeeping, not after it", () => {
    expect(paidHandler.indexOf("isRefundable(data)")).toBeLessThan(paidHandler.indexOf("await saveSample"));
  });
});

describe("the rule we publish matches the rule we enforce", () => {
  const receipt = decisionReceipt({ endpoint: "safe-to-send", params: {}, degraded: true, missing: ["sanctions"] });

  it("marks a degraded verdict refundable and refuses", () => {
    expect(receipt.refundable).toBe(true);
    expect(receipt.refusal).not.toBeNull();
    expect(receipt.confidence.band).toBe("low");
  });

  it("states both rails, so an agent knows which shape to expect", () => {
    expect(receipt.refundRule).toMatch(/credit/i);
    expect(receipt.refundRule).toMatch(/502/);
    expect(receipt.refundRule).toMatch(/x402/i);
  });

  it("a full-confidence verdict is final and not refundable", () => {
    const ok = decisionReceipt({ endpoint: "safe-to-send", params: {}, degraded: false });
    expect(ok.refundable).toBe(false);
    expect(ok.refusal).toBeNull();
  });
});
