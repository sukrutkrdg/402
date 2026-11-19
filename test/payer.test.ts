import { describe, it, expect } from "vitest";
import { payerFromHeaders, networkFromHeaders } from "../src/lib/payer";

/**
 * x402 v2 renamed the payment header from `X-PAYMENT` to `PAYMENT-SIGNATURE`,
 * and we kept reading the v1 name. Every settlement on chain was real, and every
 * one of them arrived with no payer as far as our own code was concerned:
 * payersToday sat at 0 for days while wallets were paying, no purchase could be
 * attributed to a service, and buy-credits could not arm recovery — so a buyer
 * who lost their credit token had no way back to a balance they had paid for.
 *
 * Nothing failed loudly, which is why it lasted. These tests use the real
 * payload shape from @x402/evm (ExactEIP3009Payload) rather than a sketch.
 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const WALLET = "0x72F6d77a78dbEc1B2FFf6f6db4672DDDe1bD04C4";

const v2Payload = {
  x402Version: 2,
  scheme: "exact",
  network: "eip155:8453",
  payload: {
    signature: "0xabc",
    authorization: {
      from: WALLET,
      to: "0x973a31858f4d2125f48c880542da11a2796f12d6",
      value: "30000",
      validAfter: "0",
      validBefore: "99999999999",
      nonce: "0xdead",
    },
  },
};

const headers = (h: Record<string, string>) => ({
  get: (n: string) => h[n.toLowerCase()] ?? null,
});

describe("reading the paying wallet", () => {
  it("reads the v2 PAYMENT-SIGNATURE header", () => {
    expect(payerFromHeaders(headers({ "payment-signature": b64(v2Payload) }))).toBe(WALLET.toLowerCase());
  });

  it("still reads a v1 X-PAYMENT header", () => {
    expect(payerFromHeaders(headers({ "x-payment": b64({ ...v2Payload, x402Version: 1 }) }))).toBe(WALLET.toLowerCase());
  });

  it("lowercases, so the write side matches the dashboard's lookup", () => {
    // The payers view hashes the lowercased address it read from chain. A
    // checksummed hash here would never match it, and the miss would be silent.
    const got = payerFromHeaders(headers({ "payment-signature": b64(v2Payload) }));
    expect(got).toBe(got.toLowerCase());
  });

  it("finds the payer in a Permit2-shaped payload too", () => {
    // The same scheme nests the payer differently under Permit2, so the search
    // is structural rather than a fixed path.
    const permit2 = { x402Version: 2, payload: { permit: { permitted: { token: "0x1" }, owner: WALLET } } };
    expect(payerFromHeaders(headers({ "payment-signature": b64(permit2) }))).toBe(WALLET.toLowerCase());
  });

  it("returns empty rather than throwing on junk", () => {
    const junk: Record<string, string>[] = [
      {},
      { "payment-signature": "not-base64!!" },
      { "payment-signature": b64({ nothing: true }) },
      { "payment-signature": b64({ payload: { authorization: { from: "0xnope" } } }) },
    ];
    for (const h of junk) {
      expect(payerFromHeaders(headers(h))).toBe("");
    }
  });

  it("prefers a readable header over an unreadable one", () => {
    expect(
      payerFromHeaders(headers({ "payment-signature": "garbage", "x-payment": b64(v2Payload) })),
    ).toBe(WALLET.toLowerCase());
  });
});

/**
 * A Solana payer signs with a base58 key the EVM payer parser cannot read, so a
 * settlement's chain is taken from the payload's CAIP-2 `network`. Without this
 * the dashboard + live feed would drop every Solana purchase.
 */
describe("reading the settlement chain", () => {
  const svmPayload = {
    x402Version: 2,
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKt",
    payload: { transaction: "base64tx", authority: "4au4N67H9KpfqgPC5yEu15Ac6weHJVNnkRQnW7sucgHX" },
  };

  it("tags a Base settlement", () => {
    expect(networkFromHeaders(headers({ "payment-signature": b64(v2Payload) }))).toBe("base");
  });

  it("tags a Solana settlement", () => {
    expect(networkFromHeaders(headers({ "payment-signature": b64(svmPayload) }))).toBe("solana");
  });

  it("returns empty rather than throwing when the chain is unreadable", () => {
    const junk: Record<string, string>[] = [{}, { "payment-signature": "not-base64!!" }, { "payment-signature": b64({ network: "aptos:1" }) }];
    for (const h of junk) {
      expect(networkFromHeaders(headers(h))).toBe("");
    }
  });
});
