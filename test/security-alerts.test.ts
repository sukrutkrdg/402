import { describe, expect, it } from "vitest";
import {
  registerSecurityWebhook,
  signWebhookPayload,
  sendWebhookPing,
} from "@/lib/security-alerts";

describe("security-alerts", () => {
  it("generates correct HMAC-SHA256 signature", () => {
    const payload = JSON.stringify({ test: "hello" });
    const secret = "secret123";
    const sig = signWebhookPayload(payload, secret);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-https URLs for SSRF defense", async () => {
    await expect(
      registerSecurityWebhook({
        webhookUrl: "http://example.com/hook",
        alertType: "HONEYPOT_DETECTED",
      })
    ).rejects.toThrow("Invalid webhook: must be an https:// URL");
  });

  it("rejects private/internal IP addresses for SSRF defense", async () => {
    await expect(
      registerSecurityWebhook({
        webhookUrl: "https://127.0.0.1/hook",
        alertType: "HONEYPOT_DETECTED",
      })
    ).rejects.toThrow(/private\/internal/i);
  });

  it("rejects invalid alert types", async () => {
    await expect(
      registerSecurityWebhook({
        webhookUrl: "https://example.com/hook",
        alertType: "INVALID_TYPE" as any,
      })
    ).rejects.toThrow("Invalid alertType");
  });

  it("registers a valid webhook and generates secret", async () => {
    const sub = await registerSecurityWebhook({
      webhookUrl: "https://example.com/alerts",
      alertType: "HONEYPOT_DETECTED",
      tokenAddress: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    });

    expect(sub.id).toMatch(/^wh_[a-f0-9]{16}$/);
    expect(sub.alertType).toBe("HONEYPOT_DETECTED");
    expect(sub.tokenAddress).toBe("0x4ed4e862860bed51a9570b96d89af5e1b0efefed");
    expect(sub.secret.length).toBeGreaterThanOrEqual(16);
  });

  it("signs test ping correctly when sending", async () => {
    const sub = await registerSecurityWebhook({
      webhookUrl: "https://example.com/alerts",
      alertType: "B20_SEIZURE_ACTIVATED",
    });

    const ping = await sendWebhookPing(sub);
    expect(ping).toBeDefined();
    expect(ping.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof ping.latencyMs).toBe("number");
  });

  it("lists active security webhooks filtered by alert type", async () => {
    const targetToken = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
    await registerSecurityWebhook({
      webhookUrl: "https://example.com/alerts-honeypot",
      alertType: "HONEYPOT_DETECTED",
      tokenAddress: targetToken,
    });

    const { getActiveSecurityWebhooks, dispatchSecurityAlert } = await import("@/lib/security-alerts");
    const active = await getActiveSecurityWebhooks("HONEYPOT_DETECTED", targetToken);
    expect(active.length).toBeGreaterThan(0);
    expect(active.some((s) => s.alertType === "HONEYPOT_DETECTED")).toBe(true);

    const dispatchRes = await dispatchSecurityAlert({
      alertType: "HONEYPOT_DETECTED",
      tokenAddress: targetToken,
      data: { score: 10, reason: "tax spike" },
    });
    expect(dispatchRes).toBeDefined();
    expect(typeof dispatchRes.dispatched).toBe("number");
  });
});

