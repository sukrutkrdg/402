import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { goPlusSign, goPlusToken, goPlusHeaders, resetGoPlusAuth } from "@/lib/goplus-auth";

/** GoPlus app auth: sha1(app_key + time + app_secret) → access token → Bearer. Never breaks a call. */
describe("goplus-auth", () => {
  beforeEach(() => {
    resetGoPlusAuth();
    vi.stubEnv("GOPLUS_APP_KEY", "mBOMg20QW11BbtyH4Zh0");
    vi.stubEnv("GOPLUS_APP_SECRET", "V6aRfxlPJwN3ViJSIFSCdxPvneajuJsh");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("signs exactly as GoPlus documents", () => {
    expect(goPlusSign("mBOMg20QW11BbtyH4Zh0", 1647847498, "V6aRfxlPJwN3ViJSIFSCdxPvneajuJsh")).toBe("7293d385b9225b3c3f232b76ba97255d0e21063e");
  });

  it("fetches one token, caches it, and sends it as Bearer", async () => {
    const f = vi.fn(async () => ({ json: async () => ({ code: 1, result: { access_token: "tok123", expires_in: 3600 } }) }));
    vi.stubGlobal("fetch", f);
    const [a, b] = await Promise.all([goPlusToken(), goPlusToken()]);
    expect(a).toBe("tok123");
    expect(b).toBe("tok123");
    expect(await goPlusHeaders()).toEqual({ authorization: "Bearer tok123" });
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.app_key).toBe("mBOMg20QW11BbtyH4Zh0");
    expect(body.sign).toBe(goPlusSign(body.app_key, body.time, "V6aRfxlPJwN3ViJSIFSCdxPvneajuJsh"));
  });

  it("stays anonymous without a secret, or when the token call fails", async () => {
    vi.stubEnv("GOPLUS_APP_SECRET", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await goPlusHeaders()).toEqual({});
    expect(f).not.toHaveBeenCalled();

    resetGoPlusAuth();
    vi.stubEnv("GOPLUS_APP_SECRET", "s");
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ code: 4012, message: "signature verification failure" }) })));
    expect(await goPlusHeaders()).toEqual({});
  });
});
