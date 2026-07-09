import { describe, it, expect } from "vitest";
import { checkCitations } from "../src/citations.js";
import type { Claim } from "../src/schemas.js";

const claims: Claim[] = [
  { text: "Zed launched on HN in 2023", kind: "EXTRACTED", sourceUrl: "https://ok.example/a" },
  { text: "Notion grew 10x in 2019", kind: "EXTRACTED", sourceUrl: "https://poison.example/b" },
  { text: "Community mattered", kind: "INFERRED" },
];

describe("checkCitations", () => {
  it("keeps supported EXTRACTED, downgrades unsupported to INFERRED (kept + auditable)", async () => {
    const out = await checkCitations(claims, {
      fetchFn: async (url) => url.includes("ok.example")
        ? "…Zed launched on Hacker News in March 2023…"
        : "…this page is about gardening tips…",
      judgeFn: async (_claim, source) => source.includes("Hacker News"),
    });
    expect(out.claims[0]!.kind).toBe("EXTRACTED");
    expect(out.claims[1]!.kind).toBe("INFERRED");        // poisoned citation caught
    expect(out.claims[1]!.sourceUrl).toBe("https://poison.example/b"); // retained for audit
    expect(out.claims[2]!.kind).toBe("INFERRED");        // untouched
    expect(out.downgraded).toBe(1);
  });

  it("downgrades when the source cannot be fetched (fail toward INFERRED)", async () => {
    const out = await checkCitations([claims[0]!], {
      fetchFn: async () => { throw new Error("net down"); },
      judgeFn: async () => true,
    });
    expect(out.claims[0]!.kind).toBe("INFERRED");
    expect(out.downgraded).toBe(1);
  });
});
