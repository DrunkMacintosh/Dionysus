import { describe, it, expect } from "vitest";
import { DraftSchema, parseDraft } from "../src/draft-schemas.js";
import { loadPrompt } from "../src/prompts.js";

describe("DraftSchema", () => {
  it("accepts a channel-native draft with a non-empty body", () => {
    expect(DraftSchema.safeParse({ channel: "hackernews", kind: "post", content: { title: "Show HN", body: "We built X" } }).success).toBe(true);
  });
  it("rejects an empty body", () => {
    expect(DraftSchema.safeParse({ channel: "x", kind: "post", content: { body: "" } }).success).toBe(false);
  });
  it("parseDraft recovers once then throws", async () => {
    const good = JSON.stringify({ channel: "x", kind: "post", content: { body: "hi" } });
    const fixed = await parseDraft("{bad", async () => good);
    expect(fixed.content.body).toBe("hi");
    await expect(parseDraft("{bad", async () => "{worse")).rejects.toThrow();
  });
});

describe("copywriter prompt", () => {
  it("carries the drafts-only + no-fabricated-numbers + channel-norm + fence rules", () => {
    const p = loadPrompt("copywriter");
    for (const s of ["draft", "never invent", "norm", "UNTRUSTED-CONTENT"]) expect(p.toLowerCase()).toContain(s.toLowerCase());
  });
});
