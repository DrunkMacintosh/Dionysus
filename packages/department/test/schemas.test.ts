import { describe, it, expect } from "vitest";
import { ClaimSchema, HistorianOutputSchema, parseWithRetry } from "../src/schemas.js";
import { loadPrompt } from "../src/prompts.js";

describe("schemas", () => {
  it("EXTRACTED requires a sourceUrl; INFERRED does not", () => {
    expect(ClaimSchema.safeParse({ text: "x", kind: "EXTRACTED" }).success).toBe(false);
    expect(ClaimSchema.safeParse({ text: "x", kind: "EXTRACTED", sourceUrl: "https://a.b/c" }).success).toBe(true);
    expect(ClaimSchema.safeParse({ text: "x", kind: "INFERRED" }).success).toBe(true);
  });

  it("parseWithRetry recovers once, then throws", async () => {
    const good = JSON.stringify({ cases: [{ name: "n", platform: "p", mode: "m", rank: 1, claims: [] }] });
    const fixed = await parseWithRetry(HistorianOutputSchema, "{bad", async () => good);
    expect(fixed.cases[0]!.name).toBe("n");
    await expect(parseWithRetry(HistorianOutputSchema, "{bad", async () => "{worse")).rejects.toThrow();
  });
});

describe("prompts", () => {
  it("historian prompt carries the sourcing + fencing rules", () => {
    const p = loadPrompt("historian");
    for (const s of ["EXTRACTED", "INFERRED", "UNTRUSTED-CONTENT"]) expect(p).toContain(s);
  });
  it("historian prompt carries the research-frugality rule (execution-discovered: tool-loop context is quadratic)", () => {
    const p = loadPrompt("historian");
    for (const s of ["AT MOST 8 tool calls", "never re-fetch", "STOP researching"]) expect(p).toContain(s);
  });
});
