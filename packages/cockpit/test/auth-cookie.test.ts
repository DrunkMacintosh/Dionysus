import { describe, it, expect } from "vitest";
import { sessionCookieOptions } from "../src/lib/auth";
describe("sessionCookieOptions (session-cookie hardening)", () => {
  it("is httpOnly, lax, root-path, with a positive maxAge", () => {
    const o = sessionCookieOptions();
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe("/");
    expect(o.maxAge).toBeGreaterThan(0);
  });
  it("secure follows NODE_ENV=production", () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(sessionCookieOptions().secure).toBe(true);
      process.env.NODE_ENV = "development";
      expect(sessionCookieOptions().secure).toBe(false);
    } finally { process.env.NODE_ENV = prev; }
  });
});
