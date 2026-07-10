import { describe, it, expect } from "vitest";
import { gradeObjective, MIN_WEEKS_TO_JUDGE, STALL_WEEKS, type ObjectiveStats } from "../src/lib/cmo-verdict.js";

const base: ObjectiveStats = {
  weeksActive: 4, executedTotal: 5, executedRecent: 3, executedThisWeek: 1,
  inFlight: 1, proposedPending: 2, analyticsConnected: false,
};

describe("gradeObjective (honesty engine)", () => {
  it("getting-started when nothing has ever shipped — headline leads with the truth (nothing live)", () => {
    const v = gradeObjective({ ...base, executedTotal: 0 });
    expect(v.state).toBe("getting-started");
    expect(v.claimsMetricMoved).toBe(false);
    expect(v.headline.toLowerCase()).toMatch(/nothing/);
  });
  it("getting-started when too few weeks to judge but work HAS shipped — headline must not falsely say nothing is live", () => {
    const v = gradeObjective({ ...base, weeksActive: MIN_WEEKS_TO_JUDGE - 1 }); // executedTotal: 5
    expect(v.state).toBe("getting-started");
    expect(v.claimsMetricMoved).toBe(false);
    // too-new-but-shipped: leads with the truth, never the false "nothing has gone live yet"
    expect(v.headline.toLowerCase()).not.toMatch(/nothing/);
    expect(v.headline.toLowerCase()).toMatch(/5|early/);
  });
  it("shipping-unmeasured when work is live but no analytics — leads with the gap, claims nothing", () => {
    const v = gradeObjective(base);
    expect(v.state).toBe("shipping-unmeasured");
    expect(v.claimsMetricMoved).toBe(false);
    expect(v.recommendation.toLowerCase()).toMatch(/connect/);
  });
  it("stalled when nothing has gone live for the stall window despite a history", () => {
    const v = gradeObjective({ ...base, executedRecent: 0, weeksActive: STALL_WEEKS });
    expect(v.state).toBe("stalled");
    expect(v.recommendation.toLowerCase()).toMatch(/route|pause/);
    expect(v.claimsMetricMoved).toBe(false);
  });
  it("measured-working ONLY when analytics connected AND the metric rose (stage-5 branch)", () => {
    const v = gradeObjective({ ...base, analyticsConnected: true, metricDeltaPct: 12 });
    expect(v.state).toBe("measured-working");
    expect(v.claimsMetricMoved).toBe(true);
  });
  it("measured-flat when analytics connected but the number did not rise", () => {
    const v = gradeObjective({ ...base, analyticsConnected: true, metricDeltaPct: 0 });
    expect(v.state).toBe("measured-flat");
    expect(v.claimsMetricMoved).toBe(false);
  });

  it("boundary: weeksActive === MIN_WEEKS_TO_JUDGE with shipped work + no analytics is shipping-unmeasured, not getting-started (strict <)", () => {
    const v = gradeObjective({ ...base, weeksActive: MIN_WEEKS_TO_JUDGE, executedTotal: 5, analyticsConnected: false });
    expect(v.state).toBe("shipping-unmeasured");
    expect(v.claimsMetricMoved).toBe(false);
  });

  it("HONESTY INVARIANT: with analytics disconnected, no verdict ever claims the metric moved — even if a delta is present", () => {
    // sweep a wide range of disconnected stats — none may claim the number moved.
    // metricDeltaPct is swept too (including real values) to prove analyticsConnected
    // ALONE gates the measured branch, not the metricDeltaPct !== undefined guard.
    for (const weeksActive of [0, 1, 2, 3, 5, 10])
      for (const executedTotal of [0, 1, 5, 50])
        for (const executedRecent of [0, 1, 5])
          for (const executedThisWeek of [0, 1, 3])
            for (const metricDeltaPct of [undefined, 12, -5]) {
              const v = gradeObjective({ weeksActive, executedTotal, executedRecent, executedThisWeek,
                inFlight: 0, proposedPending: 0, analyticsConnected: false, metricDeltaPct });
              expect(v.claimsMetricMoved).toBe(false);
              expect(v.state).not.toBe("measured-working");
              expect(v.state).not.toBe("measured-flat");
            }
  });
});
