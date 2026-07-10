# Stage 5b — buildAgentContext + Outcome Mirror (the plan informs future work) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the compounding loop the memory graph exists for (D13/D31): verified sends are recorded as `outcome` nodes, a `buildAgentContext` traversal turns the graph into plan-anchored causal recall ("how we got here + what happened around here"), and that context feeds the Copywriter so drafts are informed by what already ran. Opens by discharging the 5a concurrency precondition.

**Architecture:** (1) Harden the graph writers with DB `@@unique` constraints + catch-and-refetch, making find-or-create/edge-dedup atomic under concurrent lazy-on-view (the 5a-flagged precondition). (2) Extend `mirrorPlanToGraph` to mirror each *executed* action into an `outcome` node + a `caused` edge — an honest verified-live fact, NOT a fabricated metric (measured outcomes are stage 5c/D21). (3) `buildAgentContext(identity, {routeId, waypointId?, role?})` — a pure, scoped, budget-capped read traversal. (4) Wire it into `draftWaypoint`: mirror-then-read, append a *fenced* "route so far" block to the copywriter context (additive; existing tests stay green). (5) Enrich `/timeline` to show outcomes. The full belief dynamics (confidence decay, explore/exploit, feature attribution) and `persist_memory`-as-MCP-tool stay stage 5c; analytics is 5d.

**Tech Stack:** unchanged — Prisma 6, vitest, the stage-2 `fence()` helper, Next 15 cockpit. No new dependencies.

## Global Constraints

- **CONCURRENCY PRECONDITION (5a-flagged, discharged in Task 1):** `MemoryNode` gets `@@unique([businessId, type, sourceId])`, `MemoryEdge` gets `@@unique([businessId, fromId, toId, kind])`, and `findOrCreateMirrorNode`/`persistMemoryEdge` catch Prisma `P2002` (unique-violation) and re-find (return the existing row) — so two concurrent `/timeline` opens can never duplicate a node/edge. SQLite treats NULLs as distinct in unique indexes, so the many `market-observation` nodes with `sourceId=NULL` are unaffected. `MemoryEdge` also gets `@@index([fromId])`/`@@index([toId])` (traversal endpoints). Reset the test DB before `db push` (the unique index rejects any pre-existing dup — none exist, but reset is the safe path).
- **§13 anchored-to-plan + honesty:** the `outcome` node records the VERIFIED-LIVE FACT only (title e.g. "went live on {channel}", body = postedUrl) — it does NOT claim a metric moved (measured outcomes need analytics — 5c/D21). An `outcome` node is created ONLY for an action whose `status === "executed"` AND `verifiedAt != null` (a real verified send). `caused` edge: action node → outcome node.
- **Outcome nodes are TRUSTED (tainted:false):** they mirror our own verified-send facts, not ingested content. `recordObservation` remains the ONLY writer that forces `tainted:true`. Do NOT change it.
- **Idempotency preserved:** the outcome node is found-or-created by `(businessId, type:"outcome", sourceId=action.id)` — `type` disambiguates it from the action node (same `sourceId`, different `type`), and re-mirroring adds zero rows.
- **`buildAgentContext` is a PURE READ, budget-capped, degrades to empty:** no writes, no mirroring inside it. It reads whatever graph exists, scoped `businessId`, and caps the returned items (`maxItems`, default e.g. 12) so context stays bounded (§Memory "budget-capped"). A sparse/empty graph → an empty context (no throw). NOT MCP-registered at 5b (the pipeline calls it as a function; `build_agent_context`-as-agent-tool + `persist_memory`-as-agent-tool are 5c when a coordinator loop needs them — whitelist stays 11).
- **D20 when context enters the prompt:** the "route so far" block appended to `draftWaypoint`'s ctx is `fence()`d (shared helper). The block's content descends from the plan + verified-send facts (server-trusted), but fencing is defense-in-depth consistent with the existing goal/rationale fence — and the copywriter prompt already carries the data-not-instructions rule.
- **draftWaypoint wiring is ADDITIVE + safe:** it mirrors the plan (idempotent, now concurrency-safe) then appends the fenced context; existing `draft-waypoint.test.ts` assertions (channel detection on the instruction line, D20 forged-marker neutralization, channel/kind clamp) must all stay green — the new block is additional fenced content, not a replacement. The implementer runs the FULL dept suite and fixes forward only if a test over-asserts the whole ctx (none should).
- **D27.1:** identity ambient; every read/write scoped `businessId`; cross-parent guards `findFirst({id, businessId})`. `buildAgentContext(identity, …)` takes identity first.
- **Clock injected:** `mirrorPlanToGraph(identity, routeId, now)` already takes `now`; `buildAgentContext` needs no clock at 5b (no time windows). Pass `now` where mirror is called.
- **Testing:** TDD; no API key. Env: `$env:DATABASE_URL = "file:./.tmp/test.db"` (+ `$env:COCKPIT_SESSION_SECRET = "test-secret"` for cockpit). dionysus-mcp BUILT before dependents. Baselines: mcp 210, dept 78, cockpit 50 — all stay green. Reset the test DB before the Task-1 db push.
- **Commits:** conventional, no attribution footer. **Shell:** Windows/PowerShell (Git Bash broken); pnpm workspace.

## File Structure

```
packages/dionysus-mcp/
  prisma/schema.prisma              # MemoryNode @@unique([businessId,type,sourceId]); MemoryEdge @@unique(...) + @@index(fromId)/(toId)
  src/tools/memory-graph.ts         # catch-P2002-refetch in findOrCreateMirrorNode/persistMemoryEdge; + outcome mirror; + buildAgentContext
  test/memory-graph.test.ts         # concurrency + outcome-mirror + buildAgentContext tests
  test/agent-context-eval.e2e.test.ts  # Task 6 §15 gate
packages/department/
  src/draft-waypoint.ts             # mirror-then-read; append fenced "route so far" context
  test/draft-waypoint.test.ts       # + context-block test (existing tests stay green)
packages/cockpit/
  src/lib/review.ts                 # getTimeline surfaces outcomes
  src/app/timeline/page.tsx         # render outcomes under actions
  test/review.test.ts               # + outcome-in-timeline test
```

---

### Task 1: Concurrency hardening — `@@unique` + catch-and-refetch (discharge the 5a precondition)

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma` (MemoryNode + MemoryEdge unique/indexes)
- Modify: `packages/dionysus-mcp/src/tools/memory-graph.ts` (`findOrCreateMirrorNode`, `persistMemoryEdge` catch-P2002)
- Test: `packages/dionysus-mcp/test/memory-graph.test.ts` (append)

**Interfaces:** no signature change. `findOrCreateMirrorNode` and `persistMemoryEdge` become atomic: on a `P2002` from the `create`, re-`findFirst` and return the existing id (never throw a duplicate error, never write a second row).

- [ ] **Step 1: Write the failing test** (append) — prove the race is now safe AND the multi-NULL case still works:

```ts
import { Prisma } from "@prisma/client";
// ... existing imports ...

describe("graph writers are concurrency-safe (5a precondition)", () => {
  const B = "biz_mgconc";
  beforeAll(async () => {
    await prisma.memoryEdge.deleteMany({ where: { businessId: B } });
    await prisma.memoryNode.deleteMany({ where: { businessId: B } });
    await prisma.business.upsert({ where: { id: B }, create: { id: B, name: "C" }, update: {} });
  });

  it("two concurrent find-or-create for the same (type, sourceId) yield ONE node", async () => {
    // exercise the exported mirror path concurrently on a fresh route
    const obj = await prisma.objective.create({ data: { businessId: B, kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: B, objectiveId: obj.id, source: "case", status: "proposed" } });
    await prisma.routeWaypoint.create({ data: { businessId: B, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
    const [a, b] = await Promise.allSettled([
      mirrorPlanToGraph({ businessId: B }, route.id, new Date()),
      mirrorPlanToGraph({ businessId: B }, route.id, new Date()),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    // exactly one waypoint node despite two concurrent mirrors
    const wpNodes = await prisma.memoryNode.findMany({ where: { businessId: B, type: "waypoint" } });
    expect(wpNodes).toHaveLength(1);
  });

  it("multiple sourceId-NULL nodes still coexist (unique treats NULLs as distinct)", async () => {
    const n1 = await prisma.memoryNode.create({ data: { businessId: B, type: "market-observation", title: "o1", body: "b", confidence: 0.5 } });
    const n2 = await prisma.memoryNode.create({ data: { businessId: B, type: "market-observation", title: "o2", body: "b", confidence: 0.5 } });
    expect(n1.id).not.toBe(n2.id);
  });
});
```

(NOTE: under SQLite's single-writer the concurrent case may not actually collide; the test still asserts the invariant, and the catch-P2002 path is what makes it hold on any store. If the two-mirror test can't force a collision deterministically, ADD a direct probe: create a mirror node, then attempt a raw `prisma.memoryNode.create` with the same `(businessId, type, sourceId)` and assert it rejects with a unique error — proving the DB constraint exists — and assert `findOrCreateMirrorNode`'s equivalent returns the existing id. Report which form you used.)

- [ ] **Step 2: Run → the raw-duplicate probe fails (no constraint yet). Step 3: Implement**

`schema.prisma` — add to `MemoryNode`: `@@unique([businessId, type, sourceId])` (keep `@@index([businessId])`). Add to `MemoryEdge`: `@@unique([businessId, fromId, toId, kind])`, `@@index([fromId])`, `@@index([toId])`.

`memory-graph.ts` — wrap the create in `findOrCreateMirrorNode` and `persistMemoryEdge` with a P2002 catch that re-finds:

```ts
async function findOrCreateMirrorNode(identity: Identity, input: MemoryNodeInput & { sourceId: string }): Promise<string> {
  const existing = await prisma.memoryNode.findFirst({
    where: { businessId: identity.businessId, type: input.type, sourceId: input.sourceId } });
  if (existing) return existing.id;
  try {
    const { nodeId } = await persistMemoryNode(identity, input);
    return nodeId;
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const row = await prisma.memoryNode.findFirst({
        where: { businessId: identity.businessId, type: input.type, sourceId: input.sourceId } });
      if (row) return row.id;
    }
    throw error;
  }
}
```

Same P2002-catch-refetch pattern in `persistMemoryEdge` around its `create` (re-find by the dedup key). Import `Prisma` from `@prisma/client`.

- [ ] **Step 4: Run** — `node scripts/reset-test-db.mjs` (reset before push so the unique index applies cleanly), `pnpm prisma generate; pnpm prisma db push`, then FULL mcp suite (210 + new); `pnpm build`; downstream dept (78) + cockpit (50). The 5a eval gate (memory-graph-eval) must stay green (the unique constraints don't change its assertions).
- [ ] **Step 5: Commit** — `fix: atomic graph writers - @@unique + catch-P2002-refetch closes the concurrent-mirror race`

---

### Task 2: Outcome mirror — executed actions become `outcome` nodes + `caused` edges

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/memory-graph.ts` (`mirrorPlanToGraph`)
- Test: `packages/dionysus-mcp/test/memory-graph.test.ts` (append)

**Interfaces:** `mirrorPlanToGraph`'s return gains `outcomeNodeIds: string[]`. For each RouteAction with `status === "executed" && verifiedAt != null`: find-or-create an `outcome` node (`type:"outcome"`, sourceId = action.id, title = `went live on ${channel}` where channel = the action's asset channel or `action.type`, body = `postedUrl ?? ""`, confidence 1) + a `caused` edge (action node → outcome node). Non-executed actions get NO outcome node. Idempotent.

- [ ] **Step 1: Failing tests** (append) — seed a route + 2 actions; drive ONE action through the real lifecycle to `executed` + `verifiedAt` + `postedUrl` (approve→startExecution→completeExecution + set verifiedAt/postedUrl), leave the other `proposed`. `mirrorPlanToGraph` → `outcomeNodeIds` length 1 (only the executed one); the outcome node has sourceId = that action id, body contains the postedUrl, tainted false; a `caused` edge from the action node → the outcome node exists; the proposed action has NO outcome node. Idempotent re-run: same outcomeNodeIds, zero new rows.

- [ ] **Step 2: Run → FAIL. Step 3: Implement** — in the action loop of `mirrorPlanToGraph`, after creating the action node, if `action.status === "executed" && action.verifiedAt`: resolve the channel (load the bound asset scoped for its channel, fall back to `action.type`), find-or-create the outcome node (sourceId=action.id), add the `caused` edge, push to `outcomeNodeIds`. Update the header comment.
- [ ] **Step 4: Run → green; FULL mcp suite; build; downstream. Step 5: Commit** — `feat: mirror executed actions into outcome nodes + caused edges (verified-live facts, not measured metrics)`

---

### Task 3: `buildAgentContext` — the plan-anchored causal-recall traversal

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/memory-graph.ts` (+ `buildAgentContext`)
- Test: `packages/dionysus-mcp/test/memory-graph.test.ts` (append)

**Interfaces:**
- Produces: `buildAgentContext(identity, input: { routeId: string; waypointId?: string; role?: string }, opts?: { maxItems?: number }): Promise<AgentContext>` where
```ts
export type AgentContext = {
  ancestorPath: Array<{ title: string; goal: string }>;   // waypoints up to (and incl.) the anchor, in `next`-spine order
  neighborhood: Array<{ kind: "action" | "outcome"; title: string; detail: string }>;  // actions + outcomes around the anchor waypoint
  learnings: Array<{ title: string; body: string; confidence: number }>;  // role-scoped `learning` nodes (none at 5b — forward-compatible, empty)
  text: string;                                            // compact rendering for a prompt (bounded by maxItems)
};
```
  Pure, scoped read. Flow: scoped route load (throw not-found). Resolve the anchor waypoint node = `waypointId`'s mirror node if given, else the LAST waypoint node on the `next` spine. Ancestor path = walk the `next` spine from the head to the anchor (in order), each → `{title, body:goal}`. Neighborhood = the anchor waypoint's action nodes (+ their `caused` outcome nodes), capped at `maxItems` (default 12). Learnings = `learning`-type nodes scoped to `role` (empty at 5b). `text` = a compact bounded string like `Route so far:\n- WP1: goal…\n- WP2 (current): goal…\nDone: action X went live at URL…`. Degrades to `{ancestorPath:[], neighborhood:[], learnings:[], text:""}` when the graph is empty (NOT after mirroring — it reads only). All reads `businessId`-scoped; a cross-tenant routeId → `/not found|scope/`.

- [ ] **Step 1: Failing tests** (append) — seed a route with 2 waypoints + actions, mirror it (Task 2/3), drive one action executed (outcome node). `buildAgentContext(A, {routeId})`:
  - ancestorPath length 2 in `next` order (titles/goals match).
  - neighborhood (for the last waypoint / default anchor) includes its action node(s); an executed action's outcome appears as a `kind:"outcome"` item.
  - `text` is non-empty, references the waypoint goals, and is bounded (assert length or item-count ≤ a cap when maxItems=1).
  - `maxItems: 1` caps the neighborhood to 1 item.
  - empty graph (a fresh route never mirrored) → all-empty context, no throw.
  - cross-tenant routeId → `/not found|scope/`.

- [ ] **Step 2: Run → FAIL. Step 3: Implement `buildAgentContext`** — scoped reads; walk the `next` spine (query waypoint nodes for the route via their sourceId↔RouteWaypoint order, OR reconstruct from `next` edges — simplest: load waypoint mirror nodes and order by the source RouteWaypoint.order via a join, matching `getTimeline`'s approach); neighborhood + outcomes; `maxItems` cap; compact `text`. Header comment: §Memory read=traversal, pure/scoped/budget-capped, learnings empty until the 5c belief layer.
- [ ] **Step 4: Run → green; FULL mcp suite; build. Step 5: Commit** — `feat: buildAgentContext - plan-anchored causal recall (ancestor path + neighborhood + outcomes, budget-capped)`

---

### Task 4: Wire `buildAgentContext` into `draftWaypoint` (fenced, additive)

**Files:**
- Modify: `packages/department/src/draft-waypoint.ts`
- Test: `packages/department/test/draft-waypoint.test.ts` (append)

**Interfaces:** no signature change. After the budget check, `draftWaypoint`: (a) loads the waypoint's `routeId` (from `wp.routeId`, already scoped); (b) `mirrorPlanToGraph(identity, wp.routeId, new Date())` (idempotent, concurrency-safe — makes the graph current incl. outcomes); (c) `buildAgentContext(identity, { routeId: wp.routeId, waypointId: input.waypointId, role: "copywriter" })`; (d) appends a `fence("route-so-far", ctxResult.text)` block to the per-action `ctx` (ONLY when `text` is non-empty). The channel/kind instruction line and the goal/rationale fence stay exactly as they are.

- [ ] **Step 1: Failing test** (append) — a route with a PRIOR waypoint whose action is executed (a verified-live outcome), then draft a LATER waypoint's action. Capture the harness input:
  - the ctx now contains a `fence("route-so-far"` block (the open marker + "route so far" label) referencing the prior waypoint / the outcome.
  - the EXISTING assertions still hold: the channel is in the instruction line, the goal/rationale fence is present, a forged marker in the prior context is neutralized (plant one in a prior waypoint goal → assert not-verbatim in the captured input).
  - positive control: a real prior-waypoint goal's text reaches the prompt.
  - Verify the FULL existing draft-waypoint suite stays green (run it).

- [ ] **Step 2: Run → FAIL (no context block yet). Step 3: Implement** — import `mirrorPlanToGraph`/`buildAgentContext` from `dionysus-mcp/tools/memory-graph` and `fence` from `./tools/fetch-page.js`; do the mirror-then-read after the budget check; append the fenced block to `ctx` per action (or once, hoisted — the route context is the same for all actions of the waypoint, so build it ONCE before the `Promise.all` and append the same fenced block to each action's ctx). Guard: skip the block when `text` is empty (fresh graph → no dead fence).
- [ ] **Step 4: Run → new test green; the ENTIRE existing draft-waypoint suite green; FULL dept suite; build; mcp still green. Step 5: Commit** — `feat: draftWaypoint recalls the route so far - buildAgentContext fenced into the copywriter prompt`

---

### Task 5: Cockpit `/timeline` surfaces outcomes

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (`getTimeline`), `src/app/timeline/page.tsx`
- Test: `packages/cockpit/test/review.test.ts` (append)

**Interfaces:** `TimelineView`'s action shape gains `outcome: { title: string; detail: string } | null` — for each action node, its `caused` outcome node (scoped) if present. The page renders "✓ went live …" beneath an action that has an outcome. All text JSX-escaped; the postedUrl detail rendered as an `<a>` ONLY via `isRenderableHttpUrl` (reuse) else plain text.

- [ ] **Step 1: Failing test** (append) — seed a route, drive one action executed, `getTimeline(A)` → that action's `outcome` is non-null with the go-live detail; a proposed action's `outcome` is null; scoped (other tenant unaffected). (getTimeline already lazily mirrors — Task 2 makes the mirror include outcomes.)
- [ ] **Step 2: Run → FAIL. Step 3: Implement** — in `getTimeline`, for each action node, load its `caused` outcome node scoped (via the `caused` edge from the action node, or by the outcome node's sourceId = the RouteAction id) and attach; render on the page.
- [ ] **Step 4: Run → green (cockpit +~1); `next build` clean. Step 5: Commit** — `feat: timeline shows verified-live outcomes beneath their actions (the loop made visible)`

---

### Task 6: §15 eval gate — recall is faithful, honest, scoped, and bounded

**Files:**
- Test: `packages/dionysus-mcp/test/agent-context-eval.e2e.test.ts` (test-only; STOP + report BLOCKED if an invariant fails)

Invariants (self-check each for vacuity — hold the five-consecutive-clean-gate bar):
1. **Outcome honesty:** an `outcome` node is created ONLY for an executed+verified action (drive one executed, leave one proposed → exactly one outcome node, sourceId = the executed action id, body carries the postedUrl, tainted false); the outcome NEVER claims a metric moved (body is the go-live fact — assert it contains the postedUrl and does NOT contain a fabricated `%`/number). `caused` edge action→outcome exists; the proposed action has none.
2. **Traversal faithful + ordered:** `buildAgentContext` ancestorPath reconstructs the waypoint order (3 waypoints → 3 in `next` order — assert the sequence, not just length); the anchor's neighborhood includes its actions + the executed action's outcome.
3. **Budget cap real:** `maxItems: 1` bounds the neighborhood to 1 item AND the `text` length is bounded (a bug that ignored maxItems → RED); the full (uncapped) call returns more — assert the contrast so the cap is load-bearing.
4. **Empty-graph degrade:** `buildAgentContext` on a route whose graph was never mirrored → all-empty context, no throw (honest: no invented recall).
5. **Concurrency-safe (5a precondition discharged):** two concurrent `mirrorPlanToGraph` of the same route → exactly the expected node/edge counts (no duplicates); a raw duplicate `(businessId,type,sourceId)` create rejects with a unique error (the DB constraint exists).
6. **Scoped:** `buildAgentContext(B, A's routeId)` → `/not found|scope/`; B sees none of A's graph; the draft-path context for A never surfaces B's nodes.
7. **Whitelist untouched:** TOOL_SCHEMAS length 11, `not.toContain("build_agent_context")`/`not.toContain("persist_memory")` — the traversal + writers are non-MCP (reference-note lifecycle-eval pins the sorted 11).

- [ ] **Step 1: Write the gate** (real plan+lifecycle tools; tenant-scoped cleanup; ghost tenant EXISTS). Per-assertion vacuity self-check in the report. **Step 2: Run gate + FULL mcp suite + build; dept (78) + build; cockpit (+ COCKPIT_SESSION_SECRET) + next build. Report exact counts. Step 3: Commit** — `test: stage-5b eval gate - recall is faithful, honest, budget-capped, scoped, concurrency-safe`

---

## Out of Scope (deliberate — stage 5c+)

- **The belief DYNAMICS** — `learning` nodes with confidence that rises with corroboration + decays with recency, `supersedes` edges on contradiction, feature-tagged attribution (features → outcome generalization), the explore/exploit decision policy (`belief-confidence × expected progress`) — stage 5c.
- **MEASURED outcomes** — `outcome` nodes at 5b carry the verified-live FACT, not a metric delta; connecting real conversions (D21 analytics) so outcomes and the CMO report grade real numbers is stage 5d (flips CMO `analyticsConnected`).
- **`build_agent_context` / `persist_memory` as agent-facing MCP tools** — 5c, when a coordinator loop needs the agent to hydrate/write memory mid-run (conscious whitelist edit then). At 5b they are pipeline functions; whitelist stays 11.
- **next-action recommender + Growth Analyst re-personalization** — 5c/5d (the natural second consumer of `buildAgentContext`).
- **graphify / `graph.html`** — stage 7 (owned `/timeline` only).

## Self-Review Notes

- **Spec coverage:** §Memory "Read = traversal: buildAgentContext(businessId, role, routeId) — ancestor path + neighborhood + role-scoped learnings, priority-ordered, budget-capped" ✓ (T3, learnings empty until 5c); §13 outcome nodes + `caused` edges ✓ (T2); D27.1 scoping + non-MCP ✓ (gate inv 7); the 5a concurrency precondition ✓ (T1); D20 fenced context ✓ (T4); §15 gate ✓ (T6). Belief dynamics + measured outcomes + agent-tool exposure explicitly deferred.
- **Type consistency:** `AgentContext` (T3) consumed by T4; `mirrorPlanToGraph`'s new `outcomeNodeIds` (T2) used by T3/gate; `TimelineView.outcome` (T5) self-contained.
- **Judgment calls on record:** the concurrency precondition is discharged FIRST (T1) via DB `@@unique` + catch-P2002-refetch (atomic on any store; SQLite NULL-distinct keeps multi-observation nodes valid); outcome nodes are the honest verified-live FACT (no fabricated metric — measured is 5d); `buildAgentContext` is a pure read that degrades to empty (no dead recall, no mirror-inside-read); draftWaypoint wiring is additive + fenced (existing tests stay green; the block is hoisted once per waypoint); the traversal/writers stay non-MCP (whitelist 11 — agent-tool exposure is 5c); learnings dimension is forward-compatible-empty until the belief layer.
