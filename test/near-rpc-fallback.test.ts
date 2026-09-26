import { describe, it, expect, afterEach, vi } from "vitest";
import { viewCall } from "@/lib/near-rpc";

afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/**
 * A node's own trouble is not the contract's answer. viewCall used to return
 * null for an INTERNAL_ERROR from the first RPC, and null means "no such method"
 * to its callers — a charged verdict built on an outage.
 */
describe("rpcQuery falls through on node errors", () => {
  it("asks the next RPC when the first one has an internal error", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return reply({ error: { cause: { name: "INTERNAL_ERROR" }, message: "Internal error" } });
      return reply({ result: { result: [...Buffer.from(JSON.stringify("7"))] } });
    });
    expect(await viewCall<string>("wrap.near", "ft_total_supply")).toBe("7");
    expect(calls.length).toBe(2);
  });

  it("throws (not charged) when every RPC is in trouble, instead of answering null", async () => {
    vi.stubGlobal("fetch", async () => reply({ error: { cause: { name: "TIMEOUT_ERROR" }, message: "timeout" } }));
    await expect(viewCall("wrap.near", "ft_total_supply")).rejects.toThrow(/not charged/);
  });

  it("still returns null for a real contract error", async () => {
    vi.stubGlobal("fetch", async () => reply({ error: { cause: { name: "NO_CONTRACT_CODE" }, message: "no code" } }));
    expect(await viewCall("alice.near", "ft_total_supply")).toBeNull();
  });
});
