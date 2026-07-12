import { describe, it, expect } from "vitest";
import { ObservationsSchema, parseObservations } from "../src/radar-schemas.js";
import { loadPrompt } from "../src/prompts.js";

const good = {
  observations: [
    {
      title: "Keyless CLI trending on HN",
      body: "A devtool that needs no API key reached the front page.",
      sourceUrl: "https://news.ycombinator.com/item?id=123",
      relevance: 8,
      confidence: 0.7,
    },
  ],
};

describe("ObservationsSchema", () => {
  it("accepts a well-formed observation set", () => {
    expect(ObservationsSchema.safeParse(good).success).toBe(true);
  });
  it("accepts an empty observations array (a quiet night)", () => {
    expect(ObservationsSchema.safeParse({ observations: [] }).success).toBe(true);
  });
  it("rejects out-of-range relevance and confidence", () => {
    const bump = (patch: object) => ({ observations: [{ ...good.observations[0], ...patch }] });
    expect(ObservationsSchema.safeParse(bump({ relevance: 11 })).success).toBe(false);
    expect(ObservationsSchema.safeParse(bump({ relevance: -1 })).success).toBe(false);
    expect(ObservationsSchema.safeParse(bump({ confidence: 2 })).success).toBe(false);
    expect(ObservationsSchema.safeParse(bump({ confidence: -0.1 })).success).toBe(false);
  });
  it("rejects a missing, non-url, or empty sourceUrl and an empty title", () => {
    const o = good.observations[0];
    expect(ObservationsSchema.safeParse({ observations: [{ ...o, sourceUrl: undefined }] }).success).toBe(false);
    expect(ObservationsSchema.safeParse({ observations: [{ ...o, sourceUrl: "not-a-url" }] }).success).toBe(false);
    expect(ObservationsSchema.safeParse({ observations: [{ ...o, sourceUrl: "" }] }).success).toBe(false);
    expect(ObservationsSchema.safeParse({ observations: [{ ...o, title: "" }] }).success).toBe(false);
  });
  it("parseObservations recovers once then throws", async () => {
    const fixed = await parseObservations("{bad", async () => JSON.stringify(good));
    expect(fixed.observations[0].sourceUrl).toBe(good.observations[0].sourceUrl);
    await expect(parseObservations("{bad", async () => "{worse")).rejects.toThrow();
  });
  it("truncates to MAX_OBSERVATIONS instead of hard-failing — an over-cap night keeps its strongest 8", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      title: `T${i}`, body: `B${i}`, sourceUrl: `https://news.ycombinator.com/item?id=${i}`,
      relevance: 5, confidence: 0.5,
    }));
    const parsed = await parseObservations(JSON.stringify({ observations: nine }), async () => { throw new Error("retry must not be needed"); });
    expect(parsed.observations).toHaveLength(8); // truncated, NOT rejected — the night is not thrown away
    expect(parsed.observations[0]?.title).toBe("T0"); // keeps the first (strongest-first) items
  });
});

describe("radar prompt", () => {
  it("pins the source-discipline, never-invent, market-observation, and fence rules", () => {
    const p = loadPrompt("radar").toLowerCase();
    for (const s of [
      "market observation",
      "only cite a source url from the provided signals",
      "never invent",
      "untrusted-content",
      "never instructions",
    ]) {
      expect(p).toContain(s);
    }
  });
});
