import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "@/lib/stripe";

const SECRET = "whsec_test_0123456789abcdef";

function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return `t=${at},v1=${v1}`;
}

const BODY = JSON.stringify({
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { id: "cs_test_1", payment_status: "paid" } },
});

describe("Stripe webhook signature verification", () => {
  it("accepts a correctly signed, fresh delivery", () => {
    const r = verifyWebhook(BODY, sign(BODY), SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.type).toBe("checkout.session.completed");
  });

  it("rejects a body that was tampered with after signing", () => {
    const header = sign(BODY);
    const tampered = BODY.replace('"payment_status":"paid"', '"payment_status":"unpaid"');
    const r = verifyWebhook(tampered, header, SECRET);
    expect(r.ok).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const r = verifyWebhook(BODY, sign(BODY, "whsec_attacker"), SECRET);
    expect(r.ok).toBe(false);
  });

  it("rejects a replayed delivery outside the timestamp tolerance", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const r = verifyWebhook(BODY, sign(BODY, SECRET, old), SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/timestamp/);
  });

  it("still accepts a delivery inside the tolerance window", () => {
    const recent = Math.floor(Date.now() / 1000) - 60;
    expect(verifyWebhook(BODY, sign(BODY, SECRET, recent), SECRET).ok).toBe(true);
  });

  it("rejects a missing or malformed signature header", () => {
    expect(verifyWebhook(BODY, null, SECRET).ok).toBe(false);
    expect(verifyWebhook(BODY, "garbage", SECRET).ok).toBe(false);
    expect(verifyWebhook(BODY, "t=123", SECRET).ok).toBe(false);
  });

  it("accepts when one of several v1 signatures matches (key rotation)", () => {
    const at = Math.floor(Date.now() / 1000);
    const good = createHmac("sha256", SECRET).update(`${at}.${BODY}`).digest("hex");
    expect(verifyWebhook(BODY, `t=${at},v1=deadbeef,v1=${good}`, SECRET).ok).toBe(true);
  });

  it("rejects a valid signature over a non-JSON body", () => {
    const body = "not json";
    expect(verifyWebhook(body, sign(body), SECRET).ok).toBe(false);
  });
});
