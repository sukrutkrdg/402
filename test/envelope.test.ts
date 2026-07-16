import { describe, it, expect } from "vitest";
import { finish, riskSignal, severityRank, securityChecked } from "@/lib/envelope";

describe("envelope — canonical helpers", () => {
  it("finish stamps checkedAt but never overrides an existing one", () => {
    const a = finish({ x: 1 });
    expect(typeof a.checkedAt).toBe("string");
    const b = finish({ checkedAt: "2020-01-01T00:00:00.000Z", x: 1 });
    expect(b.checkedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("riskSignal reads score/level/decision across the historical aliases", () => {
    expect(riskSignal({ riskScore: 80, riskLevel: "high" })).toMatchObject({ score: 80, level: "high" });
    expect(riskSignal({ rugScore: 12, level: "low" })).toMatchObject({ score: 12, level: "low" });
    expect(riskSignal({ dangerLevel: "critical" }).level).toBe("critical");
    expect(riskSignal({ decision: "STOP" }).decision).toBe("STOP");
    expect(riskSignal({ verdict: "go" }).decision).toBe("go");
  });

  it("riskSignal infers degraded from an explicit flag or an unknown verdict", () => {
    expect(riskSignal({ level: "low" }).degraded).toBe(false);
    expect(riskSignal({ degraded: true }).degraded).toBe(true);
    expect(riskSignal({ level: "unknown" }).degraded).toBe(true);
    expect(riskSignal({ verdict: "unknown" }).degraded).toBe(true);
  });

  it("severityRank puts unknown just under high (unassessed ≠ safe)", () => {
    expect(severityRank("critical")).toBeLessThan(severityRank("high"));
    expect(severityRank("high")).toBeLessThan(severityRank("unknown"));
    expect(severityRank("unknown")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("low"));
  });

  it("securityChecked reflects the flag or a goplus source, false otherwise", () => {
    expect(securityChecked({ securityChecked: true })).toBe(true);
    expect(securityChecked({ securityChecked: false })).toBe(false);
    expect(securityChecked({ sources: ["base-rpc", "goplus"] })).toBe(true);
    expect(securityChecked({ sources: ["base-rpc"] })).toBe(false);
    expect(securityChecked(null)).toBe(false);
  });
});
