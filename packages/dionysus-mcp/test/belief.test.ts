import { describe, it, expect } from "vitest";
import {
  canonicalFeatureKey,
  scoreCraftBelief,
  MIN_EVIDENCE_FOR_CONFIDENCE,
  type FeatureEvidence,
} from "../src/lib/belief.js";

const NOW = new Date("2026-07-11T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("canonicalFeatureKey", () => {
  it("keys on the whitelisted dims that are present, sorted for stability", () => {
    expect(canonicalFeatureKey(`{"channel":"linkedin","format":"long"}`)).toBe(
      canonicalFeatureKey(`{"format":"long","channel":"linkedin"}`),
    );
    expect(canonicalFeatureKey(`{"channel":"linkedin"}`)).toBe("channel=linkedin");
  });

  it("ignores non-whitelisted / non-string dims and degrades to empty on junk", () => {
    expect(canonicalFeatureKey(`{"channel":"hackernews","radar":true}`)).toBe("channel=hackernews");
    expect(canonicalFeatureKey(`{}`)).toBe("");
    expect(canonicalFeatureKey(`not json`)).toBe("");
    expect(canonicalFeatureKey(`{"channel":123}`)).toBe("");
  });
});

describe("scoreCraftBelief", () => {
  it("is positive and high-confidence when the founder accepts as-is repeatedly", () => {
    const evidence: FeatureEvidence = { acceptedAsIs: 5, acceptedWithEdits: 0, rejected: 0, lastEventAt: daysAgo(1) };
    const b = scoreCraftBelief(evidence, NOW);
    expect(b.stance).toBe("positive");
    expect(b.lowConfidence).toBe(false);
    expect(b.confidence).toBeGreaterThan(0.6);
    expect(b.confidence).toBeLessThanOrEqual(1);
    expect(b.summary).toContain("5");
    expect(b.summary).not.toMatch(/%|percent|conversion|engagement/i);
  });

  it("is negative when the founder rejects or heavily edits", () => {
    const evidence: FeatureEvidence = { acceptedAsIs: 0, acceptedWithEdits: 1, rejected: 4, lastEventAt: daysAgo(2) };
    const b = scoreCraftBelief(evidence, NOW);
    expect(b.stance).toBe("negative");
  });

  it("labels a thin-evidence belief low-confidence regardless of direction", () => {
    const evidence: FeatureEvidence = { acceptedAsIs: 1, acceptedWithEdits: 0, rejected: 0, lastEventAt: daysAgo(1) };
    const b = scoreCraftBelief(evidence, NOW);
    expect(b.lowConfidence).toBe(true);
    expect(b.confidence).toBeLessThan(0.5);
    expect(b.summary.toLowerCase()).toContain("still learning");
  });

  it("decays confidence when all the evidence is stale", () => {
    const fresh = scoreCraftBelief({ acceptedAsIs: 5, acceptedWithEdits: 0, rejected: 0, lastEventAt: daysAgo(1) }, NOW);
    const stale = scoreCraftBelief({ acceptedAsIs: 5, acceptedWithEdits: 0, rejected: 0, lastEventAt: daysAgo(180) }, NOW);
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  it("returns neutral, low-confidence, zero-confidence when there is no evidence", () => {
    const b = scoreCraftBelief({ acceptedAsIs: 0, acceptedWithEdits: 0, rejected: 0, lastEventAt: null }, NOW);
    expect(b.stance).toBe("neutral");
    expect(b.lowConfidence).toBe(true);
    expect(b.confidence).toBe(0);
  });

  it("keeps MIN_EVIDENCE_FOR_CONFIDENCE at 3", () => {
    expect(MIN_EVIDENCE_FOR_CONFIDENCE).toBe(3);
  });
});
