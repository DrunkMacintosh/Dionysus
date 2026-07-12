# Route Re-personalization (Stage 6c — the Growth Analyst's strategic layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the plan is measurably not working (verdict `stalled` or `measured-flat`) and the evidence favors a different channel, the nightly proposes ONE founder-gated route revision — a re-personalized goal for the NEXT locked waypoint, with an evidence-cited rationale. Approval applies it and records the change (was → now → why) in the evolution graph; the plan drifts from borrowed playbook to bespoke (spec §7 mechanism, D31.A).

**Architecture:** `RouteRevision` rows carry the proposal (priorGoal captured at propose time → the row is the durable was/now/why record). `analyzeRouteForRevision` (mcp, deterministic — no model call) triggers on the CMO verdict + a positive-evidence channel from the recommender's scorer (extracted as `scoreChannelCandidates`, DRY). `decideRouteRevision` (cockpit-tier, non-MCP) applies on approve with guarded atomic writes (waypoint must still be `locked`), then best-effort records a `revision` MemoryNode + refreshes the waypoint mirror node (recall honesty). The nightly gains a `strategy` section; cockpit `/route` shows the pending revision with Approve/Reject; `/timeline` shows revisions under their waypoint.

**Tech Stack:** No new dependencies. dionysus-mcp (schema + 3 modules) + department (nightly section) + cockpit (card + actions + timeline).

## Global Constraints

*(Every task implicitly includes this section.)*

- **NEVER-AUTO.** A revision NEVER applies without the founder's explicit decision. The analyzer only writes a `proposed` RouteRevision row; the waypoint goal stays byte-unchanged until `decideRouteRevision(..., "approved")` — a session-authed cockpit action.
- **EVIDENCE-REQUIRED + HONEST rationale.** A revision is proposed ONLY when (a) the verdict is `stalled` or `measured-flat` (the plan is measurably not working — never churn a working/young plan) AND (b) a channel with POSITIVE cited evidence exists. The rationale cites the verdict reason + the actual belief bodies — no fabricated metric/% (the belief bodies and verdict phrasing are already metric-word-free; the gate regex-pins it).
- **ONE standing revision per route** (a `proposed` revision suppresses a new one).
- **Guarded apply.** Approve applies the goal ONLY if the waypoint is still `locked` and in scope (atomic `updateMany` guards, D29-style); a raced/decided/foreign revision never double-applies. `priorGoal` is captured at propose time so the RouteRevision row is the durable record even if graph writes fail (graph writes are best-effort, logged).
- **The record corrects, honestly.** On approve: a `revision` MemoryNode (type exists since 5a) with `waypointId` set + body "Goal was: … → now: …. Why: …", and the waypoint MIRROR node's body is refreshed to the new goal — the copywriter's recall must never cite a stale goal.
- **D27.1 scoping** everywhere; **NOT MCP** (whitelist stays 11); no `console.log` (best-effort catches use `console.error`); ESM `.js` specifiers; additive types (`NightlyBusinessResult` gains `strategy`).
- **Ops:** PowerShell (Git Bash broken). mcp tests `$env:DATABASE_URL="file:./.tmp/test.db"`; cockpit adds `$env:COCKPIT_SESSION_SECRET="test-secret"`; 5d-dependent tests set `DIONYSUS_CONFIG_KEY` in-process. Schema change in T1 → `pnpm prisma generate; node scripts/reset-test-db.mjs` once. After mcp src changes `pnpm build` before dept/cockpit suites.
- **Baselines at stage start:** mcp **308**, dept **104**, cockpit **54**.

---

## Task 1: `RouteRevision` schema + guarded write layer

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma`
- Create: `packages/dionysus-mcp/src/tools/route-revision.ts`
- Test: `packages/dionysus-mcp/test/route-revision.test.ts`

**Interfaces (produces):**
- Model: `RouteRevision { id, businessId(+rel), routeId, waypointId, priorGoal, proposedGoal, rationale, status "proposed"|"approved"|"rejected", createdAt, decidedAt? }` with `@@index([businessId])`; `Business` gains `routeRevisions RouteRevision[]`.
- `proposeRouteRevision(identity, input: { routeId: string; waypointId: string; proposedGoal: string; rationale: string }): Promise<{ revisionId: string } | null>` — scoped route+waypoint load (waypoint must belong to the route AND be `locked`, else throw); returns null (writes nothing) when a `proposed` revision already stands for the route; captures `priorGoal` from the waypoint.
- `getPendingRevision(identity, routeId): Promise<{ id: string; waypointId: string; waypointTitle: string; priorGoal: string; proposedGoal: string; rationale: string; createdAt: Date } | null>`

- [ ] **Step 1: schema.** Add after `MetricSnapshot`:

```prisma
model RouteRevision {
  id           String    @id @default(cuid())
  businessId   String
  business     Business  @relation(fields: [businessId], references: [id])
  routeId      String
  waypointId   String
  priorGoal    String
  proposedGoal String
  rationale    String
  status       String    // "proposed" | "approved" | "rejected"
  createdAt    DateTime  @default(now())
  decidedAt    DateTime?

  @@index([businessId])
}
```

Add `routeRevisions RouteRevision[]` to `Business`. Then `pnpm prisma generate; node scripts/reset-test-db.mjs`.

- [ ] **Step 2: failing test.** Create `test/route-revision.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { proposeRouteRevision, getPendingRevision } from "../src/tools/route-revision.js";

const BIZ = "biz_rev_a";
const OTHER = "biz_rev_b";
let routeId = "", lockedWpId = "", activeWpId = "";

beforeEach(async () => {
  for (const id of [BIZ, OTHER]) {
    await prisma.routeRevision.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  const obj = await prisma.objective.create({ data: { businessId: BIZ, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: BIZ, objectiveId: obj.id, source: "composed", status: "active" } });
  routeId = route.id;
  activeWpId = (await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId, order: 1, title: "Launch", goal: "go live", status: "active" } })).id;
  lockedWpId = (await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId, order: 2, title: "Grow", goal: "old goal", status: "locked" } })).id;
});

describe("proposeRouteRevision", () => {
  it("proposes against a LOCKED waypoint, capturing priorGoal — the row is the durable was/now/why record", async () => {
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "because evidence" });
    const row = await prisma.routeRevision.findUnique({ where: { id: res!.revisionId } });
    expect(row).toMatchObject({ status: "proposed", priorGoal: "old goal", proposedGoal: "new goal", rationale: "because evidence", waypointId: lockedWpId });
    expect((await prisma.routeWaypoint.findUnique({ where: { id: lockedWpId } }))?.goal).toBe("old goal"); // NEVER-AUTO: nothing applied
  });

  it("refuses a non-locked waypoint and a cross-tenant route", async () => {
    await expect(proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: activeWpId, proposedGoal: "x", rationale: "r" })).rejects.toThrow(/locked/i);
    await expect(proposeRouteRevision({ businessId: OTHER }, { routeId, waypointId: lockedWpId, proposedGoal: "x", rationale: "r" })).rejects.toThrow(/not found/i);
    expect(await prisma.routeRevision.count()).toBe(0);
  });

  it("ONE standing revision per route: a second propose returns null and writes nothing", async () => {
    await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "a", rationale: "r" });
    const second = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "b", rationale: "r" });
    expect(second).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: BIZ } })).toBe(1);
  });
});

describe("getPendingRevision", () => {
  it("returns the proposed revision with the waypoint title, scoped; null when none/decided", async () => {
    expect(await getPendingRevision({ businessId: BIZ }, routeId)).toBeNull();
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "why" });
    const pending = await getPendingRevision({ businessId: BIZ }, routeId);
    expect(pending).toMatchObject({ id: res!.revisionId, waypointTitle: "Grow", priorGoal: "old goal", proposedGoal: "new goal" });
    expect(await getPendingRevision({ businessId: OTHER }, routeId)).toBeNull(); // scoped
    await prisma.routeRevision.update({ where: { id: res!.revisionId }, data: { status: "rejected" } });
    expect(await getPendingRevision({ businessId: BIZ }, routeId)).toBeNull();
  });
});
```

- [ ] **Step 3: RED**, then implement `src/tools/route-revision.ts`:

```typescript
// Stage 6c — RouteRevision write layer: the Growth Analyst's founder-gated plan-change
// proposal. priorGoal is captured HERE (propose time) so the row is the durable
// was/now/why record independent of the graph. NEVER-AUTO: nothing in this module
// mutates a waypoint — decideRouteRevision (decide-revision.ts) applies on approval.
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export type PendingRevision = {
  id: string; waypointId: string; waypointTitle: string;
  priorGoal: string; proposedGoal: string; rationale: string; createdAt: Date;
};

export async function proposeRouteRevision(
  identity: Identity,
  input: { routeId: string; waypointId: string; proposedGoal: string; rationale: string },
): Promise<{ revisionId: string } | null> {
  const businessId = identity.businessId;
  const route = await prisma.route.findFirst({ where: { id: input.routeId, businessId } });
  if (!route) throw new Error(`Route ${input.routeId} not found in this business scope.`);
  const waypoint = await prisma.routeWaypoint.findFirst({
    where: { id: input.waypointId, routeId: input.routeId, businessId } });
  if (!waypoint) throw new Error(`Waypoint ${input.waypointId} not found on this route in scope.`);
  if (waypoint.status !== "locked") throw new Error(`Only a locked waypoint can be revised (status: ${waypoint.status}).`);

  // ONE standing revision per route: a pending proposal suppresses a new one (no churn pile-up).
  const standing = await prisma.routeRevision.findFirst({ where: { businessId, routeId: input.routeId, status: "proposed" } });
  if (standing) return null;

  const row = await prisma.routeRevision.create({ data: {
    businessId, routeId: input.routeId, waypointId: input.waypointId,
    priorGoal: waypoint.goal, proposedGoal: input.proposedGoal, rationale: input.rationale, status: "proposed" } });
  return { revisionId: row.id };
}

export async function getPendingRevision(identity: Identity, routeId: string): Promise<PendingRevision | null> {
  const row = await prisma.routeRevision.findFirst({
    where: { businessId: identity.businessId, routeId, status: "proposed" }, orderBy: { createdAt: "desc" } });
  if (!row) return null;
  const waypoint = await prisma.routeWaypoint.findFirst({ where: { id: row.waypointId, businessId: identity.businessId } });
  return { id: row.id, waypointId: row.waypointId, waypointTitle: waypoint?.title ?? "",
    priorGoal: row.priorGoal, proposedGoal: row.proposedGoal, rationale: row.rationale, createdAt: row.createdAt };
}
```

- [ ] **Step 4: GREEN + full mcp suite + `pnpm build`.**
- [ ] **Step 5: Commit** — `feat: RouteRevision - founder-gated plan-change proposals, priorGoal captured, one standing per route`

---

## Task 2: `scoreChannelCandidates` extraction + the deterministic analyzer

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/recommend.ts` (extract the scorer — behavior-preserving)
- Create: `packages/dionysus-mcp/src/tools/growth-analyst.ts`
- Test: `packages/dionysus-mcp/test/growth-analyst.test.ts` (+ the existing recommend tests must stay green unchanged)

**Interfaces (produces):**
- recommend.ts additionally exports `type ChannelCandidate = { channel: string; score: number; cited: string[]; hasEvidence: boolean }` and `scoreChannelCandidates(identity: Identity): Promise<ChannelCandidate[]>` (sorted by score desc, then channel asc — deterministic). `recommendNextAction` now consumes it (identical behavior: its winner = the first element).
- growth-analyst.ts: `analyzeRouteForRevision(identity: Identity, now: Date): Promise<{ revisionId: string } | null>` — deterministic trigger: `buildCmoReport(identity, now).verdict.state ∈ {"stalled","measured-flat"}` AND the latest route has a next `locked` waypoint (lowest order) AND the top candidate has positive cited evidence → `proposeRouteRevision` with:
  - `proposedGoal = "Lead with ${channel} — ${waypoint.goal}"`
  - `rationale = "${verdictPhrase} The evidence favors ${channel}: ${cited.join(" ")}"` where verdictPhrase is `"The plan has stalled — nothing has gone live in weeks."` for stalled, `"Work is shipping but the number has not moved."` for measured-flat.
  - Returns null (writes nothing) on any unmet condition. Never throws for missing-data conditions (no route/waypoint → null); cross-tenant scoping comes free from the underlying reads.

- [ ] **Step 1: failing tests.** Create `test/growth-analyst.test.ts` (fixtures: reuse the seeding style of `test/cmo-report.test.ts`'s measured block — a business 6 weeks old with verified sends backdated so the verdict lands where the test needs; set `DIONYSUS_CONFIG_KEY` in `beforeAll`; import `connectIntegration` for the measured-flat case):

```typescript
// Cases (write complete code following route-revision.test.ts + cmo-report.test.ts patterns):
// 1. STALLED + positive-evidence channel + locked waypoint → proposes; the RouteRevision row's
//    proposedGoal starts with "Lead with hackernews — " and rationale contains BOTH the stalled
//    phrase AND the belief body; the waypoint goal is UNCHANGED (never-auto); rationale
//    not.toMatch(/%|percent|conversion|engagement|impressions|clicks|reach/i).
//    (Stalled fixture: route createdAt weeksAgo(6); ONE verified send at weeksAgo(5) — executedTotal>0,
//    executedRecent 0 → stalled. Belief: persistCraftBelief copywriter channel=hackernews positive 0.5
//    with a distinctive body token.)
// 2. Verdict getting-started (fresh business, no sends) → returns null, zero revisions.
// 3. STALLED but NO positive-evidence channel (no beliefs at all) → null, zero revisions.
// 4. STALLED but NO locked waypoint (single active waypoint) → null, zero revisions.
// 5. ONE-STANDING: a second analyze after the first proposes → null, count stays 1.
```

- [ ] **Step 2: RED**, then implement.

**recommend.ts refactor** — extract everything from the beliefs query through the candidate loop into:

```typescript
export type ChannelCandidate = { channel: string; score: number; cited: string[]; hasEvidence: boolean };

/** Deterministic evidence scorer over channel candidates (history + defaults), sorted best-first. */
export async function scoreChannelCandidates(identity: Identity): Promise<ChannelCandidate[]> {
  // ... (the existing candidate-set + beliefs query + scoring loop, unchanged, collecting ALL
  // candidates into an array; sort by score desc then channel asc)
}
```

`recommendNextAction` keeps its guards (active waypoint, standing recommendation) then uses `const [best] = await scoreChannelCandidates(identity); if (!best) return null;` and the existing three-way honest rationale. ALL FIVE existing recommend tests must pass UNCHANGED.

**growth-analyst.ts:**

```typescript
// Stage 6c — the Growth Analyst's strategic layer (deterministic, no model call).
// Proposes a founder-gated route revision ONLY when the plan is measurably not working
// (verdict stalled / measured-flat) AND the evidence favors a channel (positive cited
// beliefs). NEVER-AUTO: it writes a `proposed` RouteRevision; decideRouteRevision applies.
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { buildCmoReport } from "./cmo-report.js";
import { scoreChannelCandidates } from "./recommend.js";
import { proposeRouteRevision } from "./route-revision.js";

export async function analyzeRouteForRevision(identity: Identity, now: Date): Promise<{ revisionId: string } | null> {
  const report = await buildCmoReport(identity, now);
  if (report.verdict.state !== "stalled" && report.verdict.state !== "measured-flat") return null;

  const route = await prisma.route.findFirst({ where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  if (!route) return null;
  const nextLocked = await prisma.routeWaypoint.findFirst({
    where: { businessId: identity.businessId, routeId: route.id, status: "locked" }, orderBy: { order: "asc" } });
  if (!nextLocked) return null;

  const [best] = await scoreChannelCandidates(identity);
  if (!best || best.cited.length === 0) return null; // never steer without positive evidence

  const verdictPhrase = report.verdict.state === "stalled"
    ? "The plan has stalled — nothing has gone live in weeks."
    : "Work is shipping but the number has not moved.";
  return proposeRouteRevision(identity, {
    routeId: route.id, waypointId: nextLocked.id,
    proposedGoal: `Lead with ${best.channel} — ${nextLocked.goal}`,
    rationale: `${verdictPhrase} The evidence favors ${best.channel}: ${best.cited.join(" ")}`,
  });
}
```

- [ ] **Step 3: GREEN + recommend tests unchanged + full mcp suite + build.**
- [ ] **Step 4: Commit** — `feat: growth analyst proposes evidence-cited route revisions when the plan measurably stalls`

---

## Task 3: `decideRouteRevision` — founder-gated apply with an honest record

**Files:**
- Create: `packages/dionysus-mcp/src/tools/decide-revision.ts`
- Test: `packages/dionysus-mcp/test/decide-revision.test.ts`

**Interfaces (produces):** `decideRouteRevision(identity, input: { revisionId: string; decision: "approved" | "rejected" }, now: Date): Promise<{ applied: boolean }>` — cockpit-tier, NON-MCP.

Semantics (order is the contract):
1. Scoped load of the `proposed` revision (`findFirst {id, businessId, status:"proposed"}`) — missing/decided/foreign → throw `not found or already decided`.
2. `rejected`: atomic `updateMany {id, businessId, status:"proposed"} → {status:"rejected", decidedAt: now}`; return `{applied:false}`. The waypoint is untouched.
3. `approved`: apply FIRST, guarded — `routeWaypoint.updateMany {id: revision.waypointId, businessId, status:"locked"} → {goal: revision.proposedGoal}`; count 0 → throw `waypoint is no longer revisable` (revision STAYS proposed — the founder sees the failure honestly, can reject). Then flip the revision atomically (proposed→approved + decidedAt). Then BEST-EFFORT (try/catch + console.error — the RouteRevision row is already the durable record): create the `revision` MemoryNode (`persistMemoryNode` with `{type:"revision", title:"route revised", body: "Goal was: ${priorGoal} → now: ${proposedGoal}. Why: ${rationale}", waypointId: revision.waypointId, sourceId: revision.id, confidence: 1}`), refresh the waypoint MIRROR node body (`memoryNode.updateMany {businessId, type:"waypoint", sourceId: revision.waypointId} → {body: proposedGoal}` — recall must not cite the stale goal), and add a `references` edge revision-node → waypoint-node when both exist (`persistMemoryEdge`). Return `{applied:true}`.

- [ ] **Step 1: failing tests** (complete code, fixtures like route-revision.test.ts; import `persistMemoryNode` indirectly — assert via prisma):

```typescript
// Cases:
// 1. APPROVE applies: waypoint.goal === proposedGoal; revision {status:"approved", decidedAt set};
//    the revision MemoryNode exists (type "revision", sourceId=revisionId, waypointId set, body
//    contains "Goal was: old goal" AND "now: new goal" AND the rationale); the waypoint MIRROR
//    node body refreshed (seed the mirror first via mirrorPlanToGraph so it exists).
// 2. REJECT leaves the waypoint goal byte-unchanged; revision rejected+decidedAt; NO revision node.
// 3. GUARDED APPLY: flip the waypoint to "active" after proposing → approve THROWS
//    /no longer revisable/, the revision STAYS proposed, the goal is unchanged.
// 4. Cross-tenant decide → throws /not found/, nothing changes. Double-decide → second throws.
// 5. GRAPH-FAILURE RESILIENCE: propose against a waypoint, DELETE the business's memory nodes,
//    approve → applied:true, waypoint goal applied, revision approved (the graph record is
//    best-effort; the revision node create may still succeed — assert applied+goal, and that
//    no throw escaped).
```

- [ ] **Step 2: RED → implement per the semantics above → GREEN + full mcp suite + build.**
- [ ] **Step 3: Commit** — `feat: decideRouteRevision - guarded founder-gated apply, the was/now/why record corrects the graph`

---

## Task 4: The nightly `strategy` section

**Files:**
- Modify: `packages/department/src/run-nightly.ts`
- Test: `packages/department/test/run-nightly.test.ts` (append)

`NightlyBusinessResult` gains `strategy: SectionResult` (additive). Placement: AFTER `learn` (fresh beliefs), BEFORE `drafts` (a future revision-driven draft sees it; order becomes radar → metrics → learn → strategy → drafts). Best-effort:

```typescript
  // STRATEGY — the Growth Analyst: propose a founder-gated route revision when the plan is
  // measurably not working AND the evidence favors a channel. Deterministic, never-auto.
  let strategy: SectionResult;
  try {
    const res = await analyzeRouteForRevision(identity, now);
    strategy = res
      ? { status: "ok", detail: `route revision proposed (${res.revisionId})` }
      : { status: "skipped", reason: "plan working/young, no evidence target, or a revision already standing" };
  } catch (error: unknown) {
    strategy = { status: "failed", reason: failureReason(error) };
  }
```

(Import `analyzeRouteForRevision` from `dionysus-mcp/tools/growth-analyst`. Reuse the `now` already in `runNightly`. Extend the sweep's belt-and-suspenders catch with `strategy: failed`.)

- [ ] Test (append; the existing seeded businesses are young/healthy → strategy `skipped`; assert the field exists + skipped for the standard fixture; a full stalled-path test lives in the T6 gate). Existing nightly tests must stay green (additive field only — but CHECK the 6a/6b gates don't enumerate keys; they don't).
- [ ] GREEN + full dept suite → Commit — `feat: the nightly proposes route revisions - the strategy section, founder-gated`

---

## Task 5: Cockpit — the revision card on `/route` + revisions on `/timeline`

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (add `getRoutePendingRevision`, extend `getTimeline` with per-waypoint revisions)
- Create: `packages/cockpit/src/lib/revision-actions.ts` (server actions)
- Create: `packages/cockpit/src/app/route/revision-card.tsx` (client, useActionState — mirror draft-card)
- Modify: `packages/cockpit/src/app/route/page.tsx` (render the card)
- Modify: `packages/cockpit/src/app/timeline/page.tsx` (render revisions)
- Test: `packages/cockpit/test/review.test.ts` (append)

Key pieces:
- `getRoutePendingRevision(identity)`: latest route → `getPendingRevision` (import from `dionysus-mcp/tools/route-revision`); returns `PendingRevision & { routeId } | null`.
- `revision-actions.ts`: `approveRevisionAction`/`rejectRevisionAction` — `"use server"`, `requireSession()` OUTSIDE any try, businessId from session, call `decideRouteRevision(identity, {revisionId, decision}, new Date())` in a try → `{ok, message}`; `revalidatePath("/route")` + `revalidatePath("/timeline")` on success.
- The card: "Proposed plan change" — waypoint title, current goal vs proposed goal, the rationale, Approve/Reject buttons (two forms, useActionState, red/green result — mirror draft-card.tsx).
- `getTimeline`: for each waypoint, also query `memoryNode.findMany {businessId, type:"revision", waypointId: wp.id}` → `revisions: Array<{ body: string; createdAt: Date }>` on `TimelineWaypoint` (additive); the page renders each as a "plan revised" line (JSX children only, escaped).
- Tests (append to review.test.ts): (1) `getRoutePendingRevision` returns the proposed revision scoped (B's never leaks into A) and null after decide; (2) after `decideRouteRevision` approve, `getTimeline` shows the revision under its waypoint with the was/now body.

- [ ] RED → implement → GREEN (cockpit suite) + `pnpm exec next build` (routes ƒ) → Commit — `feat: cockpit route-revision card - approve or reject the plan change, the timeline shows why it changed`

---

## Task 6: §15 eval gate

**Files:**
- Create: `packages/dionysus-mcp/test/revision-eval.e2e.test.ts` (mcp — the full propose→decide chain is mcp; the nightly wiring is pinned by dept tests)

Invariants (tenants `biz_receval_*`; fixtures per growth-analyst.test.ts — a stalled business = route weeksAgo(6) + one verified send weeksAgo(5); set `DIONYSUS_CONFIG_KEY`):
- **inv1 NEVER-AUTO:** a stalled+evidenced business: `analyzeRouteForRevision` proposes; the locked waypoint's goal is BYTE-UNCHANGED after the proposal; only `decideRouteRevision(..., "approved")` changes it.
- **inv2 TRIGGER HONESTY (contrast):** the SAME business fixture but young/healthy (route weeksAgo(0), fresh send) → analyze returns null, zero revisions — the discriminator is the verdict, mutation-provable.
- **inv3 EVIDENCE-REQUIRED:** stalled but beliefs absent → null; stalled + only NEGATIVE beliefs → null (cited empty).
- **inv4 HONEST RATIONALE:** the proposed rationale contains the verdict phrase AND the seeded belief body (nonce token) AND `not.toMatch(/%|percent|conversion|engagement|impressions|clicks|reach/i)`.
- **inv5 GUARDED APPLY:** approve applies + records (revision node body has "Goal was:"/"now:"; waypoint mirror node body === new goal after a prior mirror); reject leaves the goal byte-unchanged with NO revision node; an unlocked-in-the-meantime waypoint → approve throws, revision stays proposed, goal unchanged.
- **inv6 ONE-STANDING + rerun-safe:** two analyzes → one revision; after reject, a re-analyze may propose again (the founder said no to THAT change, the trigger still holds — assert a SECOND revision may exist with the first rejected; both recorded).
- **inv7 WHITELIST:** `TOOL_SCHEMAS` length 11; none of `propose_route_revision`, `decide_route_revision`, `analyze_route`.

- [ ] Gate green + FULL mcp suite → Commit — `test: stage-6c eval gate - revisions are never-auto, evidence-required, honestly-recorded, guarded, non-MCP`

---

## Self-Review

**Spec coverage:** §7 mechanism 2 (Growth Analyst strategic re-personalization, proposed-not-applied, rationale-carried) — delivered deterministically; §13 timeline "plan revised with why" — delivered; D13/§13 "re-planning corrects the record" — the revision node + mirror refresh; D31.A stalled→route-change — the trigger. Deferred: model-written goal prose (deterministic template first — same judgment as the 6b recommender); waypoint INSERTION/REORDER + whole-route re-proposal (bigger lifecycle surface, later); the "weekly deep" cadence (the nightly is the only trigger today).

**Placeholders:** T2 step 1, T3 step 1, and parts of T5/T6 are intent+complete-assertion recipes referencing established fixture files (the 6b gate-authoring convention); all core implementation code is complete.

**Type consistency:** `PendingRevision` (T1) consumed by T5; `ChannelCandidate`/`scoreChannelCandidates` (T2) consumed by growth-analyst; `analyzeRouteForRevision(identity, now)` (T2) consumed by T4; `decideRouteRevision(identity, {revisionId, decision}, now)` (T3) consumed by T5; `NightlyBusinessResult.strategy` additive (T4).

## Execution Handoff

Subagent-Driven (recommended) — fresh Opus subagent per task, review between tasks, whole-branch review at the end.
