import { describe, it, expect } from "vitest";
import { GET } from "../src/app/api/attestations/route";

describe("Base EAS Attestations API (/api/attestations)", () => {
  it("returns onchain EAS schema UID, contracts, and attestation list", async () => {
    const req = new Request("http://localhost:3000/api/attestations");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.network).toContain("Base Mainnet");
    expect(json.builderCode).toBe("bc_pa0gqlv1");
    expect(json.easContract).toBe("0x4200000000000000000000000000000000000021");
    expect(json.schemaRegistry).toBe("0x4200000000000000000000000000000000000020");
    expect(json.schemaUid).toBeDefined();
    expect(Array.isArray(json.attestations)).toBe(true);
    expect(json.attestations.length).toBeGreaterThanOrEqual(3);
  });

  it("filters attestations by token address accurately", async () => {
    const req = new Request(
      "http://localhost:3000/api/attestations?token=0xDEADBEEF0000000000000000000000000000CAFE"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.totalAttestations).toBe(1);
    expect(json.attestations[0].data.symbol).toBe("FAKE-BASE-REWARD");
    expect(json.attestations[0].data.scamType).toBe("HONEYPOT_SELL_PROHIBITED");
  });

  it("filters attestations by scam type query", async () => {
    const req = new Request("http://localhost:3000/api/attestations?type=mint");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.totalAttestations).toBe(1);
    expect(json.attestations[0].data.symbol).toBe("RUG-PEPE-AI");
  });
});
