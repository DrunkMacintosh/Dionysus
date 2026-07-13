# Objective Onboarding (Stage 6f — state a goal, wake to a plan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop's ENTRY: a founder with a cockpit login states their objective on `/setup`; the nightly bootstraps the FIRST route from the best discovered case (waypoints + actions, `proposed`, never-auto) — and the same night's later sections draft waypoint 1, so the first morning briefing is a full plan with reviewable drafts. (Today this requires operator scripts; DEPLOY.md §8 says so honestly.)

**Architecture:** `proposeRoute` gains an additive `existingObjectiveId?` (uses the cockpit-created Objective instead of creating a duplicate). Cockpit `/setup` is a session-authed objective form (one active objective — the dogfood simplification; an existing active objective renders as a summary, not a form). The nightly gains a `plan` section FIRST (before radar): objective exists AND no route AND a discovered Case exists → `proposeRoute` from the top-ranked case; every unmet condition is an honest skip. **Judgment call (documented): NO route-activation gate.** Route `status` is enforced nowhere today; the real founder gates are action approval (3c), verified send (4d), and revision approval (6c) — a route-activation button would be theater. Pre-drafting the proposed route the same night is INTENDED: the goal is founder-stated, the drafts are never-auto, and the morning briefing arrives complete.

**Tech Stack:** No new dependencies, no schema change. department + cockpit.

## Global Constraints

- **NEVER-AUTO preserved.** The bootstrap writes an Objective (founder-stated), a `proposed` Route, waypoints (order-1 `active` per the existing default), and `proposed` actions. Nothing is approved/sent. Drafting stays budget-gated + never-auto.
- **HONEST skips.** No objective → skip ("no objective yet — set one on /setup"); a route already exists → skip (the bootstrap happens ONCE; re-planning is the Growth Analyst's job, 6c); no discovered cases → skip ("no discovered cases — run discovery") with ZERO model calls; budget refused → the section reports failed (proposeRoute throws fail-closed first).
- **NO duplicate objective.** The nightly passes `existingObjectiveId`; `proposeRoute` validates it in-scope and creates no second row. Existing `proposeRoute` callers/tests unchanged (the param is optional).
- **One active objective** (dogfood simplification): `createObjectiveAction` refuses when an active objective exists; `/setup` shows the current objective instead of the form.
- **D27.1 scoped; NOT MCP** (whitelist stays 11); cockpit action session-authed (`requireSession` outside try, businessId from session only); all form text JSX-escaped. No `console.log`. ESM `.js` specifiers.
- **Ops:** PowerShell. Rebuild mcp dist before dept if mcp changes (none planned). Cockpit tests need DATABASE_URL + COCKPIT_SESSION_SECRET.
- **Baselines at stage start:** mcp **342**, dept **129**, cockpit **58**.

---

## Task 1: `proposeRoute` accepts an existing objective (additive)

**Files:**
- Modify: `packages/department/src/propose-route.ts`
- Test: `packages/department/test/propose-route.test.ts` (append; existing tests UNCHANGED)

Change: `ProposeRouteInput` gains `existingObjectiveId?: string`. In the flow, replace the unconditional `createObjective` with:

```typescript
  // Objective: reuse the founder's cockpit-created row when given (validated in scope —
  // no duplicate objective); otherwise create it now, post-parse as before (a model/parse
  // failure still never persists a routeless orphan objective).
  let objectiveId: string;
  if (input.existingObjectiveId) {
    const existing = await prisma.objective.findFirst({
      where: { id: input.existingObjectiveId, businessId: identity.businessId } });
    if (!existing) throw new Error(`Objective ${input.existingObjectiveId} not found in this business scope.`);
    objectiveId = existing.id;
  } else {
    ({ objectiveId } = await createObjective(identity, input.objective));
  }
```

- [ ] **Step 1: failing test** (append): seed an objective row; call `proposeRoute` with `existingObjectiveId` (+ the matching `objective` fields, reusing the file's fake harness/case fixtures) → the returned `objectiveId` IS the seeded id AND `prisma.objective.count` for the tenant is still 1 (no duplicate); a cross-tenant `existingObjectiveId` → throws `/not found/` and persists NO route. Existing tests must pass unchanged.
- [ ] **Step 2: RED → implement → GREEN + full dept suite.**
- [ ] **Step 3: Commit** — `feat: proposeRoute reuses an existing objective - the cockpit-stated goal is never duplicated`

---

## Task 2: Cockpit `/setup` — the objective form

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (add `getActiveObjective(identity)`)
- Create: `packages/cockpit/src/lib/objective-actions.ts` (`createObjectiveAction`)
- Create: `packages/cockpit/src/app/setup/page.tsx` (+ `setup-form.tsx` client component)
- Modify: `packages/cockpit/src/app/layout.tsx` (nav: `Setup` first, before Home)
- Test: `packages/cockpit/test/review.test.ts` (append)

Pieces:
- `getActiveObjective(identity)`: `prisma.objective.findFirst({ where: { businessId, status: "active" }, orderBy: { createdAt: "desc" } })` → `{ id, kind, target, metric, createdAt } | null`.
- `createObjectiveAction` (useActionState-shaped, `"use server"`): `requireSession()` OUTSIDE try; trim + validate kind/target/metric non-empty; REFUSE (`{ok:false}`) when `getActiveObjective` is non-null ("an objective is already active"); `createObjective(identity, { kind, target, metric })` (import from `dionysus-mcp/tools/plan`); `revalidatePath("/setup")` + `revalidatePath("/")` on success; message: "Objective saved. Dionysus will propose a route overnight — check /route in the morning."
- `/setup` page (force-dynamic): active objective exists → render its summary ("Your objective: {kind} — {target} ({metric})") + the honest next-step line (route exists? "your route is on /route" : "Dionysus will propose a route overnight"); else the form (kind select/input, target, metric).
- [ ] **Step 1: failing tests** (append to review.test.ts): `getActiveObjective` returns the active objective scoped (B's never leaks; a `done` objective is not returned); the action-core behavior is covered via `getActiveObjective` + direct `createObjective` (the action itself follows the established convention — the guard logic `activeObjective !== null → refuse` lives in the action; test the guard by… keep it simple: test `getActiveObjective` only; the action mirrors integration-actions patterns pinned elsewhere).
- [ ] **Step 2: RED → implement → GREEN (cockpit suite) + `pnpm exec next build` (/setup ƒ).**
- [ ] **Step 3: Commit** — `feat: cockpit /setup - the founder states the objective, Dionysus plans overnight`

---

## Task 3: The nightly `plan` section (FIRST — bootstrap the first route)

**Files:**
- Modify: `packages/department/src/run-nightly.ts`
- Test: `packages/department/test/run-nightly.test.ts` (append)

The section runs FIRST (before radar — the same night's radar/learn/strategy/cro/drafts then see the new route; SEVEN sections: plan→radar→metrics→learn→strategy→cro→drafts). `NightlyBusinessResult` gains `plan: SectionResult` (additive); sweep catch extended.

```typescript
  // PLAN — the bootstrap: a founder-stated objective with NO route yet gets its FIRST route
  // proposed from the best discovered case (proposed, never-auto — the same night's later
  // sections draft waypoint 1, so the morning briefing arrives complete). Runs ONCE: any
  // existing route suppresses (re-planning is the Growth Analyst's job, 6c).
  let plan: SectionResult;
  try {
    const objective = await prisma.objective.findFirst({
      where: { businessId, status: "active" }, orderBy: { createdAt: "desc" } });
    const existingRoute = await prisma.route.findFirst({ where: { businessId } });
    if (!objective) {
      plan = { status: "skipped", reason: "no objective yet — set one on /setup" };
    } else if (existingRoute) {
      plan = { status: "skipped", reason: "a route already exists (re-planning is the Growth Analyst's job)" };
    } else {
      const topCase = await prisma.case.findFirst({ where: { businessId }, orderBy: { rank: "asc" } });
      if (!topCase) {
        plan = { status: "skipped", reason: "no discovered cases — run discovery first" };
      } else {
        const routePlan = await proposeRoute(identity,
          { objective: { kind: objective.kind, target: objective.target, metric: objective.metric },
            caseId: topCase.id, existingObjectiveId: objective.id },
          { harness: deps.harness, models: deps.models });
        plan = { status: "ok", detail: `route proposed from case "${topCase.name}" — ${routePlan.waypoints.length} waypoint(s)` };
      }
    }
  } catch (error: unknown) {
    plan = { status: "failed", reason: failureReason(error) }; // incl. budget fail-closed
  }
```

(Import `proposeRoute` from `./propose-route.js`. NOTE `rank: "asc"` — verify the Case model's rank semantics: stage-2 ranked cases with 1 = best; confirm by reading the Case usage and use the ordering that puts the best case first; document what you found.)

- [ ] **Step 1: failing tests** (append to run-nightly.test.ts; the fake harness must ALSO answer the route-strategist call — its ctx contains `"Chosen case:"` — with a valid route-proposal JSON matching `parseRouteProposal`'s schema [READ plan-schemas.ts for the exact shape]; keep the existing observation/draft branches):
  1. BOOTSTRAP: a business with an objective + a Case + NO route → nightly → `plan.status === "ok"`; a route now exists with waypoints + proposed actions; `objective.count === 1` (no duplicate).
  2. ONE-STANDING: the standard fixture (route already seeded) → `plan.status === "skipped"` reason contains "already exists".
  3. NO CASES: objective + no route + no cases → skipped "no discovered cases", zero route rows, and the harness saw NO route-strategist call (no input containing "Chosen case:").
- [ ] **Step 2: RED → implement → GREEN + FULL dept suite (6a/6b/6c/6e gates stay green — additive field only).**
- [ ] **Step 3: Commit** — `feat: the nightly bootstraps the first route - state a goal, wake to a plan`

---

## Task 4: §15 eval gate

**Files:**
- Create: `packages/department/test/onboarding-eval.e2e.test.ts`

Invariants (tenants `biz_onboardeval_*`; a dual-purpose harness answering route-strategist/radar/draft calls; a seeded Case via raw prisma with the fields proposeRoute reads — historicalArcJson/modernizedPlanJson/insight/name/platform/mode/rank):
- **inv1 THE FIRST MORNING (end-to-end):** objective via the REAL `createObjective` + a Case + no route → ONE full `runNightly` → a `proposed` route exists, waypoint order-1 `active` with `proposed` actions, AND at least one action is DRAFTED (assetId bound) the SAME night — while NOTHING is approved/executed (`count(status NOT IN (proposed)) === 0` across the tenant's actions; `approvedAt` all null). The complete never-auto morning briefing.
- **inv2 ONE-STANDING:** a second nightly → route count still 1 (the bootstrap never re-fires).
- **inv3 NO-CASES HONESTY:** objective + no cases → plan skipped, ZERO route rows, ZERO route-strategist model calls (probe: input containing "Chosen case:").
- **inv4 NO-OBJECTIVE:** neither objective nor route → plan skipped ("no objective"), nothing persisted.
- **inv5 NO DUPLICATE OBJECTIVE:** after inv1's bootstrap, objective count === 1 and the route's objectiveId === the created objective's id.
- **inv6 WHITELIST:** `TOOL_SCHEMAS` length 11; no `propose_route_bootstrap`/`create_objective_form`.
- [ ] Gate green + FULL dept suite → Commit — `test: stage-6f eval gate - the first morning is complete, never-auto, honest-skipping, non-MCP`

---

## Self-Review

**Spec coverage:** §17 stage-3 "objective-first onboarding" finally gets its founder-facing surface; §7 flow steps 1-3 (objective → case → route) now reachable from the cockpit + nightly; D31.A (the plan lands as proposed work the founder reviews). The route-activation gate is deliberately NOT built (documented judgment: route status is enforced nowhere; action approval/verified send/revision approval are the real gates — activation would be theater). Deferred: multi-objective support; a cockpit "run discovery" button (discovery is a long model run — the operator script remains the documented path, DEPLOY.md §8); case PICKING by the founder (the nightly takes the top-ranked case; a case-selection UI is future work).

**Placeholders:** T1/T2/T4 test steps are complete-case recipes against established fixture files; T3 code is complete inline (with one verify-and-document note on rank ordering).

**Type consistency:** `ProposeRouteInput.existingObjectiveId?` additive (T1) consumed by T3; `getActiveObjective` (T2) cockpit-local; `NightlyBusinessResult.plan` additive (T3) consumed by T4.

## Execution Handoff

Subagent-Driven (recommended) — fresh Opus subagent per task, review between tasks, whole-branch review at the end.
