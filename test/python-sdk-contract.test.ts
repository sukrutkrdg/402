import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Python SDK Contract (sdk/python)", () => {
  const sdkDir = path.resolve(__dirname, "../sdk/python");

  it("includes valid pyproject.toml configuration", () => {
    const pyprojectPath = path.join(sdkDir, "pyproject.toml");
    expect(fs.existsSync(pyprojectPath)).toBe(true);

    const content = fs.readFileSync(pyprojectPath, "utf-8");
    expect(content).toContain('name = "x402-bazaar"');
    expect(content).toContain('version = "1.0.0"');
    expect(content).toContain("requests");
  });

  it("includes package files with valid class declarations", () => {
    const initPath = path.join(sdkDir, "x402_bazaar/__init__.py");
    const clientPath = path.join(sdkDir, "x402_bazaar/client.py");
    const toolsPath = path.join(sdkDir, "x402_bazaar/tools.py");

    expect(fs.existsSync(initPath)).toBe(true);
    expect(fs.existsSync(clientPath)).toBe(true);
    expect(fs.existsSync(toolsPath)).toBe(true);

    const clientContent = fs.readFileSync(clientPath, "utf-8");
    expect(clientContent).toContain("class X402BazaarClient:");
    expect(clientContent).toContain("def audit_token(");
    expect(clientContent).toContain("def get_arbitrage_spreads(");
    expect(clientContent).toContain("def stream_events(");
    expect(clientContent).toContain("bc_pa0gqlv1");

    const toolsContent = fs.readFileSync(toolsPath, "utf-8");
    expect(toolsContent).toContain("class X402AuditTool");
    expect(toolsContent).toContain("class X402ArbitrageTool");
  });

  it("includes thorough README documentation with code snippets", () => {
    const readmePath = path.join(sdkDir, "README.md");
    expect(fs.existsSync(readmePath)).toBe(true);

    const readmeContent = fs.readFileSync(readmePath, "utf-8");
    expect(readmeContent).toContain("pip install x402-bazaar");
    expect(readmeContent).toContain("X402BazaarClient");
    expect(readmeContent).toContain("LangChain");
  });
});
