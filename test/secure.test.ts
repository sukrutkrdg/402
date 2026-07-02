import { describe, it, expect } from "vitest";
import { safeEqual } from "@/lib/secure";

describe("safeEqual (constant-time token compare)", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(safeEqual("aaaaaa", "aaaaab")).toBe(false);
  });

  it("returns false for different lengths (no throw)", () => {
    expect(safeEqual("short", "longer-value")).toBe(false);
  });

  it("returns false when one side is empty", () => {
    expect(safeEqual("", "x")).toBe(false);
  });
});
