import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The one write in this codebase that is safe to retry.
 *
 * kv.ts already states the rule for its own retry helper: "Never use for writes
 * — a retried INCR/LPUSH could double-apply." That is not pedantry. Over HTTP,
 * a timeout tells you the reply is missing, not that the command is; Redis may
 * well have executed the INCRBY and lost the answer on the way back. Anything
 * that retries a bare increment is choosing to sometimes apply it twice.
 *
 * Doing the guard and the increment in one Lua script removes the ambiguity,
 * because Redis runs a script atomically: if the guard key exists, the increment
 * inside that same script ran. So the guard is evidence, and a retry carrying
 * the same guard can safely decline to repeat itself.
 */
process.env.UPSTASH_REDIS_REST_URL = "https://kv.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "tok";

const { kvIncrByOnce, ALREADY } = await import("@/lib/kv");

/** Captures the EVAL body Upstash would receive. */
const respond = (result: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result }) });

const sentBody = (fetchMock: ReturnType<typeof vi.fn>) =>
  JSON.parse(fetchMock.mock.calls[0][1].body as string) as (string | number)[];

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("kvIncrByOnce", () => {
  it("sends one EVAL carrying both the guard key and the counter key", async () => {
    const f = respond(12);
    vi.stubGlobal("fetch", f);
    const out = await kvIncrByOnce("credits:abc", 5, "refund:xyz");

    expect(out).toBe(12);
    expect(f, "guard and increment must not be two round trips").toHaveBeenCalledTimes(1);
    const body = sentBody(f);
    expect(body[0]).toBe("EVAL");
    expect(body[2], "two KEYS: the guard, then the counter").toBe(2);
    expect(body[3]).toBe("refund:xyz");
    expect(body[4]).toBe("credits:abc");
    expect(body).toContain(5);
  });

  it("increments only inside the branch where the guard was newly set", async () => {
    vi.stubGlobal("fetch", respond(1));
    await kvIncrByOnce("k", 1, "g");
    const script = String(sentBody(vi.mocked(globalThis.fetch) as never)[1]);
    // The INCRBY must be unreachable when SET..NX returns nil, otherwise the
    // guard is decoration and the retry double-applies exactly as before.
    expect(script).toMatch(/if\s+redis\.call\('SET',\s*KEYS\[1\].*'NX'/);
    expect(script.indexOf("INCRBY"), "INCRBY sits inside the if").toBeGreaterThan(script.indexOf("if redis.call('SET'"));
    expect(script).toMatch(/KEYS\[2\]/);
  });

  it("reports ALREADY when the guard says this increment has run", async () => {
    vi.stubGlobal("fetch", respond("__already__"));
    expect(await kvIncrByOnce("k", 5, "g")).toBe(ALREADY);
  });

  it("reports null when the request itself failed, which is the retryable case", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ETIMEDOUT")));
    expect(await kvIncrByOnce("k", 5, "g")).toBeNull();
  });

  it("applies once across repeated calls with the same guard", async () => {
    // What the whole design is for, end to end against a fake Redis.
    const store = new Map<string, string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const [, , , guard, key, by, sentinel] = JSON.parse(init.body) as string[];
        if (store.has(guard)) return { ok: true, json: async () => ({ result: sentinel }) };
        store.set(guard, "1");
        const next = Number(store.get(key) ?? 0) + Number(by);
        store.set(key, String(next));
        return { ok: true, json: async () => ({ result: next }) };
      }),
    );

    expect(await kvIncrByOnce("bal", 5, "refund:1")).toBe(5);
    expect(await kvIncrByOnce("bal", 5, "refund:1")).toBe(ALREADY);
    expect(await kvIncrByOnce("bal", 5, "refund:1")).toBe(ALREADY);
    expect(store.get("bal"), "three attempts, one refund").toBe("5");

    // A genuinely different refund still gets through.
    expect(await kvIncrByOnce("bal", 5, "refund:2")).toBe(10);
  });
});
