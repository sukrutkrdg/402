import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

/**
 * Fleet child tokens, tested against the real Lua: every script here runs in a
 * Lua VM over an in-memory Redis (test/helpers/lua-redis.ts), so the cap,
 * pause and allowlist checks are exercised as they run in production rather
 * than as canned kvEval answers.
 */
vi.mock("@/lib/kv", async () => {
  const { LuaRedis, kvBackedBy } = await import("./helpers/lua-redis");
  const store = new LuaRedis();
  return { ...kvBackedBy(store), __store: store };
});

import * as kvModule from "@/lib/kv";
import type { LuaRedis } from "./helpers/lua-redis";
import { mintCredits, creditHandle, creditsLedger, DEBIT_MILLS_LUA, REFUND_MILLS_LUA, recoverCredits, linkCreditOwner } from "@/lib/credits";
import {
  authenticateParent,
  createChild,
  listChildren,
  setChildStatus,
  deleteChild,
  chargeCreditToken,
  childSummary,
  spendKey,
  FleetError,
  MAX_CHILDREN,
} from "@/lib/fleet";
import { GET as listRoute, POST as createRoute } from "@/app/api/credits/fleet/route";
import { PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/credits/fleet/[id]/route";
import { GET as balanceRoute } from "@/app/api/credits/balance/route";
import { GET as paidGET } from "@/app/api/x402/[service]/route";

const store = (kvModule as unknown as { __store: LuaRedis }).__store;
const bal = (token: string) => store.getNum(`credit:${creditHandle(token)}`);
const remainder = (token: string) => store.getNum(`credit:${creditHandle(token)}:mills`);

async function parent(cents = 100) {
  return (await mintCredits(cents, cents / 100)).creditToken;
}
async function child(p: string, opts: Record<string, unknown> = {}) {
  const parentHandle = await authenticateParent(p);
  return createChild(parentHandle, { label: "agent-1", dailyCapUsd: 0.05, ...opts });
}

beforeEach(() => store.reset());

describe("the test harness runs Lua as Redis does", () => {
  // The same expectations test/credits-mills-redis.test.ts checks in a real
  // redis-server. If the VM agreed with Redis there, it is trustworthy here.
  it("five $0.002 debits take one cent, and the refund is the exact inverse", () => {
    store.command(["SET", "credit:t", "5", "EX", 1000]);
    expect(store.eval(DEBIT_MILLS_LUA, ["credit:t", "credit:t:mills"], ["2"])).toEqual([0, 5, 2]);
    for (let i = 0; i < 3; i++) store.eval(DEBIT_MILLS_LUA, ["credit:t", "credit:t:mills"], ["2"]);
    expect(store.eval(DEBIT_MILLS_LUA, ["credit:t", "credit:t:mills"], ["2"])).toEqual([1, 4, 0]);
    expect(store.eval(REFUND_MILLS_LUA, ["credit:t", "credit:t:mills", "refund:x"], ["2"])).toEqual([1]);
    expect(store.eval(REFUND_MILLS_LUA, ["credit:t", "credit:t:mills", "refund:x"], ["2"])).toEqual([-9]);
    expect(store.getNum("credit:t")).toBe(5);
    expect(store.getNum("credit:t:mills")).toBe(8);
  });

  it("an unknown token is refused without creating a key", () => {
    expect(store.eval(DEBIT_MILLS_LUA, ["credit:none", "credit:none:mills"], ["2"])).toEqual([-2, 0, 0]);
    expect(store.keys("credit:none")).toEqual([]);
  });
});

describe("a child spends from its parent", () => {
  it("draws the parent's balance down and mints nothing", async () => {
    const p = await parent(100);
    const before = await creditsLedger();
    const { childToken } = await child(p);
    expect(childToken).toMatch(/^ck_[0-9a-f]{36}$/);
    // Creating a child moved no money and created no balance key for it.
    expect(store.keys(`credit:${creditHandle(childToken)}`)).toEqual([]);
    expect((await creditsLedger())!.creditedUsd).toBe(before!.creditedUsd);

    const c = await chargeCreditToken(childToken, "secure-token", 10);
    expect(c.ok).toBe(true);
    expect(bal(p)).toBe(99);
    const after = await creditsLedger();
    expect(after!.spentUsd).toBe(0.01);
    expect(after!.outstandingUsd).toBe(0.99);
    if (c.ok) expect(c.fleet).toEqual({ spentTodayMills: 10, capMills: 50 });
  });

  it("sub-cent calls share the parent's remainder", async () => {
    const p = await parent(100);
    const { childToken } = await child(p);
    for (let i = 0; i < 4; i++) expect((await chargeCreditToken(childToken, "hash", 2)).ok).toBe(true);
    expect(bal(p)).toBe(100);
    expect(remainder(p)).toBe(8);
    await chargeCreditToken(p, "hash", 2); // the parent's own call settles the shared remainder
    expect(bal(p)).toBe(99);
    expect(remainder(p)).toBe(0);
  });

  it("reports what the child may still spend, not the parent's balance", async () => {
    const p = await parent(500);
    const { childToken } = await child(p, { dailyCapUsd: 0.03 });
    const c = await chargeCreditToken(childToken, "secure-token", 10);
    expect(c.ok && c.remainingMills).toBe(20);
  });

  it("refuses when the parent cannot cover the call, charging nothing", async () => {
    const p = await parent(1);
    const { childToken } = await child(p);
    const c = await chargeCreditToken(childToken, "secure-token", 20);
    expect(c).toMatchObject({ ok: false, reason: "parent_empty" });
    expect(bal(p)).toBe(1);
    expect(store.getNum(spendKey(creditHandle(childToken)))).toBe(0);
  });

  it("an unknown token is still just a bad token", async () => {
    expect(await chargeCreditToken(`ck_${"0".repeat(36)}`, "hash", 2)).toMatchObject({ ok: false, reason: "bad_token" });
  });
});

describe("daily cap", () => {
  it("refuses the call that would cross the cap and does not charge it", async () => {
    const p = await parent(100);
    const { childToken } = await child(p, { dailyCapUsd: 0.025 });
    expect((await chargeCreditToken(childToken, "secure-token", 10)).ok).toBe(true);
    expect((await chargeCreditToken(childToken, "secure-token", 10)).ok).toBe(true);
    const refused = await chargeCreditToken(childToken, "secure-token", 10);
    expect(refused).toMatchObject({ ok: false, reason: "daily_cap", spentTodayMills: 20, capMills: 25 });
    expect(bal(p)).toBe(98);
    // A smaller call that fits is still allowed — the cap is in mills, not calls.
    expect((await chargeCreditToken(childToken, "hash", 2)).ok).toBe(true);
    expect(store.getNum(spendKey(creditHandle(childToken)))).toBe(22);
  });

  it("concurrent calls cannot overshoot it", async () => {
    const p = await parent(1000);
    const { childToken } = await child(p, { dailyCapUsd: 0.1 });
    const results = await Promise.all(Array.from({ length: 40 }, () => chargeCreditToken(childToken, "secure-token", 10)));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "daily_cap")).toBe(true);
    expect(bal(p)).toBe(990);
    expect(store.getNum(spendKey(creditHandle(childToken)))).toBe(100);
    expect((await creditsLedger())!.spentCalls).toBe(10);
  });

  it("is per child, and the counter carries a TTL so yesterday cannot block today", async () => {
    const p = await parent(100);
    const a = await child(p, { dailyCapUsd: 0.01 });
    const b = await child(p, { dailyCapUsd: 0.01 });
    expect((await chargeCreditToken(a.childToken, "secure-token", 10)).ok).toBe(true);
    expect((await chargeCreditToken(a.childToken, "secure-token", 10)).ok).toBe(false);
    expect((await chargeCreditToken(b.childToken, "secure-token", 10)).ok).toBe(true);
    const ttl = store.command(["TTL", spendKey(a.child.id)]) as number;
    expect(ttl).toBeGreaterThan(24 * 3600);
    expect(ttl).toBeLessThanOrEqual(48 * 3600);
    expect(spendKey(a.child.id)).toMatch(new RegExp(`:${new Date().toISOString().slice(0, 10)}$`));
  });
});

describe("pause, resume and delete", () => {
  it("a pause refuses the very next call, uncharged; resume restores it", async () => {
    const p = await parent(100);
    const { childToken, child: c } = await child(p);
    const ph = await authenticateParent(p);
    expect((await chargeCreditToken(childToken, "hash", 2)).ok).toBe(true);
    await setChildStatus(ph, c.id, "paused");
    expect(await chargeCreditToken(childToken, "hash", 2)).toMatchObject({ ok: false, reason: "paused" });
    expect(remainder(p)).toBe(2);
    await setChildStatus(ph, c.id, "active");
    expect((await chargeCreditToken(childToken, "hash", 2)).ok).toBe(true);
  });

  it("a deleted child is refused and disappears from the list", async () => {
    const p = await parent(100);
    const { childToken, child: c } = await child(p);
    const ph = await authenticateParent(p);
    await deleteChild(ph, c.id);
    expect(await chargeCreditToken(childToken, "hash", 2)).toMatchObject({ ok: false, reason: "bad_token" });
    expect(await listChildren(ph)).toEqual([]);
    expect(bal(p)).toBe(100);
  });

  it("another parent cannot pause, resume or delete someone else's child", async () => {
    const p1 = await parent(100);
    const p2 = await parent(100);
    const { childToken, child: c } = await child(p1);
    const h2 = await authenticateParent(p2);
    await expect(setChildStatus(h2, c.id, "paused")).rejects.toMatchObject({ status: 404 });
    await expect(deleteChild(h2, c.id)).rejects.toMatchObject({ status: 404 });
    expect((await chargeCreditToken(childToken, "hash", 2)).ok).toBe(true);
    expect(await listChildren(h2)).toEqual([]);
  });

  it("a child whose parent balance was moved by recovery stops working", async () => {
    const p = await parent(100);
    await linkCreditOwner("0x" + "a".repeat(40), p);
    const { childToken } = await child(p);
    await recoverCredits("0x" + "a".repeat(40));
    expect(await chargeCreditToken(childToken, "hash", 2)).toMatchObject({ ok: false, reason: "parent_gone" });
  });
});

describe("allowlist and per-call maximum", () => {
  it("only allowed services can be charged", async () => {
    const p = await parent(100);
    const { childToken } = await child(p, { allow: ["hash"] });
    expect((await chargeCreditToken(childToken, "hash", 2)).ok).toBe(true);
    expect(await chargeCreditToken(childToken, "secure-token", 10)).toMatchObject({ ok: false, reason: "not_allowed" });
    // A service whose id merely contains an allowed one is not allowed.
    expect(await chargeCreditToken(childToken, "has", 2)).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(bal(p)).toBe(100);
    expect(remainder(p)).toBe(2);
  });

  it("a call above the per-call maximum is refused", async () => {
    const p = await parent(100);
    const { childToken } = await child(p, { perCallMaxUsd: 0.005 });
    expect(await chargeCreditToken(childToken, "secure-token", 10)).toMatchObject({ ok: false, reason: "over_call_max" });
    expect((await chargeCreditToken(childToken, "hash", 2)).ok).toBe(true);
    expect(bal(p)).toBe(100);
  });

  it("rejects bad policy at creation", async () => {
    const p = await parent(100);
    await expect(child(p, { allow: ["not-a-service"] })).rejects.toThrow(/Not a paid service/);
    await expect(child(p, { allow: ["buy-credits"] })).rejects.toThrow(/Not a paid service/);
    await expect(child(p, { dailyCapUsd: 0 })).rejects.toThrow(/dailyCapUsd/);
    await expect(child(p, { dailyCapUsd: "lots" })).rejects.toThrow(/dailyCapUsd/);
    await expect(child(p, { dailyCapUsd: 5000 })).rejects.toThrow(/dailyCapUsd/);
    await expect(child(p, { perCallMaxUsd: 1 })).rejects.toThrow(/perCallMaxUsd/);
    await expect(child(p, { label: "" })).rejects.toThrow(/label/);
    await expect(child(p, { label: "x".repeat(61) })).rejects.toThrow(/label/);
    expect(await listChildren(await authenticateParent(p))).toEqual([]);
  });
});

describe("refunds", () => {
  it("return the money to the parent and un-count the cap", async () => {
    const p = await parent(100);
    const { childToken, child: c } = await child(p, { dailyCapUsd: 0.01 });
    const charged = await chargeCreditToken(childToken, "secure-token", 10);
    expect(charged.ok).toBe(true);
    expect(bal(p)).toBe(99);
    expect((await chargeCreditToken(childToken, "secure-token", 10)).ok).toBe(false); // capped
    if (charged.ok) await charged.refund();
    expect(bal(p)).toBe(100);
    expect(store.getNum(spendKey(c.id))).toBe(0);
    const ledger = await creditsLedger();
    expect(ledger!.spentUsd).toBe(0);
    expect(ledger!.spentCalls).toBe(0);
    // The cap headroom is back.
    expect((await chargeCreditToken(childToken, "secure-token", 10)).ok).toBe(true);
  });

  it("a sub-cent refund restores the parent's remainder exactly", async () => {
    const p = await parent(100);
    const { childToken } = await child(p);
    const c = await chargeCreditToken(childToken, "hash", 2);
    if (c.ok) await c.refund();
    expect(bal(p)).toBe(100);
    expect(remainder(p)).toBe(0);
  });

  it("a parent's own refund still goes to the parent", async () => {
    const p = await parent(100);
    const c = await chargeCreditToken(p, "secure-token", 10);
    expect(bal(p)).toBe(99);
    if (c.ok) await c.refund();
    expect(bal(p)).toBe(100);
  });
});

describe("who may manage a fleet", () => {
  it("an unknown, malformed or empty token cannot authenticate", async () => {
    await expect(authenticateParent(`ck_${"1".repeat(36)}`)).rejects.toMatchObject({ status: 401 });
    await expect(authenticateParent("not-a-token")).rejects.toMatchObject({ status: 401 });
    await expect(authenticateParent("")).rejects.toBeInstanceOf(FleetError);
  });

  it("a child cannot create children or see the fleet", async () => {
    const p = await parent(100);
    const { childToken } = await child(p);
    await expect(authenticateParent(childToken)).rejects.toMatchObject({ status: 403 });
  });

  it("the list shows limits and today's spend, never a token", async () => {
    const p = await parent(100);
    const { childToken, child: c } = await child(p, { allow: ["hash", "ping"], perCallMaxUsd: 0.002 });
    await chargeCreditToken(childToken, "hash", 2);
    const list = await listChildren(await authenticateParent(p));
    expect(list).toEqual([
      {
        id: c.id,
        label: "agent-1",
        status: "active",
        dailyCapUsd: 0.05,
        perCallMaxUsd: 0.002,
        allow: ["hash", "ping"],
        createdAt: c.createdAt,
        spentTodayUsd: 0.002,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(childToken);
    // Only hashes are stored.
    expect(JSON.stringify(store.keys())).not.toContain(childToken.slice(3));
  });

  it("caps the number of children per parent", async () => {
    const p = await parent(100);
    for (let i = 0; i < MAX_CHILDREN; i++) await child(p);
    await expect(child(p)).rejects.toMatchObject({ status: 409 });
  });
});

describe("HTTP endpoints", () => {
  let ipN = 0;
  const req = (url: string, init: { method?: string; token?: string; body?: unknown; ip?: string } = {}) =>
    new NextRequest(`https://402.com.tr${url}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": init.ip ?? `10.9.0.${++ipN}`,
        ...(init.token ? { "x-credit-token": init.token } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("create → list → pause → delete with the parent token in the header", async () => {
    const p = await parent(100);
    const created = await createRoute(req("/api/credits/fleet", { method: "POST", token: p, body: { label: "scraper", dailyCapUsd: 0.5 } }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.childToken).toMatch(/^ck_/);

    const listed = await (await listRoute(req("/api/credits/fleet", { token: p }))).json();
    expect(listed.children).toHaveLength(1);
    expect(listed.children[0]).not.toHaveProperty("childToken");

    const paused = await patchRoute(req(`/api/credits/fleet/${body.child.id}`, { method: "PATCH", token: p, body: { status: "paused" } }), ctx(body.child.id));
    expect(paused.status).toBe(200);
    expect(await chargeCreditToken(body.childToken, "hash", 2)).toMatchObject({ ok: false, reason: "paused" });

    const del = await deleteRoute(req(`/api/credits/fleet/${body.child.id}`, { method: "DELETE", token: p }), ctx(body.child.id));
    expect(del.status).toBe(200);
  });

  it("refuses a missing, unknown or child token", async () => {
    const p = await parent(100);
    const { childToken, child: c } = await child(p);
    expect((await listRoute(req("/api/credits/fleet"))).status).toBe(401);
    expect((await listRoute(req("/api/credits/fleet", { token: `ck_${"2".repeat(36)}` }))).status).toBe(401);
    expect((await createRoute(req("/api/credits/fleet", { method: "POST", token: childToken, body: { label: "x", dailyCapUsd: 1 } }))).status).toBe(403);
    expect((await patchRoute(req(`/api/credits/fleet/${c.id}`, { method: "PATCH", token: childToken, body: { status: "active" } }), ctx(c.id))).status).toBe(403);
    expect((await deleteRoute(req(`/api/credits/fleet/${c.id}`, { method: "DELETE" }), ctx(c.id))).status).toBe(401);
    // Nothing was created by any of those.
    expect(await listChildren(await authenticateParent(p))).toHaveLength(1);
  });

  it("validates input", async () => {
    const p = await parent(100);
    expect((await createRoute(req("/api/credits/fleet", { method: "POST", token: p, body: [] }))).status).toBe(400);
    expect((await createRoute(req("/api/credits/fleet", { method: "POST", token: p, body: { label: "x" } }))).status).toBe(400);
    const { child: c } = await child(p);
    expect((await patchRoute(req(`/api/credits/fleet/${c.id}`, { method: "PATCH", token: p, body: { status: "deleted" } }), ctx(c.id))).status).toBe(400);
    expect((await patchRoute(req(`/api/credits/fleet/zzz`, { method: "PATCH", token: p, body: { status: "paused" } }), ctx("zzz"))).status).toBe(404);
  });

  it("is rate limited per IP, before the token is even looked at", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await listRoute(req("/api/credits/fleet", { ip: "10.8.8.8", token: `ck_${"3".repeat(36)}` }))).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });

  it("the paid gateway charges a child to its parent and refuses a paused or capped one uncharged", async () => {
    const p = await parent(100);
    const { childToken, child: c } = await child(p, { dailyCapUsd: 0.02, allow: ["secure-token"] });
    const call = (svc: string) =>
      paidGET(req(`/api/x402/${svc}?count=1`, { token: childToken }), { params: Promise.resolve({ service: svc }) });

    const ok = await call("secure-token");
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.paidVia).toBe("credits");
    expect(okBody.chargedUsd).toBe(0.01);
    expect(okBody.fleet).toEqual({ spentTodayUsd: 0.01, dailyCapUsd: 0.02 });
    expect(ok.headers.get("x-credit-balance")).toBe("1"); // cap headroom (1¢), not the parent's 99¢
    expect(bal(p)).toBe(99);

    const notAllowed = await call("hash");
    expect(notAllowed.status).toBe(403);
    expect((await notAllowed.json()).reason).toBe("not_allowed");

    await setChildStatus(await authenticateParent(p), c.id, "paused");
    const paused = await call("secure-token");
    expect(paused.status).toBe(403);
    expect(await paused.json()).toMatchObject({ reason: "paused", charged: false });
    expect(bal(p)).toBe(99);

    await setChildStatus(await authenticateParent(p), c.id, "active");
    expect((await call("secure-token")).status).toBe(200);
    const capped = await call("secure-token");
    expect(capped.status).toBe(403);
    expect(await capped.json()).toMatchObject({ reason: "daily_cap", charged: false, fleet: { spentTodayUsd: 0.02, dailyCapUsd: 0.02 } });
    expect(bal(p)).toBe(98);
  });

  it("the gateway refunds through the charge it made, so a child's refund reaches its parent", () => {
    const src = readFileSync("src/app/api/x402/[service]/route.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/refundCreditMills\(/);
    expect(src).not.toMatch(/debitCreditMills\(/);
    // Both refund paths: handler failure and an unbilled refusal.
    expect(src.match(/await debit\.refund\(\)/g)).toHaveLength(2);
  });

  it("the balance endpoint tells a child its limits, not the parent's balance", async () => {
    const p = await parent(2000);
    const { childToken } = await child(p, { dailyCapUsd: 0.05 });
    await chargeCreditToken(childToken, "secure-token", 10);
    const res = await balanceRoute(req("/api/credits/balance", { token: childToken }));
    const j = await res.json();
    expect(j.fleetChild).toMatchObject({ label: "agent-1", dailyCapUsd: 0.05, spentTodayUsd: 0.01, capLeftTodayUsd: 0.04, status: "active" });
    expect(JSON.stringify(j)).not.toMatch(/19\.99|1999/);
    expect(await childSummary(p)).toBeNull();
  });
});
