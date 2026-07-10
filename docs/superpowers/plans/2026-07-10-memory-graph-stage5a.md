# Stage 5a — Memory-Graph Substrate (the plan mirrored into an evolution graph) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the substrate that makes the plan *compound* (D13/D31): a `MemoryNode`/`MemoryEdge` evolution graph anchored to the plan, populated by mirroring the persisted route (waypoints/actions) into graph nodes + spine edges — lazily, on cockpit view (the proven digest pattern) — and surfaced as a "watch your plan evolve" timeline. The graph-read traversal (`buildAgentContext`) and the learning loop that consumes it are stage 5b.

**Architecture:** (1) A `MemoryEdge` model + a `sourceId` on `MemoryNode` (the plan-entity it mirrors — enables idempotent re-mirroring). (2) dionysus-mcp gains `persistMemoryNode`/`persistMemoryEdge` (identity-scoped, FK-guarded, NOT MCP tools — like `recordObservation`; `persist_memory`-as-agent-tool is 5b) and `mirrorPlanToGraph(identity, routeId, now)` — idempotent, reads the route's waypoints/actions and writes `waypoint`/`action` nodes + `next` (waypoint spine) + `references` (action→waypoint) edges. (3) A cockpit `/timeline` page that lazily mirrors the current route then renders the evolution. No plan-tool changes, no publish-path perturbation, no external deps.

**Tech Stack:** unchanged — Prisma 6, vitest, Next 15 cockpit. No new dependencies.

## Global Constraints

- **§10 MemoryEdge (verbatim):** `MemoryEdge { id, businessId, fromId, toId, kind }`, kind ∈ `next|caused|informed-by|supersedes|references`. `@@index([businessId])`. `fromId`/`toId` are plain scalars referencing `MemoryNode.id` (assetId/digestId precedent — no FK cascade); the WRITE path (`persistMemoryEdge`) validates both endpoints belong to the caller's business via `findFirst({id, businessId})`.
- **§13 anchored-to-the-plan:** at 5a the graph mirrors the STRUCTURED plan only — `waypoint` nodes (one per RouteWaypoint) and `action` nodes (one per RouteAction), wired by `next` edges along the waypoint spine (ordered) and `references` edges from each action node to its waypoint node. `outcome`/`learning`/`caused`/`supersedes` are the LEARNING loop (5b) — NOT written here.
- **Mirror nodes are TRUSTED (tainted:false):** plan-mirror nodes reflect our own server-set structured plan, not ingested content — so `persistMemoryNode` defaults `tainted:false`. `recordObservation` (4e) remains the ONLY writer that forces `tainted:true` (ingestion-derived market observations). Do NOT change `recordObservation`.
- **Idempotency (lazy-on-view safety):** `mirrorPlanToGraph` is idempotent per `(businessId, type, sourceId)` — a mirror node for a given RouteWaypoint/RouteAction id is created once; a re-run finds it and does not duplicate; edges are deduped by `(businessId, fromId, toId, kind)`. This makes lazy-on-view re-calls safe (the digest pattern). `sourceId` = the mirrored RouteWaypoint/RouteAction id.
- **Lazy-on-view (no separate trigger):** `mirrorPlanToGraph` runs when the founder opens `/timeline` (like `buildDailyDigest` on `/drafts`). D30 cron/wake is NOT needed. Recorded.
- **D27.1:** identity ambient; every read/write scoped `businessId`; cross-parent guards `findFirst({id, businessId})`. `persistMemoryNode`/`persistMemoryEdge`/`mirrorPlanToGraph` take `Identity` first; NONE are MCP-registered (whitelist stays 11 — the lifecycle-eval gate must stay green untouched).
- **Clock injected:** `mirrorPlanToGraph(identity, routeId, now)` takes `now` (though 5a doesn't window on it, keep the signature clock-injected for consistency + 5b); the cockpit wrapper passes `new Date()` at the request boundary.
- **No plan-tool / publish-path changes:** do NOT touch `src/tools/plan.ts`, `src/tools/lifecycle.ts`, `src/tools/send.ts`, `draft-waypoint.ts`, or `run-radar.ts`. The graph is a read-only mirror of what those already persisted.
- **Testing:** TDD; no API key. Env: `$env:DATABASE_URL = "file:./.tmp/test.db"` (+ `$env:COCKPIT_SESSION_SECRET = "test-secret"` for cockpit). dionysus-mcp BUILT before dependents. Baselines: mcp 191, dept 78, cockpit 47 — dept stays green untouched. Pass an explicit `now` in tests.
- **Commits:** conventional, no attribution footer. **Shell:** Windows/PowerShell (Git Bash broken); pnpm workspace.

## File Structure

```
packages/dionysus-mcp/
  prisma/schema.prisma              # + MemoryEdge model; + MemoryNode.sourceId String?
  src/tools/memory-graph.ts         # persistMemoryNode / persistMemoryEdge / mirrorPlanToGraph + constants
  test/memory-graph.test.ts
  test/memory-graph-eval.e2e.test.ts  # Task 5 §15 gate
packages/cockpit/
  src/lib/review.ts                 # + getTimeline (lazy mirror-on-view + scoped read)
  src/app/timeline/page.tsx         # "watch your plan evolve" evolution view
  src/app/layout.tsx                # + Timeline nav link
  test/review.test.ts               # + getTimeline test
```

---

### Task 1: `MemoryEdge` model + `MemoryNode.sourceId` (additive)

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma`
- Test: `packages/dionysus-mcp/test/memory-graph.test.ts` (schema portion; grows in Task 2/3)

**Interfaces:**
- Produces: `MemoryEdge { id cuid, businessId (+relation +@@index), fromId, toId, kind, createdAt @default(now()) }`; `MemoryNode.sourceId String?` (+ `Business.memoryEdges MemoryEdge[]`). `fromId`/`toId`/`sourceId` plain scalars. Task 2 writes them.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/memory-graph.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

const BIZ = "biz_memgraph";

describe("MemoryEdge schema + MemoryNode.sourceId", () => {
  beforeAll(async () => {
    await prisma.memoryEdge.deleteMany({ where: { businessId: BIZ } });
    await prisma.memoryNode.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "MG" }, update: {} });
  });

  it("persists an edge between two nodes with a kind, and a node carries sourceId", async () => {
    const a = await prisma.memoryNode.create({ data: { businessId: BIZ, type: "waypoint", title: "wp1", body: "b", confidence: 1, sourceId: "wp_src_1" } });
    const b = await prisma.memoryNode.create({ data: { businessId: BIZ, type: "waypoint", title: "wp2", body: "b", confidence: 1, sourceId: "wp_src_2" } });
    const edge = await prisma.memoryEdge.create({ data: { businessId: BIZ, fromId: a.id, toId: b.id, kind: "next" } });
    expect(edge.kind).toBe("next");
    expect(a.sourceId).toBe("wp_src_1");
    expect(edge.fromId).toBe(a.id);
    expect(edge.toId).toBe(b.id);
  });

  it("sourceId is null when unset (e.g. a market-observation node)", async () => {
    const n = await prisma.memoryNode.create({ data: { businessId: BIZ, type: "market-observation", title: "t", body: "b", confidence: 0.5 } });
    expect(n.sourceId).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`packages/dionysus-mcp`, `$env:DATABASE_URL = "file:./.tmp/test.db"`).

- [ ] **Step 3: Edit `schema.prisma`** — add `sourceId String?` to `MemoryNode` (after `sourceUrl`); add `memoryEdges MemoryEdge[]` to `Business`; append:

```prisma
model MemoryEdge {
  id         String   @id @default(cuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id])
  fromId     String
  toId       String
  kind       String   // next|caused|informed-by|supersedes|references
  createdAt  DateTime @default(now())

  @@index([businessId])
}
```

- [ ] **Step 4: Generate + push + run** — `pnpm prisma generate; pnpm prisma db push; pnpm vitest run test/memory-graph.test.ts` (2 passed); FULL mcp suite (193); `pnpm build`; downstream dept (78) + cockpit (47).
- [ ] **Step 5: Commit** — `feat: MemoryEdge model + MemoryNode.sourceId (evolution-graph substrate)`

---

### Task 2: `persistMemoryNode` + `persistMemoryEdge` (scoped, FK-guarded, non-MCP)

**Files:**
- Create: `packages/dionysus-mcp/src/tools/memory-graph.ts`
- Test: `packages/dionysus-mcp/test/memory-graph.test.ts` (append)

**Interfaces:**
- Produces (NOT MCP-registered):
```ts
export const MEMORY_NODE_TYPES = ["waypoint","action","outcome","learning","market-observation","case","revision"] as const;
export const MEMORY_EDGE_KINDS = ["next","caused","informed-by","supersedes","references"] as const;

export type MemoryNodeInput = {
  type: (typeof MEMORY_NODE_TYPES)[number]; title: string; body: string; confidence: number;
  role?: string; waypointId?: string; sourceId?: string; tainted?: boolean;   // tainted defaults false
};
persistMemoryNode(identity, input): Promise<{ nodeId: string }>   // validates type + confidence 0..1; tainted defaults false

export type MemoryEdgeInput = { fromId: string; toId: string; kind: (typeof MEMORY_EDGE_KINDS)[number] };
persistMemoryEdge(identity, input): Promise<{ edgeId: string }>   // validates kind; BOTH endpoints must belong to the business (findFirst scope guard); dedups (businessId, fromId, toId, kind) — returns the existing edge id if already present
```
  Function-layer validation (type ∈ set, kind ∈ set, confidence 0..1 finite) BEFORE any write. `persistMemoryEdge` fail-closed: if `fromId` or `toId` is not a MemoryNode in this business → throw `/not found|scope/`. Edge dedup: if an identical `(businessId, fromId, toId, kind)` edge exists, return it (idempotent — no duplicate). Task 3 consumes both.

- [ ] **Step 1: Failing tests** (append) — cases: (a) persistMemoryNode writes a `waypoint` node with `tainted:false` default, scoped; (b) a bad type / out-of-range confidence throws; (c) persistMemoryEdge links two same-business nodes, kind validated; (d) a cross-tenant `toId` (a node in another business) → throws `/not found|scope/`; (e) a bad kind → throws; (f) persistMemoryEdge called twice with the same (from,to,kind) returns the SAME edgeId (dedup — assert one row in the DB).

- [ ] **Step 2: Run → FAIL. Step 3: Implement `src/tools/memory-graph.ts`**

```ts
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export const MEMORY_NODE_TYPES = ["waypoint","action","outcome","learning","market-observation","case","revision"] as const;
export const MEMORY_EDGE_KINDS = ["next","caused","informed-by","supersedes","references"] as const;
export type MemoryNodeType = (typeof MEMORY_NODE_TYPES)[number];
export type MemoryEdgeKind = (typeof MEMORY_EDGE_KINDS)[number];

export type MemoryNodeInput = { type: MemoryNodeType; title: string; body: string; confidence: number; role?: string; waypointId?: string; sourceId?: string; tainted?: boolean };
export type MemoryEdgeInput = { fromId: string; toId: string; kind: MemoryEdgeKind };

export async function persistMemoryNode(identity: Identity, input: MemoryNodeInput): Promise<{ nodeId: string }> {
  if (!MEMORY_NODE_TYPES.includes(input.type)) throw new Error(`Invalid memory node type "${input.type}".`);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`Invalid confidence ${input.confidence} (must be a number in 0..1).`);
  }
  const row = await prisma.memoryNode.create({ data: {
    businessId: identity.businessId, type: input.type, title: input.title, body: input.body,
    confidence: input.confidence, role: input.role ?? null, waypointId: input.waypointId ?? null,
    sourceId: input.sourceId ?? null, tainted: input.tainted ?? false } });
  return { nodeId: row.id };
}

export async function persistMemoryEdge(identity: Identity, input: MemoryEdgeInput): Promise<{ edgeId: string }> {
  if (!MEMORY_EDGE_KINDS.includes(input.kind)) throw new Error(`Invalid memory edge kind "${input.kind}".`);
  const from = await prisma.memoryNode.findFirst({ where: { id: input.fromId, businessId: identity.businessId } });
  if (!from) throw new Error(`Edge fromId ${input.fromId} not found in this business scope.`);
  const to = await prisma.memoryNode.findFirst({ where: { id: input.toId, businessId: identity.businessId } });
  if (!to) throw new Error(`Edge toId ${input.toId} not found in this business scope.`);
  const existing = await prisma.memoryEdge.findFirst({
    where: { businessId: identity.businessId, fromId: input.fromId, toId: input.toId, kind: input.kind } });
  if (existing) return { edgeId: existing.id };
  const row = await prisma.memoryEdge.create({ data: {
    businessId: identity.businessId, fromId: input.fromId, toId: input.toId, kind: input.kind } });
  return { edgeId: row.id };
}
```

- [ ] **Step 4: Run → green; FULL mcp suite; build; downstream. Step 5: Commit** — `feat: persistMemoryNode/persistMemoryEdge - scoped, FK-guarded, idempotent-edge graph writers`

---

### Task 3: `mirrorPlanToGraph` — the plan mirrored into the graph (idempotent)

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/memory-graph.ts` (+ `mirrorPlanToGraph`)
- Test: `packages/dionysus-mcp/test/memory-graph.test.ts` (append)

**Interfaces:**
- Consumes: `prisma`, `persistMemoryNode`/`persistMemoryEdge`, `Identity`.
- Produces: `mirrorPlanToGraph(identity, routeId: string, now: Date): Promise<{ waypointNodeIds: string[]; actionNodeIds: string[]; edgeCount: number }>` — idempotent. Flow:
  1. Scoped route load (throw not-found).
  2. Load the route's waypoints (ordered by `order`), scoped.
  3. For each waypoint: find-or-create its mirror node (`findFirst({businessId, type:"waypoint", sourceId: wp.id})`; else `persistMemoryNode({type:"waypoint", title: wp.title, body: wp.goal, confidence:1, waypointId: wp.id, sourceId: wp.id})`). Collect ids in waypoint order.
  4. `next` edges along the waypoint spine (node[i] → node[i+1]) via `persistMemoryEdge` (deduped).
  5. For each waypoint, load its RouteActions (scoped); for each action: find-or-create its mirror node (`type:"action"`, title=`${employeeRole}/${type}`, body=rationale, confidence:1, waypointId: wp.id, sourceId: action.id) + a `references` edge action-node → waypoint-node.
  6. Return the collected ids + total edges. Re-running yields the SAME node ids and no new rows (idempotent).

- [ ] **Step 1: Failing tests** (append) — seed via real plan tools (createObjective→persistRoute→persistWaypoint×2→upsertRouteAction×2 on wp1) → `mirrorPlanToGraph(A, routeId, now)`:
  - waypointNodeIds length 2 (in order), actionNodeIds length 2; a `next` edge between the two waypoint nodes; a `references` edge from each action node to wp1's node.
  - node.sourceId maps back to the RouteWaypoint/RouteAction id; waypoint node body == wp.goal.
  - **idempotent:** call `mirrorPlanToGraph` AGAIN → same waypointNodeIds (by set), and `prisma.memoryNode.count` / `memoryEdge.count` unchanged (no duplicates).
  - cross-tenant: `mirrorPlanToGraph(B, A's routeId)` → `/not found|scope/` (route not in B).

- [ ] **Step 2: Run → FAIL. Step 3: Implement `mirrorPlanToGraph`** per the flow (find-or-create by sourceId; ordered next-spine; references edges; all scoped). Header comment: §13 anchored-to-plan, idempotent lazy-on-view, mirror nodes trusted (tainted false).
- [ ] **Step 4: Run → green; FULL mcp suite; build; downstream. Step 5: Commit** — `feat: mirrorPlanToGraph - idempotent plan-to-evolution-graph mirror (waypoint spine + action references)`

---

### Task 4: Cockpit `/timeline` evolution view

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (+ `getTimeline`), `src/app/layout.tsx` (nav)
- Create: `packages/cockpit/src/app/timeline/page.tsx`
- Test: `packages/cockpit/test/review.test.ts` (append)

**Interfaces:**
- `getTimeline(identity): Promise<TimelineView>` where `TimelineView = { hasRoute: boolean; waypoints: Array<{ nodeId, title, goal, actions: Array<{ nodeId, label, rationale }> }> }` — finds the latest route (scoped), calls `mirrorPlanToGraph(identity, route.id, new Date())` (lazy mirror-on-view — real clock at the boundary), then reads back the mirrored graph scoped: waypoint nodes ordered by their `next` spine (or by the source waypoint order), each with its `references`-linked action nodes. No route → `{hasRoute:false, waypoints:[]}`.
- `/timeline` (force-dynamic): requireSession → getTimeline → "How your plan has evolved" — the waypoint spine with actions beneath each; a note that this is the live evolution graph. All text JSX-escaped; no dangerous sinks.
- Nav: add Timeline (e.g. Home · Route · Timeline · Radar · Drafts · Send · Report).

- [ ] **Step 1: Failing test** (append to review.test.ts) — seed a route with 2 waypoints + actions via the real plan tools for tenant A → `getTimeline(A)` returns `hasRoute:true`, waypoints length 2 in order, each with its actions; a second call is stable (idempotent mirror — same shape, no error); another tenant with no route → `hasRoute:false`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** — `getTimeline` (import `mirrorPlanToGraph` from `dionysus-mcp/tools/memory-graph`; scoped reads); the page; the nav.
- [ ] **Step 4: Run → green (cockpit +~1); `next build` clean (`/timeline` dynamic). Step 5: Commit** — `feat: cockpit timeline - watch your plan evolve (lazy-mirrored evolution graph)`

---

### Task 5: §15 eval gate — the graph is a faithful, scoped, idempotent mirror

**Files:**
- Test: `packages/dionysus-mcp/test/memory-graph-eval.e2e.test.ts` (test-only; STOP + report BLOCKED if an invariant fails)

Invariants (self-check each for vacuity — hold the four-consecutive-clean-gate bar):
1. **Faithful mirror:** a route with 3 waypoints (ordered) + N actions → after `mirrorPlanToGraph`, exactly 3 `waypoint` nodes (sourceId = each RouteWaypoint id), N `action` nodes (sourceId = each RouteAction id), a `next` edge between consecutive waypoint nodes in the RIGHT order (assert the spine reconstructs the waypoint order), and a `references` edge from each action node to its waypoint node. Read from the DB rows.
2. **Idempotent (the lazy-on-view invariant):** call `mirrorPlanToGraph` THREE times → node/edge counts identical after each (assert exact counts, not just "no error"); the returned node ids are stable across calls.
3. **Mirror nodes are TRUSTED:** every plan-mirror node (`type` ∈ {waypoint, action}) has `tainted === false` (contrast: a `recordObservation` market-observation node in the same business has `tainted === true` — assert both, proving persistMemoryNode's default vs recordObservation's forced true).
4. **Edge FK guard (scoped):** `persistMemoryEdge` with a `toId` that is a node in ANOTHER business → throws `/not found|scope/`; no edge row written (count-pinned). Non-vacuous: the other-business node genuinely EXISTS.
5. **Cross-tenant mirror:** `mirrorPlanToGraph(B, A's routeId)` → `/not found|scope/`; B gets zero graph rows from A's plan (count 0); A's graph unaffected.
6. **Whitelist untouched:** TOOL_SCHEMAS length 11, `not.toContain("persist_memory")`/`not.toContain("mirror_plan")` — graph writes are not agent-triggerable via MCP (reference-note lifecycle-eval pins the sorted 11).

- [ ] **Step 1: Write the gate** (fixtures via real plan tools; tenant-scoped cleanup; ghost tenant EXISTS). Per-assertion vacuity self-check in the report. **Step 2: Run gate + FULL mcp suite + build; dept (78) + build; cockpit (+ COCKPIT_SESSION_SECRET) + next build. Report exact counts. Step 3: Commit** — `test: stage-5a eval gate - the evolution graph is a faithful, idempotent, scoped mirror of the plan`

---

## Out of Scope (deliberate — stage 5b+)

- **`buildAgentContext` traversal** (ancestor path + neighborhood + role-scoped learnings, priority-ordered/budget-capped) — the graph-READ primitive is stage 5b, built with its consumers (wiring into draftWaypoint/proposeRoute/discover/simulate/radar).
- **The learning loop** — `outcome`/`learning` nodes, `caused`/`supersedes` edges, feature-tagged attribution, evidence-weighted beliefs, explore/exploit — stage 5b.
- **`persist_memory` as an agent-facing MCP tool** — 5b (whitelist stays 11 here; the graph writers are non-MCP functions).
- **Analytics integration (D21) + the `Integration` model** — stage 5c (flips the CMO report's `analyticsConnected` to true + feeds `metricDeltaPct`).
- **next-action recommender + Growth Analyst re-personalization** — stage 5b/5d.
- **graphify consolidation / `graph.html`** — stage 7 (owned Timeline view only until then — this stage's `/timeline` IS that owned view).
- **`TimelineEvent` model + promoted "significant moments"** — the richer timeline is later; 5a renders the raw plan-evolution graph.

## Self-Review Notes

- **Spec coverage:** §17 stage-5 "Memory graph (MemoryNode/MemoryEdge + … taint flags)" ✓ — MemoryEdge (T1), scoped writers (T2), plan mirror (T3); §13 anchored-to-plan (waypoint/action nodes + next spine + references) ✓ (T3); the owned Timeline view ("graphify deferred… live graph + owned Timeline only") ✓ (T4); D27.1 scoping + non-MCP ✓ (whitelist gate inv 6); §15 gate ✓ (T5). buildAgentContext + learning loop + analytics explicitly deferred to 5b/5c.
- **Type consistency:** `MEMORY_NODE_TYPES`/`MEMORY_EDGE_KINDS`/`MemoryNodeInput`/`MemoryEdgeInput` (T2) consumed by T3; `mirrorPlanToGraph` result (T3) consumed by T4's `getTimeline`; `TimelineView` (T4) self-contained.
- **Judgment calls on record:** graph is a lazy-on-view mirror (digest pattern — no plan-tool/publish-path change, no separate trigger); mirror nodes trusted (tainted false — they mirror our own structured plan, not ingested content); idempotency via (businessId, type, sourceId) natural key + (businessId, from, to, kind) edge dedup (lazy re-calls safe); writers are non-MCP (persist_memory-as-tool is 5b); fromId/toId plain scalars with WRITE-path scope guards (assetId/digestId precedent); buildAgentContext deferred to 5b so 5a ships no dead read-primitive; the /timeline view is the spec's "owned Timeline view" (graphify is stage 7).
