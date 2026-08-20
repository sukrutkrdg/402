import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A detector nobody reads is not a detector.
 *
 * The probe that catches an exhausted Anthropic balance was written months
 * before it was needed, and it was exactly right: one token, and it names
 * billing exhaustion specifically. What it did with the answer was put it in a
 * response body on a route that was never added to any schedule. So on
 * 2026-08-20 the balance ran dry, all ten AI endpoints returned 400, and it was
 * found hours later by a call that happened to fail.
 *
 * Two properties decide whether the fix is real:
 *
 *   - It cannot break what it watches. Every failure in here is swallowed; an
 *     alert that throws inside the daily spend cron would take down the run it
 *     exists to report on.
 *   - It cannot cry every morning. A standing incident that pages daily becomes
 *     a filter rule, and the next real alert is invisible too.
 */
const { kvMock } = vi.hoisted(() => ({
  kvMock: { kvGet: vi.fn(), kvSet: vi.fn(), kvDel: vi.fn() },
}));
vi.mock("@/lib/kv", () => kvMock);

import { alertOwner, clearAlert, openIncident } from "@/lib/alert-owner";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  kvMock.kvGet.mockResolvedValue(null);
  kvMock.kvSet.mockResolvedValue(undefined);
  kvMock.kvDel.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot-token");
  vi.stubEnv("OWNER_TELEGRAM_CHAT_ID", "12345");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("alertOwner", () => {
  it("delivers the first time an incident opens", async () => {
    const out = await alertOwner("ai-credits", "credits exhausted");
    expect(out.fired).toBe(true);
    expect(out.delivered).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("api.telegram.org/botbot-token/sendMessage");
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe("12345");
    expect(body.text).toContain("credits exhausted");
  });

  it("stays quiet while the same incident is still open", async () => {
    kvMock.kvGet.mockResolvedValue(JSON.stringify({ text: "credits exhausted", since: "2026-08-20T00:00:00.000Z" }));
    const out = await alertOwner("ai-credits", "credits exhausted");
    expect(out.fired, "a daily cron must not page daily").toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the original start time across repeated observations", async () => {
    // "since" is how long it has been broken; refreshing it would erase that.
    kvMock.kvGet.mockResolvedValue(JSON.stringify({ text: "x", since: "2026-08-20T00:00:00.000Z" }));
    await alertOwner("ai-credits", "still down");
    const stored = JSON.parse(kvMock.kvSet.mock.calls[0][1] as string);
    expect(stored.since).toBe("2026-08-20T00:00:00.000Z");
    expect(stored.lastSeen).not.toBe(stored.since);
  });

  it("records the incident even when there is nowhere to send it", async () => {
    // Losing the fact because the messenger was unconfigured would repeat the
    // original mistake in a new place.
    vi.stubEnv("OWNER_TELEGRAM_CHAT_ID", "");
    const out = await alertOwner("ai-credits", "credits exhausted");
    expect(out.fired).toBe(true);
    expect(out.delivered).toBe(false);
    expect(out.reason).toMatch(/not set/i);
    expect(kvMock.kvSet).toHaveBeenCalled();
  });

  it("never throws, whatever the ledger or the network does", async () => {
    kvMock.kvGet.mockRejectedValue(new Error("kv down"));
    await expect(alertOwner("ai-credits", "x")).resolves.toMatchObject({ fired: false });

    kvMock.kvGet.mockResolvedValue(null);
    fetchMock.mockRejectedValue(new Error("telegram unreachable"));
    const out = await alertOwner("ai-credits", "x");
    expect(out.fired).toBe(true);
    expect(out.delivered).toBe(false);
  });
});

describe("clearAlert", () => {
  it("announces recovery only if something was announced", async () => {
    kvMock.kvGet.mockResolvedValue(JSON.stringify({ text: "x", since: "2026-08-20T00:00:00.000Z" }));
    const out = await clearAlert("ai-credits", "back up");
    expect(out.fired).toBe(true);
    expect(kvMock.kvDel).toHaveBeenCalledWith("incident:ai-credits");
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).text).toContain("back up");
  });

  it("says nothing on an ordinary healthy day", async () => {
    const out = await clearAlert("ai-credits", "back up");
    expect(out.fired).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openIncident", () => {
  it("reports what is currently wrong, for an owner-only surface", async () => {
    kvMock.kvGet.mockResolvedValue(JSON.stringify({ text: "credits exhausted", since: "2026-08-20T00:00:00.000Z" }));
    expect(await openIncident("ai-credits")).toMatchObject({ since: "2026-08-20T00:00:00.000Z" });
  });

  it("survives a corrupt record rather than taking the page down with it", async () => {
    kvMock.kvGet.mockResolvedValue("{not json");
    expect(await openIncident("ai-credits")).toBeNull();
  });
});
