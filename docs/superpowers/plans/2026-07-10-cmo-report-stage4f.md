# Stage 4f — Progress Home + Weekly CMO Report (Graded Honesty) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make outcome-accountability visible (the D31.A USP): a progress-to-objective home screen and a weekly CMO Report structured "what ran → what moved the number → what changes next week", with a **graded honesty verdict** that never claims the founder's number moved when no analytics are connected — and leads with that measurement gap instead.

**Architecture:** The honesty engine is a **pure `gradeObjective(stats)` function** (no DB — exhaustively unit-tested, the reviewable core). A `buildCmoReport(identity, now)` dionysus-mcp function does the identity-scoped Prisma reads, assembles the week's stats, and calls the grader. `analyticsConnected` is hardcoded `false` at 4f (the `Integration` model + real connection check are stage 5) — so only the unmeasured verdict states can fire, honest by construction. The cockpit gets a progress home (`/`) and a `/report` page; the existing route overview moves to `/route`.

**Tech Stack:** unchanged — Prisma 6, vitest, Next 15 cockpit. No new dependencies. No Stripe (explicitly out).

## Global Constraints

- **§3 / D21 / D31 honesty (the load-bearing rule):** the report NEVER claims the objective's metric moved unless a real analytics integration is connected (D21: "never claims unmeasured 'users'"). At 4f `analyticsConnected` is always `false`, so the grader's measured states are unreachable and every 4f verdict is one of the unmeasured states, each of which LEADS with the measurement gap. The verdict is never binary at small N — "getting started" and "shipping but unmeasured" are first-class states, not failures (D31.A).
- **D31.A verdict semantics:** ~3 flat weeks (work stopped going live) → the report LEADS with it and recommends a route change or a pause. The grader encodes this as the `stalled` state. The "traffic arrives but doesn't convert: fix the funnel" state needs click/conversion data → RESERVED for stage 5 (analytics), NOT graded at 4f.
- **D31 connection-rate = primary product metric:** whenever `analyticsConnected` is false, the home + report surface a "connect your number's source" call-to-action. At 4f this is an honest labeled CTA (the connection flow / `Integration` model is stage 5) — the CTA text is present; the wiring is deferred.
- **`analyticsConnected` is stage-5-seamed:** `gradeObjective` TAKES `analyticsConnected: boolean` + optional `metricDeltaPct?` as inputs (so stage 5 fills them from a real `Integration` check); `buildCmoReport` supplies `analyticsConnected: false` at 4f with a documented TODO. The grader's measured branch is implemented + unit-tested (passing `analyticsConnected: true`) so the honesty invariant is provable in both directions, even though 4f never triggers it.
- **D27.1:** identity ambient; every read scoped `businessId`; `buildCmoReport(identity, ...)` takes identity first; NOT an MCP tool (whitelist stays 11 — it's a cockpit-tier read like the review functions).
- **Pure grader:** `gradeObjective` does NO I/O, takes a plain stats object, returns a plain verdict object. Deterministic given its inputs (the clock enters via `buildCmoReport`, passed a `now`).
- **No new model:** `Integration` (analytics) is stage 5. 4f reads only existing tables (Objective, Route, RouteWaypoint, RouteAction, Asset, MemoryNode, Digest).
- **Testing:** TDD; no API key. Env: `$env:DATABASE_URL = "file:./.tmp/test.db"` (+ `$env:COCKPIT_SESSION_SECRET = "test-secret"` for cockpit). dionysus-mcp BUILT before dependents. Baselines: mcp 175, dept 78, cockpit 45 — dept stays green untouched. Pass an explicit `now` into `buildCmoReport` in tests (never rely on wall-clock).
- **Commits:** conventional, no attribution footer. **Shell:** Windows/PowerShell (Git Bash broken); pnpm workspace.

## File Structure

```
packages/dionysus-mcp/
  src/lib/cmo-verdict.ts            # gradeObjective (pure honesty engine) + types + constants
  src/tools/cmo-report.ts           # buildCmoReport (identity-scoped assembly, analyticsConnected=false)
  test/cmo-verdict.test.ts          # exhaustive grader tests (both measured + unmeasured)
  test/cmo-report.test.ts           # assembly tests (scoped, week window, verdict wiring)
packages/cockpit/
  src/lib/review.ts                 # + getCmoReport (scoped wrapper over buildCmoReport with a real clock)
  src/app/page.tsx                  # REPLACED: progress-to-objective home (objective + verdict + connect CTA + week snapshot)
  src/app/route/page.tsx            # NEW: the moved route/waypoint overview (was `/`)
  src/app/report/page.tsx           # NEW: the full weekly CMO report
  src/app/layout.tsx                # nav: Home · Route · Radar · Drafts · Send · Report
  test/review.test.ts               # + getCmoReport scoped test
  test/cmo-eval.e2e.test.ts         # Task 5 §15 gate
```

---

### Task 1: `gradeObjective` — the pure honesty engine

**Files:**
- Create: `packages/dionysus-mcp/src/lib/cmo-verdict.ts`
- Test: `packages/dionysus-mcp/test/cmo-verdict.test.ts`

**Interfaces:**
- Produces:
```ts
export const MIN_WEEKS_TO_JUDGE = 2;    // below this, or zero ever shipped → getting-started
export const STALL_WEEKS = 3;           // this many weeks with nothing going live → stalled

export type ObjectiveStats = {
  weeksActive: number;          // whole weeks since the business's route began
  executedTotal: number;        // lifetime verified sends
  executedRecent: number;       // verified sends in the last STALL_WEEKS weeks
  executedThisWeek: number;     // verified sends in the last 7 days
  inFlight: number;             // approved + executing
  proposedPending: number;      // proposed drafts awaiting review
  analyticsConnected: boolean;  // 4f: always false
  metricDeltaPct?: number;      // stage 5 only: measured % change in the objective metric
};

export type VerdictState =
  | "getting-started" | "shipping-unmeasured" | "stalled"   // unmeasured (4f-reachable)
  | "measured-working" | "measured-flat";                    // measured (stage-5-only)

export type Verdict = {
  state: VerdictState;
  headline: string;             // one honest sentence — LEADS with the truth (gap/flat/progress)
  recommendation: string;       // what changes next week
  claimsMetricMoved: boolean;   // TRUE only for measured-working — the honesty invariant hook
};

export function gradeObjective(stats: ObjectiveStats): Verdict;
```
- **Grading logic (exact):**
  1. `getting-started` — if `executedTotal === 0` OR `weeksActive < MIN_WEEKS_TO_JUDGE`. Headline: nothing has gone live yet / just getting set up. Recommendation: approve + send the first drafts. `claimsMetricMoved: false`.
  2. `stalled` — else if `!analyticsConnected` ... continue, but FIRST: if `executedRecent === 0 && weeksActive >= STALL_WEEKS` (work has stopped going live for the stall window despite a lifetime history). Headline LEADS with the flat weeks. Recommendation: consider a route change or a pause. `false`. (This branch applies whether or not analytics is connected — a genuinely stalled loop is stalled regardless.)
  3. **Measured branch** (`analyticsConnected === true && metricDeltaPct !== undefined`) — stage 5:
     - `measured-working` if `metricDeltaPct > 0`. Headline states the measured move. `claimsMetricMoved: true`.
     - `measured-flat` if `metricDeltaPct <= 0`. Headline: shipping but the number is flat. `false`.
  4. `shipping-unmeasured` — else (work is going live, analytics NOT connected). Headline LEADS with the honest gap ("N posts went live; we can't yet tell if they moved {metric}"). Recommendation: connect the objective's source so the report can grade real outcomes. `claimsMetricMoved: false`.
- **HONESTY INVARIANT (the eval-gate core):** `claimsMetricMoved === true` ⟹ `state === "measured-working"` ⟹ `analyticsConnected === true`. So with `analyticsConnected: false`, `claimsMetricMoved` is ALWAYS false and the state is never a measured one. (The metric name is threaded by `buildCmoReport` into the headline templates — the grader takes it as a field; add `metric: string` to `ObjectiveStats` for the templates, or keep templates metric-agnostic and let the caller interpolate. Keep it simple: grader emits headlines referencing "your number"/"the metric" generically; `buildCmoReport` may post-substitute the metric name.)

- [ ] **Step 1: Write the failing tests** — exhaustive, one per branch + the honesty invariant:

```ts
import { describe, it, expect } from "vitest";
import { gradeObjective, MIN_WEEKS_TO_JUDGE, STALL_WEEKS, type ObjectiveStats } from "../src/lib/cmo-verdict.js";

const base: ObjectiveStats = {
  weeksActive: 4, executedTotal: 5, executedRecent: 3, executedThisWeek: 1,
  inFlight: 1, proposedPending: 2, analyticsConnected: false,
};

describe("gradeObjective (honesty engine)", () => {
  it("getting-started when nothing has ever shipped", () => {
    const v = gradeObjective({ ...base, executedTotal: 0 });
    expect(v.state).toBe("getting-started");
    expect(v.claimsMetricMoved).toBe(false);
  });
  it("getting-started when too few weeks to judge", () => {
    expect(gradeObjective({ ...base, weeksActive: MIN_WEEKS_TO_JUDGE - 1 }).state).toBe("getting-started");
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

  it("HONESTY INVARIANT: with analytics disconnected, no verdict ever claims the metric moved", () => {
    // sweep a wide range of disconnected stats — none may claim the number moved
    for (const weeksActive of [0, 1, 2, 3, 5, 10])
      for (const executedTotal of [0, 1, 5, 50])
        for (const executedRecent of [0, 1, 5])
          for (const executedThisWeek of [0, 1, 3]) {
            const v = gradeObjective({ weeksActive, executedTotal, executedRecent, executedThisWeek,
              inFlight: 0, proposedPending: 0, analyticsConnected: false });
            expect(v.claimsMetricMoved).toBe(false);
            expect(v.state).not.toBe("measured-working");
            expect(v.state).not.toBe("measured-flat");
          }
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement `src/lib/cmo-verdict.ts`** per the exact grading logic (constants, the 4 unmeasured/measured branches in the stated order, honest headlines that LEAD with the truth). Header comment: §3/D21/D31 honesty — never claim an unmeasured move; the `claimsMetricMoved` flag is the machine-checkable invariant.
- [ ] **Step 4: Run → green; FULL mcp suite; build. Step 5: Commit** — `feat: gradeObjective - the CMO-report honesty engine (never claims an unmeasured metric move)`

---

### Task 2: `buildCmoReport` — identity-scoped weekly assembly

**Files:**
- Create: `packages/dionysus-mcp/src/tools/cmo-report.ts`
- Test: `packages/dionysus-mcp/test/cmo-report.test.ts`

**Interfaces:**
- Consumes: `prisma`, `Identity`, `gradeObjective` (+ types), `listObservations` (Task-4e memory).
- Produces: `buildCmoReport(identity, now: Date): Promise<CmoReport>` where
```ts
export type CmoReport = {
  weekOf: string;                                   // ISO date of the week start (now - 7d), UTC day
  objective: { kind: string; target: string; metric: string; status: string } | null;
  whatRan: Array<{ actionId: string; channel: string | null; title: string | null; postedUrl: string | null; verifiedAt: Date }>;  // verified sends in the last 7d
  inFlight: number;
  proposedPending: number;
  radarNoticed: Array<{ title: string; sourceUrl: string | null; confidence: number }>;  // observations in the last 7d
  churnThisWeek: number;                            // sum of editDistance on actions touched this week (D22)
  verdict: Verdict;                                  // from gradeObjective
  analyticsConnected: boolean;                       // false at 4f
};
```
  Assembly: all reads scoped `businessId`. `objective` = latest by createdAt. `weeksActive` = whole weeks since the earliest Route.createdAt (0 if no route). `executedTotal`/`executedRecent`(last STALL_WEEKS×7d)/`executedThisWeek`(last 7d) counted on `status:"executed"` by `verifiedAt`. `inFlight` = status ∈ {approved, executing}. `proposedPending` = status "proposed" with assetId not null (drafted, awaiting review). `whatRan` = executed actions with `verifiedAt >= now-7d`, newest first, each joined to its asset for channel/title. `radarNoticed` = market-observation MemoryNodes with `createdAt >= now-7d`. `churnThisWeek` = sum of `editDistance` over actions with `createdAt >= now-7d`. `analyticsConnected: false` (TODO stage-5: `count(Integration where kind=analytics) > 0`). Metric name substituted into the verdict headline if the grader left a placeholder.

- [ ] **Step 1: Failing tests** — a fixture business with: an objective; 2 executed actions verified 2 days ago (in-week) + 1 executed 20 days ago (out-of-week); 1 approved + 1 executing (in-flight); 1 proposed-with-asset; 2 radar observations (1 this week, 1 old); some editDistance. Assert: `whatRan` length 2 (only in-week, newest first, channel/title populated), `inFlight` 2, `proposedPending` 1, `radarNoticed` length 1, `verdict.state` is a valid unmeasured state (analyticsConnected false), `verdict.claimsMetricMoved` false, `analyticsConnected` false. A second test: an empty business → objective null, verdict "getting-started". A third: another tenant sees none of the first's data (scoped).

- [ ] **Step 2: Run → FAIL. Step 3: Implement `src/tools/cmo-report.ts`** (scoped reads; pass `now` through for all windows; assemble stats → `gradeObjective` → CmoReport). NOT MCP-registered.
- [ ] **Step 4: Run → green; FULL mcp suite; build; downstream dept (78) + cockpit (45). Step 5: Commit** — `feat: buildCmoReport - identity-scoped weekly assembly wired to the honesty grader`

---

### Task 3: Progress-to-objective home (move route overview to /route)

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (+ `getCmoReport`), `src/app/layout.tsx` (nav)
- Replace: `packages/cockpit/src/app/page.tsx` (route overview → progress home)
- Create: `packages/cockpit/src/app/route/page.tsx` (the moved route overview)
- Test: `packages/cockpit/test/review.test.ts` (+ getCmoReport scoped test)

**Interfaces:**
- `getCmoReport(identity): Promise<CmoReport>` — cockpit wrapper calling `buildCmoReport(identity, new Date())` (real clock at the request boundary; the pure grader + assembly stay clock-injected and tested with a fixed `now`).
- `/` (force-dynamic): requireSession → getCmoReport → render: objective (target/metric/status) + a progress line + the **verdict headline + recommendation** (the honest one-liner) + the "connect your number's source" CTA (shown because `analyticsConnected` is false) + a compact this-week snapshot (posts live, in-flight, drafts pending, radar-noticed counts). If objective null → a "no route yet" getting-started state.
- `/route` (force-dynamic): the exact content the old `/` had (getRouteOverview + waypoint/action list) — moved verbatim.
- Nav: Home(`/`) · Route(`/route`) · Radar · Drafts · Send · Report(`/report`).

- [ ] **Step 1: Failing test** — append a `getCmoReport` scoped test to review.test.ts: seed the fixture (reuse an existing tenant with a bound/executed action or create one) → `getCmoReport(A)` returns a CmoReport with a verdict whose `claimsMetricMoved` is false; another tenant's report has objective null / getting-started. (Page rendering is covered by `next build`, per the recorded testing judgment.)
- [ ] **Step 2: Run → FAIL. Step 3: Implement** — add `getCmoReport`; move the current `page.tsx` body into `route/page.tsx`; write the new home `page.tsx`; update nav. All model/founder text as JSX children (React-escaped); any postedUrl in a snapshot uses `isRenderableHttpUrl` (reuse). No `dangerouslySetInnerHTML`.
- [ ] **Step 4: Run → green (cockpit +~1); `next build` clean (`/` + `/route` both dynamic). Step 5: Commit** — `feat: progress-to-objective home with the honest verdict; route overview moves to /route`

---

### Task 4: Weekly CMO Report page

**Files:**
- Create: `packages/cockpit/src/app/report/page.tsx`
- (Test: covered by Task-3's `getCmoReport` test + `next build`; no new service function.)

**Interfaces:**
- `/report` (force-dynamic): requireSession → getCmoReport → the full three-part report:
  - **What ran** — the `whatRan` list (each: channel · title · verified-live link via `isRenderableHttpUrl` · verifiedAt), or "nothing went live this week".
  - **What moved the number** — HONEST: because `analyticsConnected` is false, this section states the measurement gap verbatim (the verdict headline) + the connect CTA; it must NOT show a fabricated metric movement. A visually-distinct "not yet measured" label.
  - **What changes next week** — the verdict `recommendation` + the counts (in-flight, drafts pending, radar-noticed as upcoming proposed work).
  - A header: "Weekly CMO Report — week of {weekOf}", and the verdict state as a labeled badge.

- [ ] **Step 1: Implement `report/page.tsx`** (server component; reuse `getCmoReport`, `isRenderableHttpUrl`; the "what moved" section keys on `report.analyticsConnected === false` to render the honest gap, never a number). 
- [ ] **Step 2: Run** — cockpit suite still green; `next build` clean (`/report` dynamic). **Step 3: Commit** — `feat: weekly CMO report page - what ran, the honest measurement gap, what changes next`

---

### Task 5: §15 eval gate — the report cannot fake an outcome

**Files:**
- Test: `packages/dionysus-mcp/test/cmo-eval.e2e.test.ts` (test-only; STOP + report BLOCKED if an invariant fails)

Invariants (self-check each for vacuity — hold the three-consecutive-clean-gate bar):
1. **Honesty core (the marquee):** with a business that HAS shipped work (executed actions) but `analyticsConnected: false`, `buildCmoReport` returns a verdict with `claimsMetricMoved === false` and a state ∈ {getting-started, shipping-unmeasured, stalled} — NEVER a measured state. Assert against a real assembled report (build the chain via real functions: objective→route→waypoint→action→asset→approve→startExecution→completeExecution with verifiedAt so it's genuinely "executed"). Also assert the verdict headline/recommendation does NOT contain a fabricated percentage/number claiming the metric moved (assert the "what moved" honesty: `report.analyticsConnected === false`).
2. **Stalled leads with the flat weeks:** assemble a business whose only executed actions are older than STALL_WEEKS×7d (verifiedAt backdated) with weeksActive ≥ STALL_WEEKS → state "stalled", recommendation mentions route/pause. (Non-vacuous: a business with recent sends → NOT stalled — assert the contrast in the same test.)
3. **Getting-started at small N:** a brand-new business (route just created, zero executed) → "getting-started". A business under MIN_WEEKS_TO_JUDGE weeks → also "getting-started".
4. **Week window correctness:** `whatRan` includes an action verified 2 days ago and EXCLUDES one verified 20 days ago (both executed) — proving the 7-day window, read from the assembled report not the raw query.
5. **Scoped:** `buildCmoReport(A)` reflects only A's data; a ghost tenant B (exists, has its own objective) gets its own report with none of A's whatRan/radarNoticed; A's report unaffected by B.
6. **Grader honesty invariant is exhaustive (reference):** note the Task-1 sweep test already proves `analyticsConnected=false ⟹ !claimsMetricMoved` across the input space; the gate asserts the SAME invariant end-to-end through `buildCmoReport` (which hardcodes false), closing the loop.

- [ ] **Step 1: Write the gate.** Use a fixed `now` passed to `buildCmoReport`; backdate `verifiedAt` via `prisma.routeAction.update` to control the windows. Build executed actions through the REAL lifecycle (approve→startExecution→completeExecution) + a verifiedAt set, so "executed" is genuine. Per-assertion vacuity self-check in the report.
- [ ] **Step 2: Run gate + FULL mcp suite + build; dept (78) + build; cockpit (+ COCKPIT_SESSION_SECRET) + next build. Report exact counts. Step 3: Commit** — `test: stage-4f eval gate - the CMO report never fabricates an unmeasured outcome`

---

## Out of Scope (deliberate)

- **Stripe / billing** — explicitly excluded (user).
- **Analytics integration (D21) + the `Integration` model + the real connection flow** — stage 5. `analyticsConnected` is hardcoded false; the grader's measured branch + the connect CTA are the seams.
- **The measured verdict states firing on real data** (measured-working / traffic-without-conversion / the funnel diagnosis) — stage 5, when analytics connect. The grader implements measured-working/measured-flat as forward stubs; traffic-without-conversion (needs click vs conversion data) is reserved, not graded.
- **Emailing the weekly report / scheduling** — needs the D30 platform layer (6a) + email; the report is on-view at 4f.
- **Historical week-over-week trend charts** — 4f shows the current week; trend history is later.
- **The design-partner checkpoint + dogfood launch** (§0) — an operating milestone gated on this stage's surfaces existing, not a code task.

## Self-Review Notes

- **Spec coverage:** §17 stage-4 "progress-to-objective home screen + weekly CMO Report (graded honesty verdicts: working / not working / too early / traffic-without-conversion)" ✓ — home (T3), report (T4), grader with getting-started/shipping-unmeasured/stalled at 4f + measured-working/flat seam for stage 5, traffic-without-conversion reserved (T1); D31.A honesty mechanic (~3 flat weeks → lead + recommend route-change/pause) ✓ (stalled state); D21/§3 never-claim-unmeasured ✓ (claimsMetricMoved invariant, gate inv 1); D31 connection-rate CTA ✓ (T3/T4); §15 gate ✓ (T5). Stripe explicitly OUT.
- **Type consistency:** `ObjectiveStats`/`Verdict`/`VerdictState` (T1) consumed by T2; `CmoReport` (T2) consumed by T3/T4 via `getCmoReport`; the grader is pure and clock-free (clock enters at `buildCmoReport`/`getCmoReport`).
- **Judgment calls on record:** the honesty engine is a PURE function separated from DB assembly (exhaustively testable; `claimsMetricMoved` is the machine-checkable honesty flag); `analyticsConnected` hardcoded false at 4f with the grader fully seamed for stage 5 (measured branch implemented + tested even though unreachable at 4f — proves the invariant both directions); route overview moves `/`→`/route` (D31: progress IS the home); `buildCmoReport` NOT an MCP tool (cockpit-tier read); `now` injected everywhere (tests never touch wall-clock); no `Integration` model built (YAGNI — stage 5 owns it).
