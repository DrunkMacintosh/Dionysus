import { describe, it, expect } from "vitest";
import { loadIdentity } from "../src/identity.js";

describe("ambient identity (D27.1)", () => {
  it("loads businessId from the environment", () => {
    const id = loadIdentity({ DIONYSUS_BUSINESS_ID: "biz_abc" });
    expect(id.businessId).toBe("biz_abc");
  });

  it("refuses to start without an identity", () => {
    expect(() => loadIdentity({})).toThrow(/DIONYSUS_BUSINESS_ID/);
    expect(() => loadIdentity({ DIONYSUS_BUSINESS_ID: "" })).toThrow(/DIONYSUS_BUSINESS_ID/);
  });
});
