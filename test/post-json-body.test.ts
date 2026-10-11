import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/x402/[service]/route";

describe("POST /api/x402/[service] - JSON Body Support", () => {
  it("processes parameters passed via JSON body without requiring them in query string", async () => {
    const ip = `10.200.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
    const req = new NextRequest("https://402.com.tr/api/x402/hash", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-402-free": "1",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({
        input: "hello world",
        algo: "sha256",
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ service: "hash" }) });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.data.algo).toBe("sha256");
    expect(json.data.hash).toBe("0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("handles large text payloads in JSON body without URL length truncation", async () => {
    const ip = `10.201.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
    const largeInput = "A".repeat(4000); // 4KB string
    const req = new NextRequest("https://402.com.tr/api/x402/hash", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-402-free": "1",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({
        input: largeInput,
        algo: "sha256",
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ service: "hash" }) });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.data.inputBytes).toBe(4000);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new NextRequest("https://402.com.tr/api/x402/hash", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "not-a-json-string{",
    });

    const res = await POST(req, { params: Promise.resolve({ service: "hash" }) });
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toMatch(/JSON/);
  });

  it("returns 404 when service is unknown", async () => {
    const req = new NextRequest("https://402.com.tr/api/x402/unknown-service-xyz", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ service: "unknown-service-xyz" }) });
    expect(res.status).toBe(404);
  });
});
