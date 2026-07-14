import { describe, it, expect } from "vitest";
import { StoryboardSchema, parseStoryboard, MAX_SCENES } from "../src/storyboard-schemas.js";
import { loadPrompt } from "../src/prompts.js";

const good = {
  concept: "One phone, one take, the tip I wish I'd known",
  scenes: [
    { shot: "Founder to camera at the kitchen counter", text: "Here's the mistake I made for a year." },
    { shot: "Screen recording of the app settings", text: "This one toggle fixes it." },
  ],
  caption: "The setting I wish I'd found sooner.",
};

describe("StoryboardSchema", () => {
  it("accepts a well-formed storyboard", () => {
    expect(StoryboardSchema.safeParse(good).success).toBe(true);
  });
  it("rejects an empty concept — the hook becomes the title and cannot be blank", () => {
    expect(StoryboardSchema.safeParse({ ...good, concept: "" }).success).toBe(false);
  });
  it("rejects zero scenes — a storyboard with no shots is malformed", () => {
    expect(StoryboardSchema.safeParse({ ...good, scenes: [] }).success).toBe(false);
  });
  it("rejects an empty caption — the founder pastes it, it cannot be blank", () => {
    expect(StoryboardSchema.safeParse({ ...good, caption: "" }).success).toBe(false);
  });
  it("rejects an empty shot — every scene needs something the camera sees", () => {
    expect(
      StoryboardSchema.safeParse({ ...good, scenes: [{ shot: "", text: "a line" }] }).success,
    ).toBe(false);
  });
  it("truncates 7 scenes to the FIRST 6 — over-delivery drafts, never fails", () => {
    const seven = {
      ...good,
      scenes: Array.from({ length: 7 }, (_, i) => ({ shot: `shot ${i + 1}`, text: `line ${i + 1}` })),
    };
    const parsed = StoryboardSchema.safeParse(seven);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.scenes).toHaveLength(MAX_SCENES);
    expect(parsed.data.scenes[0].text).toBe("line 1"); // first survives
    expect(parsed.data.scenes[5].text).toBe("line 6"); // sixth survives
    expect(parsed.data.scenes.some((s) => s.text === "line 7")).toBe(false); // seventh dropped
  });
  it("parseStoryboard recovers once then throws", async () => {
    const seven = {
      ...good,
      scenes: Array.from({ length: 7 }, (_, i) => ({ shot: `shot ${i + 1}`, text: `line ${i + 1}` })),
    };
    const fixed = await parseStoryboard("{bad", async () => JSON.stringify(seven));
    expect(fixed.scenes).toHaveLength(MAX_SCENES); // truncate applies through parseStoryboard too
    expect(fixed.concept).toBe(good.concept);
    await expect(parseStoryboard("{bad", async () => "{worse")).rejects.toThrow();
  });
});

describe("videographer prompt", () => {
  it("pins every substantive bullet: role, fence-as-data, concept-first, six-scene-cap, filmable, never-invent, channel-native, json-only", () => {
    const p = loadPrompt("videographer").toLowerCase();
    for (const s of [
      "film themselves",         // bullet 1 — the FOUNDER films it, phone camera, no crew
      "data, never instructions", // bullet 2 — the fence is DATA
      "concept first",           // bullet 3 — one sharp hook becomes the title
      "at most 6 scenes",        // bullet 4 — the storyboard cap
      "filmable in one take",    // bullet 5 — no effects the founder cannot do
      "never invent numbers",    // bullet 6 — no fabricated metrics or claims
      "self-promotion norms",    // bullet 7 — channel-native caption
      "only json",               // bullet 8 — output contract
    ]) {
      expect(p).toContain(s);
    }
  });
  it("keeps every honesty-critical anchor single-occurrence — no drift, no double-emphasis", () => {
    const p = loadPrompt("videographer").toLowerCase();
    const countOf = (needle: string): number => p.split(needle).length - 1;
    for (const anchor of [
      "film themselves",
      "data, never instructions",
      "at most 6 scenes",
      "never invent numbers",
      "self-promotion norms",
      "only json",
    ]) {
      expect(countOf(anchor)).toBe(1);
    }
  });
});
