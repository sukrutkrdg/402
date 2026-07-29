import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "@/lib/polar";

const SECRET = "polar_whsec_test_0123456789";

function sign(body: string, opts: { secret?: string; id?: string; at?: number; key?: "utf8" | "base64" } = {}) {
  const secret = opts.secret ?? SECRET;
  const id = opts.id ?? "msg_123";
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const bare = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = opts.key === "base64" ? Buffer.from(bare, "base64") : Buffer.from(bare, "utf8");
  const sig = createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64");
  return { id, timestamp: String(at), signature: `v1,${sig}` };
}

const BODY = JSON.stringify({
  type: "checkout.updated",
  data: { id: "9f8e7d6c-1234-4321-abcd-000000000001", status: "succeeded", net_amount: 500, currency: "usd" },
});

describe("Polar webhook signature verification (Standard Webhooks)", () => {
  it("accepts a correctly signed, fresh delivery", () => {
    const r = verifyWebhook(BODY, sign(BODY), SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.type).toBe("checkout.updated");
  });

  it("accepts the base64-decoded key derivation too (encoding ambiguity)", () => {
    const r = verifyWebhook(BODY, sign(BODY, { key: "base64" }), SECRET);
    expect(r.ok).toBe(true);
  });

  it("rejects a body that was tampered with after signing", () => {
    const headers = sign(BODY);
    const tampered = BODY.replace('"net_amount":500', '"net_amount":500000');
    expect(verifyWebhook(tampered, headers, SECRET).ok).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifyWebhook(BODY, sign(BODY, { secret: "attacker" }), SECRET).ok).toBe(false);
  });

  it("rejects when the delivery id doesn't match the signed id", () => {
    const headers = sign(BODY);
    expect(verifyWebhook(BODY, { ...headers, id: "msg_other" }, SECRET).ok).toBe(false);
  });

  it("rejects a replayed delivery outside the timestamp tolerance", () => {
    const r = verifyWebhook(BODY, sign(BODY, { at: Math.floor(Date.now() / 1000) - 3600 }), SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/timestamp/);
  });

  it("still accepts a delivery inside the tolerance window", () => {
    expect(verifyWebhook(BODY, sign(BODY, { at: Math.floor(Date.now() / 1000) - 60 }), SECRET).ok).toBe(true);
  });

  it("rejects missing headers", () => {
    expect(verifyWebhook(BODY, { id: null, timestamp: null, signature: null }, SECRET).ok).toBe(false);
    const h = sign(BODY);
    expect(verifyWebhook(BODY, { ...h, signature: null }, SECRET).ok).toBe(false);
  });

  it("accepts when one of several space-separated signatures matches (rotation)", () => {
    const h = sign(BODY);
    const mixed = { ...h, signature: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${h.signature}` };
    expect(verifyWebhook(BODY, mixed, SECRET).ok).toBe(true);
  });

  it("tolerates the whsec_ prefix on the configured secret", () => {
    const prefixed = `whsec_${SECRET}`;
    expect(verifyWebhook(BODY, sign(BODY, { secret: prefixed }), prefixed).ok).toBe(true);
  });

  it("rejects a valid signature over a non-JSON body", () => {
    const body = "not json";
    expect(verifyWebhook(body, sign(body), SECRET).ok).toBe(false);
  });
});
