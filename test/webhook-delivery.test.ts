import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// In-memory KV so the cron path runs end to end.
const store = new Map<string, string>();
const sets = new Map<string, Set<string>>();
vi.mock("@/lib/kv", () => ({
  kvConfigured: () => true,
  kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  kvSAdd: vi.fn(async (k: string, m: string) => void (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(m)),
  kvSRem: vi.fn(async (k: string, m: string) => void sets.get(k)?.delete(m)),
  kvSMembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
}));
// Delivery re-validates the URL; DNS is not what this test is about.
vi.mock("@/lib/alerts", () => ({ assertSafeWebhook: vi.fn(async (u: string) => new URL(u)) }));

const TOKEN = "0x1111111111111111111111111111111111111111";
let liquidityUsd = 100_000;
vi.mock("@/lib/upstream-cache", () => ({
  dexTokenPairs: vi.fn(async () => [{ baseToken: { address: TOKEN }, liquidity: { usd: liquidityUsd } }]),
}));

const { deliverWebhook, signWebhook } = await import("@/lib/webhook-delivery");
const { registerRugMonitor, checkRugMonitors } = await import("@/lib/rug-monitor");

type Call = { url: string; headers: Record<string, string>; body: string };
function mockReceiver(statuses: number[]) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response("", { status: statuses[Math.min(calls.length - 1, statuses.length - 1)] });
  });
  return calls;
}

describe("webhook delivery", () => {
  beforeEach(() => {
    store.clear();
    sets.clear();
    liquidityUsd = 100_000;
    vi.restoreAllMocks();
  });

  it("signs deliveries so a receiver can verify them with the secret", async () => {
    const calls = mockReceiver([200]);
    const res = await deliverWebhook("https://hooks.example.com/x", { hello: 1 }, "whsec_test");
    expect(res.ok).toBe(true);
    const { headers, body } = calls[0];
    const expected = createHmac("sha256", "whsec_test").update(`${headers["x-402-timestamp"]}.${body}`).digest("hex");
    expect(headers["x-402-signature"]).toBe(`sha256=${expected}`);
    expect(signWebhook("whsec_test", Number(headers["x-402-timestamp"]), body)).toBe(headers["x-402-signature"]);
  });

  it("reports a non-2xx receiver as a failed delivery", async () => {
    mockReceiver([503]);
    expect(await deliverWebhook("https://hooks.example.com/x", {}, "s")).toMatchObject({ ok: false, status: 503 });
  });

  it("rug monitor fires on a liquidity pull, retries a failed delivery, then stops", async () => {
    const reg = (await registerRugMonitor({ token: TOKEN, webhook: "https://hooks.example.com/rug", dropPct: "50" })) as {
      id: string;
      webhookSecret: string;
    };
    expect(reg.webhookSecret).toMatch(/^whsec_/);

    // Receiver is down for the first two attempts, up on the third.
    const calls = mockReceiver([500, 500, 200]);
    liquidityUsd = 10_000; // 90% pulled

    expect(await checkRugMonitors()).toMatchObject({ fired: 1 });
    expect(calls).toHaveLength(1);
    expect(sets.get("rugwatch:active")?.has(reg.id)).toBe(true); // kept for retry

    await checkRugMonitors();
    await checkRugMonitors();
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[2].body)).toMatchObject({ type: "rug_warning", token: TOKEN, dropPct: 90 });
    expect(sets.get("rugwatch:active")?.has(reg.id)).toBe(false); // delivered → done

    const saved = JSON.parse(store.get(`rugwatch:${reg.id}`)!);
    expect(saved).toMatchObject({ fired: true, delivered: true, deliveryAttempts: 3 });

    await checkRugMonitors();
    expect(calls).toHaveLength(3); // no re-delivery after success
  });

  it("gives up after three failed attempts", async () => {
    const reg = (await registerRugMonitor({ token: TOKEN, webhook: "https://hooks.example.com/rug" })) as { id: string };
    const calls = mockReceiver([500]);
    liquidityUsd = 0;
    for (let i = 0; i < 5; i++) await checkRugMonitors();
    expect(calls).toHaveLength(3);
    expect(JSON.parse(store.get(`rugwatch:${reg.id}`)!)).toMatchObject({ delivered: false, deliveryAttempts: 3 });
  });

  it("never returns the secret on a poll check", async () => {
    const reg = (await registerRugMonitor({ token: TOKEN, webhook: "https://hooks.example.com/rug" })) as { id: string };
    const polled = await registerRugMonitor({ check: reg.id });
    expect(JSON.stringify(polled)).not.toMatch(/whsec_/);
  });
});
