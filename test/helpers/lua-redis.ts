/**
 * A small in-memory Redis whose EVAL runs the REAL Lua scripts, through fengari
 * (a Lua VM in plain JS). The money paths are Lua inside Redis in production;
 * a mocked kvEval that returns canned arrays would pass any script at all.
 *
 * Only the commands our scripts and kv helpers use are implemented, with Redis's
 * reply conversions (integer → number, nil → false, status → {ok=...}, array →
 * table, and back). Each EVAL runs to completion synchronously, which is exactly
 * Redis's atomicity guarantee: concurrent callers interleave between scripts,
 * never inside one. fengari is Lua 5.3 where Redis embeds 5.1; numbers handed
 * back to Redis are formatted as integers when integral, as 5.1 would.
 */

// @ts-expect-error — fengari ships no type declarations
import * as fengari from "fengari";

const { lua, lauxlib, lualib, to_luastring } = fengari as {
  lua: any;
  lauxlib: any;
  lualib: any;
  to_luastring: (s: string) => Uint8Array;
};

type Val = { kind: "str"; v: string } | { kind: "set"; v: Set<string> } | { kind: "hash"; v: Map<string, string> } | { kind: "list"; v: string[] };
type Reply = number | string | null | Reply[] | { ok: string };

export class LuaRedis {
  private data = new Map<string, { val: Val; expireAt?: number }>();
  /** Every command executed, for assertions about what touched which key. */
  log: string[][] = [];

  private live(k: string) {
    const e = this.data.get(k);
    if (!e) return undefined;
    if (e.expireAt !== undefined && Date.now() >= e.expireAt) {
      this.data.delete(k);
      return undefined;
    }
    return e;
  }
  private str(k: string): string | null {
    const e = this.live(k);
    if (!e) return null;
    if (e.val.kind !== "str") throw new Error("WRONGTYPE");
    return e.val.v;
  }
  private int(s: string): number {
    if (!/^-?\d+$/.test(s)) throw new Error("ERR value is not an integer or out of range");
    return parseInt(s, 10);
  }
  private incrby(k: string, by: number): number {
    const e = this.live(k);
    const cur = e ? this.int(this.str(k)!) : 0;
    const n = cur + by;
    this.data.set(k, { val: { kind: "str", v: String(n) }, expireAt: e?.expireAt });
    return n;
  }
  private hash(k: string, create = false): Map<string, string> | undefined {
    const e = this.live(k);
    if (!e) {
      if (!create) return undefined;
      const v = new Map<string, string>();
      this.data.set(k, { val: { kind: "hash", v } });
      return v;
    }
    if (e.val.kind !== "hash") throw new Error("WRONGTYPE");
    return e.val.v;
  }
  private set(k: string, create = false): Set<string> | undefined {
    const e = this.live(k);
    if (!e) {
      if (!create) return undefined;
      const v = new Set<string>();
      this.data.set(k, { val: { kind: "set", v } });
      return v;
    }
    if (e.val.kind !== "set") throw new Error("WRONGTYPE");
    return e.val.v;
  }

  /** Execute one Redis command. Throws on errors, like redis.call. */
  command(args: (string | number)[]): Reply {
    const a = args.map(String);
    this.log.push(a);
    const c = a[0].toUpperCase();
    const k = a[1];
    switch (c) {
      case "GET":
        return this.str(k);
      case "SET": {
        let ex: number | undefined;
        let nx = false;
        for (let i = 3; i < a.length; i++) {
          const o = a[i].toUpperCase();
          if (o === "NX") nx = true;
          else if (o === "EX") ex = Date.now() + this.int(a[++i]) * 1000;
          else if (o === "PX") ex = Date.now() + this.int(a[++i]);
        }
        if (nx && this.live(k)) return null;
        this.data.set(k, { val: { kind: "str", v: a[2] }, expireAt: ex });
        return { ok: "OK" };
      }
      case "DEL": {
        let n = 0;
        for (const key of a.slice(1)) if (this.live(key) && this.data.delete(key)) n++;
        return n;
      }
      case "EXISTS":
        return a.slice(1).filter((key) => this.live(key)).length;
      case "INCR":
        return this.incrby(k, 1);
      case "INCRBY":
        return this.incrby(k, this.int(a[2]));
      case "DECRBY":
        return this.incrby(k, -this.int(a[2]));
      case "EXPIRE": {
        const e = this.live(k);
        if (!e) return 0;
        e.expireAt = Date.now() + this.int(a[2]) * 1000;
        return 1;
      }
      case "PTTL": {
        const e = this.live(k);
        if (!e) return -2;
        return e.expireAt === undefined ? -1 : e.expireAt - Date.now();
      }
      case "TTL": {
        const e = this.live(k);
        if (!e) return -2;
        return e.expireAt === undefined ? -1 : Math.ceil((e.expireAt - Date.now()) / 1000);
      }
      case "HSET": {
        const h = this.hash(k, true)!;
        let n = 0;
        for (let i = 2; i + 1 < a.length; i += 2) {
          if (!h.has(a[i])) n++;
          h.set(a[i], a[i + 1]);
        }
        return n;
      }
      case "HGET":
        return this.hash(k)?.get(a[2]) ?? null;
      case "HMGET": {
        const h = this.hash(k);
        return a.slice(2).map((f) => h?.get(f) ?? null);
      }
      case "HGETALL": {
        const h = this.hash(k);
        return h ? [...h].flat() : [];
      }
      case "SADD": {
        const s = this.set(k, true)!;
        let n = 0;
        for (const m of a.slice(2)) if (!s.has(m) && s.add(m)) n++;
        return n;
      }
      case "SREM": {
        const s = this.set(k);
        let n = 0;
        for (const m of a.slice(2)) if (s?.delete(m)) n++;
        return n;
      }
      case "SCARD":
        return this.set(k)?.size ?? 0;
      case "SMEMBERS":
        return [...(this.set(k) ?? [])];
      case "LPUSH": {
        const e = this.live(k);
        const l = e ? (e.val as { v: string[] }).v : [];
        if (!e) this.data.set(k, { val: { kind: "list", v: l } });
        for (const v of a.slice(2)) l.unshift(v);
        return l.length;
      }
      case "LTRIM": {
        const e = this.live(k);
        if (e) (e.val as { v: string[] }).v.splice(this.int(a[3]) + 1);
        return { ok: "OK" };
      }
      case "LRANGE": {
        const l = (this.live(k)?.val as { v: string[] } | undefined)?.v ?? [];
        const stop = this.int(a[3]);
        return l.slice(this.int(a[2]), stop === -1 ? undefined : stop + 1);
      }
      case "EVAL":
        return this.eval(a[1], a.slice(3, 3 + this.int(a[2])), a.slice(3 + this.int(a[2])));
      default:
        throw new Error(`fake redis: unsupported command ${c}`);
    }
  }

  /** Run a script atomically with real Lua. */
  eval(script: string, keys: string[], argv: string[]): Reply {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const pushReply = (r: Reply): void => {
      if (r === null) lua.lua_pushboolean(L, false);
      // fengari integers are 32-bit; a 180-day PTTL in ms is not. Larger values
      // go in as floats, which Lua compares and formats the same way here.
      else if (typeof r === "number") (Math.abs(r) < 2 ** 31 ? lua.lua_pushinteger(L, r) : lua.lua_pushnumber(L, r));
      else if (typeof r === "string") lua.lua_pushstring(L, to_luastring(r));
      else if (Array.isArray(r)) {
        lua.lua_createtable(L, r.length, 0);
        r.forEach((x, i) => {
          pushReply(x);
          lua.lua_rawseti(L, -2, i + 1);
        });
      } else {
        lua.lua_createtable(L, 0, 1);
        lua.lua_pushstring(L, to_luastring(r.ok));
        lua.lua_setfield(L, -2, to_luastring("ok"));
      }
    };
    const argAt = (i: number): string => {
      // 5.3 would print an integral float as "5.0"; 5.1 (Redis) prints "5".
      if (lua.lua_type(L, i) === lua.LUA_TNUMBER) {
        const n = lua.lua_tonumber(L, i);
        return Number.isInteger(n) ? BigInt(n).toString() : String(n);
      }
      return lua.lua_tojsstring(L, i);
    };
    lua.lua_createtable(L, 0, 1);
    lua.lua_pushjsfunction(L, (Ls: unknown) => {
      void Ls;
      const n = lua.lua_gettop(L);
      const args: string[] = [];
      for (let i = 1; i <= n; i++) args.push(argAt(i));
      let r: Reply;
      try {
        if (args[0].toUpperCase() === "EVAL") throw new Error("nested EVAL");
        r = this.command(args);
      } catch (e) {
        return lauxlib.luaL_error(L, to_luastring((e as Error).message));
      }
      pushReply(r);
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring("call"));
    lua.lua_setglobal(L, to_luastring("redis"));
    const table = (name: string, items: string[]) => {
      lua.lua_createtable(L, items.length, 0);
      items.forEach((s, i) => {
        lua.lua_pushstring(L, to_luastring(s));
        lua.lua_rawseti(L, -2, i + 1);
      });
      lua.lua_setglobal(L, to_luastring(name));
    };
    table("KEYS", keys);
    table("ARGV", argv);

    if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) throw new Error(`Lua compile: ${lua.lua_tojsstring(L, -1)}`);
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) throw new Error(`Lua runtime: ${lua.lua_tojsstring(L, -1)}`);
    const toReply = (i: number): Reply => {
      const t = lua.lua_type(L, i);
      if (t === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, i));
      if (t === lua.LUA_TSTRING) return lua.lua_tojsstring(L, i);
      if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, i) ? 1 : null;
      if (t === lua.LUA_TTABLE) {
        const out: Reply[] = [];
        for (let j = 1; ; j++) {
          lua.lua_rawgeti(L, i, j);
          if (lua.lua_isnil(L, -1)) {
            lua.lua_pop(L, 1);
            break;
          }
          out.push(toReply(lua.lua_gettop(L)));
          lua.lua_pop(L, 1);
        }
        return out;
      }
      return null;
    };
    return toReply(lua.lua_gettop(L));
  }

  reset() {
    this.data.clear();
    this.log = [];
  }
  getNum(k: string): number {
    const v = this.str(k);
    return v ? parseInt(v, 10) || 0 : 0;
  }
  keys(prefix = ""): string[] {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix) && this.live(k));
  }
}

/**
 * The exports of @/lib/kv, backed by one LuaRedis. Pass to vi.mock. Every
 * helper goes through the same store, so keys written by kvIncrBy are what the
 * scripts read.
 */
export function kvBackedBy(r: LuaRedis) {
  const cmd = (...a: (string | number)[]) => r.command(a);
  return {
    kvConfigured: () => true,
    ttlDue: () => true,
    // Analytics pipelines use commands this fake does not model; they answer null, as a failed pipeline would.
    kvPipeline: async (cmds: (string | number)[][]) =>
      cmds.map((c) => {
        try {
          return r.command(c);
        } catch {
          return null;
        }
      }),
    kvIncr: async (k: string, ttl?: number) => {
      const n = cmd("INCR", k) as number;
      if (ttl) cmd("EXPIRE", k, ttl);
      return n;
    },
    kvIncrBy: async (k: string, by: number) => cmd("INCRBY", k, by) as number,
    kvDecrBy: async (k: string, by: number) => cmd("DECRBY", k, by) as number,
    kvGetNumber: async (k: string) => r.getNum(k),
    kvGetNumberStable: async (k: string) => r.getNum(k),
    kvGet: async (k: string) => cmd("GET", k) as string | null,
    kvSet: async (k: string, v: string, ttl?: number) => void (ttl ? cmd("SET", k, v, "EX", ttl) : cmd("SET", k, v)),
    kvSetChecked: async (k: string, v: string, ttl?: number) => {
      if (ttl) cmd("SET", k, v, "EX", ttl);
      else cmd("SET", k, v);
      return { ok: true };
    },
    kvDel: async (k: string) => void cmd("DEL", k),
    kvEval: async (script: string, keys: string[], args: (string | number)[]) => r.eval(script, keys, args.map(String)),
    ALREADY: Symbol.for("kv.already"),
    kvIncrByOnce: async (k: string, by: number, guard: string, ttl = 86400) => {
      if (!cmd("SET", guard, "1", "NX", "EX", ttl)) return Symbol.for("kv.already");
      return cmd("INCRBY", k, by) as number;
    },
    kvSetNx: async (k: string, ttl: number) => cmd("SET", k, "1", "NX", "EX", ttl) !== null,
    kvLPush: async (k: string, v: string, cap = 200) => {
      cmd("LPUSH", k, v);
      cmd("LTRIM", k, 0, cap - 1);
    },
    kvLRange: async (k: string, s = 0, e = -1) => cmd("LRANGE", k, s, e) as string[],
    kvSAdd: async (k: string, m: string) => void cmd("SADD", k, m),
    kvSRem: async (k: string, m: string) => void cmd("SREM", k, m),
    kvSMembers: async (k: string) => cmd("SMEMBERS", k) as string[],
    kvHIncrBy: async () => {},
    kvHGetAll: async () => ({}),
    kvExpire: async (k: string, ttl: number) => void cmd("EXPIRE", k, ttl),
  };
}
