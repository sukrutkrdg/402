import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

describe("x402-bazaar CLI (bin/x402-bazaar.js)", () => {
  const cliPath = path.resolve(__dirname, "../bin/x402-bazaar.js");

  it("executes 'help' command and prints usage options", () => {
    const output = execSync(`node "${cliPath}" help`, { encoding: "utf-8" });
    expect(output).toContain("x402 BAZAAR — AUTONOMOUS AGENT CLI");
    expect(output).toContain("Commands:");
    expect(output).toContain("audit <address>");
    expect(output).toContain("spread <address>");
  });

  it("executes 'status' command and outputs network telemetry", () => {
    const output = execSync(`node "${cliPath}" status`, { encoding: "utf-8" });
    expect(output).toContain("Base Mainnet (8453)");
    expect(output).toContain("bc_pa0gqlv1");
    expect(output).toContain("EIP-3009");
  });

  it("executes 'audit' command on a target contract", () => {
    const output = execSync(`node "${cliPath}" audit 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed`, {
      encoding: "utf-8",
    });
    expect(output).toContain("Running atomic Pre-Trade Security Probe");
    expect(output).toContain("Honeypot:    FALSE");
    expect(output).toContain("Decision Receipt");
  });
});
