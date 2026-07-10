/**
 * §3 / D21 / D31 honesty engine — the pure, reviewable core of the CMO report.
 *
 * The report NEVER claims the objective's metric moved unless a real analytics
 * integration is connected. `claimsMetricMoved` is the machine-checkable hook for
 * that invariant: it is TRUE only for the `measured-working` state, which is only
 * reachable when `analyticsConnected === true` (stage 5). At 4f analytics is always
 * disconnected, so every verdict is one of the unmeasured states, each of which
 * LEADS its headline with the truth (the gap, the flat weeks, or the progress).
 *
 * HONESTY INVARIANT (the eval-gate core):
 *   claimsMetricMoved === true  ⟹  state === "measured-working"  ⟹  analyticsConnected === true
 *
 * Pure: no I/O, no clock, no prisma. Deterministic given its inputs. The clock and
 * the metric name enter via `buildCmoReport`; headlines here stay metric-agnostic
 * ("your number") and the caller may post-substitute the real metric name.
 */

/** Below this many whole weeks active (or zero ever shipped) → getting-started. */
export const MIN_WEEKS_TO_JUDGE = 2;
/** This many weeks with nothing going live → stalled. */
export const STALL_WEEKS = 3;

export type ObjectiveStats = {
  weeksActive: number; // whole weeks since the business's route began
  executedTotal: number; // lifetime verified sends
  executedRecent: number; // verified sends in the last STALL_WEEKS weeks
  executedThisWeek: number; // verified sends in the last 7 days
  inFlight: number; // approved + executing
  proposedPending: number; // proposed drafts awaiting review
  analyticsConnected: boolean; // 4f: always false
  metricDeltaPct?: number; // stage 5 only: measured % change in the objective metric
};

export type VerdictState =
  | "getting-started"
  | "shipping-unmeasured"
  | "stalled" // unmeasured (4f-reachable)
  | "measured-working"
  | "measured-flat"; // measured (stage-5-only)

export type Verdict = {
  state: VerdictState;
  headline: string; // one honest sentence — LEADS with the truth (gap/flat/progress)
  recommendation: string; // what changes next week
  claimsMetricMoved: boolean; // TRUE only for measured-working — the honesty invariant hook
};

/**
 * Grade a single objective's execution stats into an honest verdict. Branch order
 * is load-bearing: getting-started → stalled → measured → shipping-unmeasured.
 */
export function gradeObjective(stats: ObjectiveStats): Verdict {
  const {
    weeksActive,
    executedTotal,
    executedRecent,
    analyticsConnected,
    metricDeltaPct,
  } = stats;

  // 1. Nothing has ever gone live, or too new to judge. The headline must LEAD
  //    with the truth: when work has already shipped (too-new sub-case), saying
  //    "nothing has gone live" is a false headline — branch on executedTotal.
  if (executedTotal === 0 || weeksActive < MIN_WEEKS_TO_JUDGE) {
    return {
      state: "getting-started",
      headline:
        executedTotal === 0
          ? "Nothing has gone live yet — this loop is just getting set up."
          : `Still early — ${executedTotal} send(s) have gone live, but it's too soon to judge the loop.`,
      recommendation:
        "Approve and send the first drafts so there is real work to measure.",
      claimsMetricMoved: false,
    };
  }

  // 2. A lifetime history exists, but work has stopped going live for the stall
  //    window. A genuinely stalled loop is stalled regardless of analytics.
  if (executedRecent === 0 && weeksActive >= STALL_WEEKS) {
    return {
      state: "stalled",
      headline: `Nothing has gone live in the last ${STALL_WEEKS} weeks despite earlier activity.`,
      recommendation:
        "Consider a route change or a deliberate pause — the current loop has stopped shipping.",
      claimsMetricMoved: false,
    };
  }

  // 3. Measured branch (stage 5 only): analytics connected AND a delta is known.
  if (analyticsConnected && metricDeltaPct !== undefined) {
    if (metricDeltaPct > 0) {
      return {
        state: "measured-working",
        headline: `Your number is up ${metricDeltaPct}% since this objective's work went live.`,
        recommendation:
          "Keep the current route — it is moving the metric. Double down on what shipped.",
        claimsMetricMoved: true,
      };
    }
    return {
      state: "measured-flat",
      headline: "Work is shipping but your number has not moved.",
      recommendation:
        "Change the approach — the current work is live but not shifting the metric.",
      claimsMetricMoved: false,
    };
  }

  // 4. Work is going live, but analytics is not connected — lead with the honest gap.
  return {
    state: "shipping-unmeasured",
    headline: `${executedTotal} posts went live; we can't yet tell if they moved your number.`,
    recommendation:
      "Connect the objective's source so the report can grade real outcomes.",
    claimsMetricMoved: false,
  };
}
