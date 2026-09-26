import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { DEBIT_MILLS_LUA, REFUND_MILLS_LUA } from "@/lib/credits";

/**
 * The sub-cent scripts run inside Redis in production, so they are tested inside
 * Redis: a mocked KV would pass any Lua at all. Skipped where no redis-server is
 * installed.
 */
const HAVE = ["/usr/bin/redis-server", "/usr/local/bin/redis-server"].some(existsSync);
const PORT = String(6390 + Math.floor(Math.random() * 500));
let srv: ChildProcess | null = null;

const cli = (...args: string[]) => execFileSync("redis-cli", ["-p", PORT, ...args], { encoding: "utf8" }).trim();
const evalLua = (script: string, keys: string[], args: (string | number)[]) =>
  cli("EVAL", script, String(keys.length), ...keys, ...args.map(String))
    .split("\n")
    .map((x) => Number(x.replace(/^\(integer\)\s*/, "")));
const get = (k: string) => {
  const v = cli("GET", k);
  return v === "" ? null : Number(v);
};

describe.skipIf(!HAVE)("sub-cent credit scripts, in real Redis", () => {
  beforeAll(async () => {
    srv = spawn("redis-server", ["--port", PORT, "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        if (cli("PING") === "PONG") return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("redis-server did not start");
  });
  afterAll(() => {
    srv?.kill();
  });

  const B = "credit:test", F = "credit:test:mills";

  it("five $0.002 calls take one cent, not five", () => {
    cli("SET", B, "5", "EX", "1000");
    cli("DEL", F);
    expect(evalLua(DEBIT_MILLS_LUA, [B, F], [2])).toEqual([0, 5, 2]);
    for (let i = 0; i < 3; i++) evalLua(DEBIT_MILLS_LUA, [B, F], [2]);
    expect(get(F)).toBe(8);
    expect(evalLua(DEBIT_MILLS_LUA, [B, F], [2])).toEqual([1, 4, 0]);
    expect(get(B)).toBe(4);
    expect(get(F)).toBeNull();
  });

  it("the remainder expires with the balance", () => {
    cli("SET", B, "5", "EX", "1000");
    evalLua(DEBIT_MILLS_LUA, [B, F], [5]);
    expect(Number(cli("PTTL", F))).toBeGreaterThan(0);
  });

  it("a refund is the exact inverse, including across a cent boundary", () => {
    cli("SET", B, "5", "EX", "1000");
    cli("DEL", F);
    for (let i = 0; i < 5; i++) evalLua(DEBIT_MILLS_LUA, [B, F], [2]); // 5¢ → 4¢, 0 owed
    expect(evalLua(REFUND_MILLS_LUA, [B, F, "refund:a"], [2])).toEqual([1]); // back to 5¢, 8 owed
    expect(get(B)).toBe(5);
    expect(get(F)).toBe(8); // 50 − 5×2 + 2 = 42 mills spendable = 5¢ − 8
  });

  it("a retried refund with the same guard applies once", () => {
    cli("SET", B, "5", "EX", "1000");
    cli("DEL", F);
    evalLua(DEBIT_MILLS_LUA, [B, F], [2]);
    expect(evalLua(REFUND_MILLS_LUA, [B, F, "refund:b"], [2])).toEqual([0]);
    expect(evalLua(REFUND_MILLS_LUA, [B, F, "refund:b"], [2])).toEqual([-9]);
    expect(get(B)).toBe(5);
    expect(get(F)).toBeNull();
  });

  it("refuses when the balance cannot cover it, and never creates a key for an unknown token", () => {
    cli("SET", B, "0");
    expect(evalLua(DEBIT_MILLS_LUA, [B, F], [2])[0]).toBe(-1);
    expect(evalLua(DEBIT_MILLS_LUA, ["credit:nobody", "credit:nobody:mills"], [2])[0]).toBe(-2);
    expect(get("credit:nobody")).toBeNull();
  });
});
