import { describe, it, expect } from "vitest";
import { POST } from "../src/app/api/terminal/execute/route";
import { NextRequest } from "next/server";

describe("POST /api/terminal/execute", () => {
  it("executes help command and returns structured logs", async () => {
    const req = new NextRequest("http://localhost:3000/api/terminal/execute", {
      method: "POST",
      body: JSON.stringify({ command: "help" }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.logs.length).toBeGreaterThan(0);
    expect(data.result.availableCommands).toContain("audit");
  });

  it("executes audit command and simulates atomic pre-trade check", async () => {
    const req = new NextRequest("http://localhost:3000/api/terminal/execute", {
      method: "POST",
      body: JSON.stringify({ command: "audit 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.result.verdict).toBe("PASSED");
    expect(data.result.score).toBeGreaterThan(90);
  });
});
