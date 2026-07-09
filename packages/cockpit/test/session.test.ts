import { describe, it, expect } from "vitest";
import { createSessionToken, verifySessionToken } from "../src/lib/session";

const SECRET = "test-secret-please-rotate";
const payload = { businessId: "biz_a", email: "f@example.com", exp: Date.now() + 60_000 };

describe("session tokens", () => {
  it("round-trips a valid payload", () => {
    const token = createSessionToken(payload, SECRET);
    expect(verifySessionToken(token, SECRET)).toEqual(payload);
  });
  it("rejects a tampered body (signature mismatch)", () => {
    const token = createSessionToken(payload, SECRET);
    const [body, sig] = token.split(".");
    const evil = Buffer.from(JSON.stringify({ ...payload, businessId: "biz_b" }), "utf8").toString("base64url");
    expect(verifySessionToken(`${evil}.${sig}`, SECRET)).toBeNull();
    expect(verifySessionToken(`${body}.AAAA`, SECRET)).toBeNull();
  });
  it("rejects a wrong secret and an expired session", () => {
    const token = createSessionToken(payload, SECRET);
    expect(verifySessionToken(token, "other-secret")).toBeNull();
    const stale = createSessionToken({ ...payload, exp: Date.now() - 1 }, SECRET);
    expect(verifySessionToken(stale, SECRET)).toBeNull();
  });
  it("fail-closed: empty secret throws on create AND verify", () => {
    expect(() => createSessionToken(payload, "")).toThrow(/secret/i);
    expect(() => verifySessionToken("a.b", "")).toThrow(/secret/i);
  });
});
