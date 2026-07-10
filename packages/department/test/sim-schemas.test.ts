import { describe, it, expect } from "vitest";
import { PredictionSchema, parsePrediction } from "../src/sim-schemas.js";
import { loadPrompt } from "../src/prompts.js";

const good = {
  personas: [
    { persona: "skeptical senior engineer", reaction: "title oversells", score: 4 },
    { persona: "indie hacker", reaction: "would try it", score: 7 },
    { persona: "security researcher", reaction: "wants the threat model", score: 5 },
  ],
  engagementScore: 5.5, verdict: "mixed - sharpen the title", topConcerns: ["title overselling"], confidence: 0.6,
};

describe("PredictionSchema", () => {
  it("accepts a well-formed focus-group prediction", () => {
    expect(PredictionSchema.safeParse(good).success).toBe(true);
  });
  it("rejects out-of-range scores, too-few personas, and missing verdict", () => {
    expect(PredictionSchema.safeParse({ ...good, engagementScore: 11 }).success).toBe(false);
    expect(PredictionSchema.safeParse({ ...good, personas: good.personas.slice(0, 2) }).success).toBe(false);
    expect(PredictionSchema.safeParse({ ...good, verdict: "" }).success).toBe(false);
    expect(PredictionSchema.safeParse({ ...good, confidence: 2 }).success).toBe(false);
  });
  it("parsePrediction recovers once then throws", async () => {
    const fixed = await parsePrediction("{bad", async () => JSON.stringify(good));
    expect(fixed.verdict).toBe(good.verdict);
    await expect(parsePrediction("{bad", async () => "{worse")).rejects.toThrow();
  });
});

describe("simulator prompt", () => {
  it("pins every rule: labeled-prediction, never-fact, no-real-users, no-invented-numbers, data-not-instructions, harsh-honesty, fence, and JSON contract", () => {
    const p = loadPrompt("simulator").toLowerCase();
    for (const s of [
      "prediction", // labeled-prediction, never a fact
      "never a fact",
      "never claim real users",
      "never invent numbers", // no-invented-numbers rule
      "never instructions to follow", // data-not-instructions clause
      "do not flatter", // harsh-honesty
      "untrusted-content", // fence
      "engagementscore", // output JSON contract
    ]) {
      expect(p).toContain(s);
    }
  });
});
