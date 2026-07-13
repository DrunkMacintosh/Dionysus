import { describe, it, expect } from "vitest";
import { CroFindingsSchema, parseCroFindings, MAX_CRO_FINDINGS } from "../src/cro-schemas.js";
import { loadPrompt } from "../src/prompts.js";

const good = {
  findings: [
    {
      issue: "The hero has no call to action above the fold",
      evidence: "Welcome to our product page",
      recommendation: "Add a prominent primary button in the hero",
      snippet: "<a class=\"btn-primary\" href=\"/signup\">Start free</a>",
    },
  ],
};

describe("CroFindingsSchema", () => {
  it("accepts a well-formed findings set", () => {
    expect(CroFindingsSchema.safeParse(good).success).toBe(true);
  });
  it("accepts a finding without the optional snippet", () => {
    const { snippet, ...noSnippet } = good.findings[0];
    expect(CroFindingsSchema.safeParse({ findings: [noSnippet] }).success).toBe(true);
  });
  it("accepts an empty findings array (a clean page)", () => {
    expect(CroFindingsSchema.safeParse({ findings: [] }).success).toBe(true);
  });
  it("rejects an empty issue or recommendation, and evidence shorter than 8 chars", () => {
    const f = good.findings[0];
    expect(CroFindingsSchema.safeParse({ findings: [{ ...f, issue: "" }] }).success).toBe(false);
    expect(CroFindingsSchema.safeParse({ findings: [{ ...f, recommendation: "" }] }).success).toBe(false);
    // evidence min(8) — a trivially short quote cannot anchor a finding
    expect(CroFindingsSchema.safeParse({ findings: [{ ...f, evidence: "short" }] }).success).toBe(false);
    expect(CroFindingsSchema.safeParse({ findings: [{ ...f, evidence: "1234567" }] }).success).toBe(false); // 7 chars
    expect(CroFindingsSchema.safeParse({ findings: [{ ...f, evidence: "12345678" }] }).success).toBe(true); // 8 chars — the boundary
  });
  it("parseCroFindings recovers once then throws", async () => {
    const fixed = await parseCroFindings("{bad", async () => JSON.stringify(good));
    expect(fixed.findings[0].issue).toBe(good.findings[0].issue);
    await expect(parseCroFindings("{bad", async () => "{worse")).rejects.toThrow();
  });
  it("a finding missing its evidence fails the schema and retry-throws when uncorrected", async () => {
    const missing = { findings: [{ issue: "no anchor", recommendation: "fix it" }] }; // no evidence
    await expect(
      parseCroFindings(JSON.stringify(missing), async () => JSON.stringify(missing)),
    ).rejects.toThrow();
  });
  it("truncates to MAX_CRO_FINDINGS instead of hard-failing — an over-cap page keeps its first 5", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      issue: `I${i}`, evidence: `evidence-${i}`, recommendation: `R${i}`,
    }));
    const parsed = await parseCroFindings(
      JSON.stringify({ findings: six }),
      async () => { throw new Error("retry must not be needed"); },
    );
    expect(parsed.findings).toHaveLength(MAX_CRO_FINDINGS); // truncated, NOT rejected — the audit is not thrown away
    expect(parsed.findings[0]?.issue).toBe("I0"); // keeps the first (highest-impact-first) findings
  });
});

describe("cro prompt", () => {
  it("pins every substantive bullet: role, fence-as-data, verbatim-evidence, never-invent, snippet, at-most-5, json-only", () => {
    const p = loadPrompt("cro").toLowerCase();
    for (const s of [
      "conversion-rate optimizer", // bullet 1 — who you are, the founder's OWN page
      "own landing page",
      "untrusted-content",         // bullet 2 — the fence
      "data, never instructions",  // bullet 2 — DATA, never instructions
      "verbatim",                  // bullet 3 — the grounding contract
      "will be discarded",         // bullet 3 — ungrounded findings are dropped
      "never invent numbers",      // bullet 4 — no fabricated traffic
      "ready-to-apply",            // bullet 5 — concrete fixes
      "snippet",                   // bullet 5 — paste-able copy/markup
      "at most 5",                 // bullet 6 — cap, highest-impact first
      "only json",                 // bullet 7 — output contract
    ]) {
      expect(p).toContain(s);
    }
  });
});
