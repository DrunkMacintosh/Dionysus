// §15 stage-5a eval gate — the evolution graph is a FAITHFUL, IDEMPOTENT, SCOPED
// mirror of the plan. §13 anchors the 5a graph to the STRUCTURED plan only: one
// `waypoint` node per RouteWaypoint and one `action` node per RouteAction, wired by
// a `next` spine along the ordered waypoints and `references` edges from each action
// node to its waypoint node. This gate defends that the mirror is (1) a faithful copy
// of the plan's shape and order, (2) idempotent under lazy-on-view re-calls, (3) built
// from TRUSTED nodes (tainted:false — contrast recordObservation's forced true), (4)
// FK-guarded against cross-tenant edge endpoints, (5) scope-guarded against mirroring
// another tenant's route, and (6) never agent-triggerable (the 11-tool whitelist).
//
// Every chain is built with the REAL plan tools end-to-end (createObjective ->
// persistRoute -> persistWaypoint -> upsertRouteAction), never a raw prisma row, so
// the gate exercises the genuine plan surface the mirror reads from. All assertions
// read back from the DB rows (not just the mirror return value). Tenants live under a
// biz_mgeval_* namespace so this gate never collides with memory-graph.test.ts (which
// owns biz_mirror_a/b + biz_memgraph_*) or the other e2e suites sharing the test DB.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { TOOL_SCHEMAS } from "../src/server.js";
import { persistMemoryNode, persistMemoryEdge, mirrorPlanToGraph } from "../src/tools/memory-graph.js";
import { recordObservation } from "../src/tools/memory.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";

// A FIXED clock. 5a does not window on `now`, but pass it explicitly (5b consistency).
const NOW = new Date("2026-07-10T12:00:00.000Z");

// One tenant per invariant so no fixture perturbs another; all EXIST (upserted) so
// every cross-tenant refusal is scope-based, never an artifact of an unknown business.
const MIRROR = { businessId: "biz_mgeval_mirror" }; //  inv1: faithful 3-waypoint / 4-action mirror
const IDEM = { businessId: "biz_mgeval_idem" }; //       inv2: idempotent under 3 calls
const TRUST = { businessId: "biz_mgeval_trust" }; //     inv3: mirror trusted vs observation tainted
const GUARD = { businessId: "biz_mgeval_guard" }; //     inv4: edge from-node lives here
const GUARD_OTHER = { businessId: "biz_mgeval_other" }; //inv4: the cross-tenant to-node lives here
const XA = { businessId: "biz_mgeval_xa" }; //           inv5: has a real route + graph
const XB = { businessId: "biz_mgeval_xb" }; //           inv5: ghost tenant, zero graph rows

const ALL = [MIRROR, IDEM, TRUST, GUARD, GUARD_OTHER, XA, XB];

async function wipe(businessId: string): Promise<void> {
  // Graph rows use scalar refs (no FK cascade) — delete edges then nodes. Plan rows are
  // FK-safe order: Asset -> RouteAction -> RouteWaypoint -> Route -> Objective.
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

// ---- inv1 fixture handles (3 ordered waypoints, actions distributed 2/1/1 = N=4) ----
let mwp1: string, mwp2: string, mwp3: string;
const mActionToWaypoint: Record<string, string> = {}; // RouteAction id -> its RouteWaypoint id

// ---- inv2 fixture handles (3 waypoints, 1 action each -> 6 nodes, 5 edges) ----
let idemRouteId: string;
let idem1: Awaited<ReturnType<typeof mirrorPlanToGraph>>;

// ---- inv4 fixture handle (a genuinely-existing node in ANOTHER business) ----
let guardOtherNodeId: string;

// ---- inv5 fixture handle (A's route id; B tries to mirror it) ----
let xaRouteId: string;

describe("§15 stage-5a eval gate — the evolution graph is a faithful, idempotent, scoped mirror of the plan", () => {
  beforeAll(async () => {
    for (const t of ALL) await wipe(t.businessId);
    for (const t of ALL) await prisma.business.upsert({ where: { id: t.businessId }, create: { id: t.businessId, name: t.businessId }, update: {} });

    // inv1 — 3 ordered waypoints; actions 2 on wp1, 1 on wp2, 1 on wp3 (N=4). Multiple
    // actions on one waypoint makes the per-action `references` edge load-bearing (proves
    // per-action wiring, not per-waypoint). Built via the REAL plan tools.
    {
      const { objectiveId } = await createObjective(MIRROR, { kind: "growth", target: "1k signups", metric: "signups" });
      const { routeId } = await persistRoute(MIRROR, { objectiveId, source: "composed" });
      ({ waypointId: mwp1 } = await persistWaypoint(MIRROR, { routeId, order: 1, title: "Alpha", goal: "Reach alpha" }));
      ({ waypointId: mwp2 } = await persistWaypoint(MIRROR, { routeId, order: 2, title: "Beta", goal: "Reach beta" }));
      ({ waypointId: mwp3 } = await persistWaypoint(MIRROR, { routeId, order: 3, title: "Gamma", goal: "Reach gamma" }));
      const { actionId: ma1 } = await upsertRouteAction(MIRROR, { waypointId: mwp1, employeeRole: "cmo", type: "post", rationale: "r1" });
      const { actionId: ma2 } = await upsertRouteAction(MIRROR, { waypointId: mwp1, employeeRole: "cto", type: "build", rationale: "r2" });
      const { actionId: ma3 } = await upsertRouteAction(MIRROR, { waypointId: mwp2, employeeRole: "cmo", type: "email", rationale: "r3" });
      const { actionId: ma4 } = await upsertRouteAction(MIRROR, { waypointId: mwp3, employeeRole: "cfo", type: "report", rationale: "r4" });
      mActionToWaypoint[ma1] = mwp1; mActionToWaypoint[ma2] = mwp1; mActionToWaypoint[ma3] = mwp2; mActionToWaypoint[ma4] = mwp3;
      await mirrorPlanToGraph(MIRROR, routeId, NOW);
    }

    // inv2 — 3 waypoints, 1 action each -> 6 nodes (3 wp + 3 action), 5 edges (2 next + 3 refs).
    {
      const { objectiveId } = await createObjective(IDEM, { kind: "growth", target: "500 signups", metric: "signups" });
      ({ routeId: idemRouteId } = await persistRoute(IDEM, { objectiveId, source: "composed" }));
      const { waypointId: iwp1 } = await persistWaypoint(IDEM, { routeId: idemRouteId, order: 1, title: "One", goal: "g1" });
      const { waypointId: iwp2 } = await persistWaypoint(IDEM, { routeId: idemRouteId, order: 2, title: "Two", goal: "g2" });
      const { waypointId: iwp3 } = await persistWaypoint(IDEM, { routeId: idemRouteId, order: 3, title: "Three", goal: "g3" });
      await upsertRouteAction(IDEM, { waypointId: iwp1, employeeRole: "cmo", type: "post", rationale: "a1" });
      await upsertRouteAction(IDEM, { waypointId: iwp2, employeeRole: "cto", type: "build", rationale: "a2" });
      await upsertRouteAction(IDEM, { waypointId: iwp3, employeeRole: "cfo", type: "report", rationale: "a3" });
      idem1 = await mirrorPlanToGraph(IDEM, idemRouteId, NOW); // call #1 of 3
    }

    // inv3 — mirror a plan (>=1 waypoint + >=1 action) AND record a market observation in
    // the SAME business, so the tainted contrast is inside one tenant.
    {
      const { objectiveId } = await createObjective(TRUST, { kind: "growth", target: "t", metric: "m" });
      const { routeId } = await persistRoute(TRUST, { objectiveId, source: "composed" });
      const { waypointId: twp1 } = await persistWaypoint(TRUST, { routeId, order: 1, title: "T1", goal: "tg1" });
      const { waypointId: twp2 } = await persistWaypoint(TRUST, { routeId, order: 2, title: "T2", goal: "tg2" });
      await upsertRouteAction(TRUST, { waypointId: twp1, employeeRole: "cmo", type: "post", rationale: "tr1" });
      await upsertRouteAction(TRUST, { waypointId: twp2, employeeRole: "cto", type: "build", rationale: "tr2" });
      await mirrorPlanToGraph(TRUST, routeId, NOW);
      await recordObservation(TRUST, { title: "Rival launched X", body: "seen on HN", sourceUrl: "https://news.test/x", confidence: 0.6 });
    }

    // inv4 — GUARD gets a real mirror (so it has valid from-nodes); GUARD_OTHER gets a
    // genuinely-existing node that the cross-tenant edge will (illegally) point at.
    {
      const { objectiveId } = await createObjective(GUARD, { kind: "growth", target: "t", metric: "m" });
      const { routeId } = await persistRoute(GUARD, { objectiveId, source: "composed" });
      const { waypointId } = await persistWaypoint(GUARD, { routeId, order: 1, title: "G1", goal: "gg1" });
      await upsertRouteAction(GUARD, { waypointId, employeeRole: "cmo", type: "post", rationale: "gr1" });
      await mirrorPlanToGraph(GUARD, routeId, NOW);
      ({ nodeId: guardOtherNodeId } = await persistMemoryNode(GUARD_OTHER, { type: "waypoint", title: "other", body: "b", confidence: 1, sourceId: "other_src" }));
    }

    // inv5 — XA gets a real route + mirror; XB (ghost) EXISTS but has NO plan and NO graph.
    {
      const { objectiveId } = await createObjective(XA, { kind: "growth", target: "t", metric: "m" });
      ({ routeId: xaRouteId } = await persistRoute(XA, { objectiveId, source: "composed" }));
      const { waypointId: xwp1 } = await persistWaypoint(XA, { routeId: xaRouteId, order: 1, title: "X1", goal: "xg1" });
      const { waypointId: xwp2 } = await persistWaypoint(XA, { routeId: xaRouteId, order: 2, title: "X2", goal: "xg2" });
      await upsertRouteAction(XA, { waypointId: xwp1, employeeRole: "cmo", type: "post", rationale: "xr1" });
      await upsertRouteAction(XA, { waypointId: xwp2, employeeRole: "cto", type: "build", rationale: "xr2" });
      await mirrorPlanToGraph(XA, xaRouteId, NOW);
    }
  });

  // inv1 — FAITHFUL MIRROR. 3 ordered waypoints + 4 actions -> exactly 3 waypoint nodes
  // (sourceId = each RouteWaypoint id), 4 action nodes (sourceId = each RouteAction id),
  // a `next` spine that RECONSTRUCTS the waypoint order (walked edge-by-edge, not merely
  // "2 edges exist"), and a `references` edge from each action node to ITS OWN waypoint
  // node. Every count and shape is read back from the DB rows.
  it("inv1 faithful mirror: 3 ordered waypoints + 4 actions -> 3 wp nodes, 4 action nodes, an ordered `next` spine, and per-action `references` edges", async () => {
    const biz = MIRROR.businessId;

    // exact node counts, from the DB
    expect(await prisma.memoryNode.count({ where: { businessId: biz, type: "waypoint" } })).toBe(3);
    expect(await prisma.memoryNode.count({ where: { businessId: biz, type: "action" } })).toBe(4);

    // sourceId of each waypoint node maps back to a RouteWaypoint id (exact set)
    const wpNodes = await prisma.memoryNode.findMany({ where: { businessId: biz, type: "waypoint" } });
    expect(new Set(wpNodes.map((n) => n.sourceId))).toEqual(new Set([mwp1, mwp2, mwp3]));

    // sourceId of each action node maps back to a RouteAction id (exact set)
    const actionNodes = await prisma.memoryNode.findMany({ where: { businessId: biz, type: "action" } });
    expect(new Set(actionNodes.map((n) => n.sourceId))).toEqual(new Set(Object.keys(mActionToWaypoint)));

    // --- the `next` spine RECONSTRUCTS the waypoint order (load-bearing) ---
    const nextEdges = await prisma.memoryEdge.findMany({ where: { businessId: biz, kind: "next" } });
    expect(nextEdges).toHaveLength(2); // 3 consecutive waypoints -> exactly 2 `next` edges
    const nextMap = new Map(nextEdges.map((e) => [e.fromId, e.toId]));
    const nextTargets = new Set(nextEdges.map((e) => e.toId));
    const head = wpNodes.find((n) => !nextTargets.has(n.id)); // the node no `next` points at = spine head
    expect(head).toBeDefined();
    const sourceByNodeId = new Map(wpNodes.map((n) => [n.id, n.sourceId]));
    const spine: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = head!.id;
    while (cur && !seen.has(cur)) { seen.add(cur); spine.push(cur); cur = nextMap.get(cur); }
    // The reconstructed spine, in node-visit order, IS the RouteWaypoint order.
    expect(spine.map((id) => sourceByNodeId.get(id))).toEqual([mwp1, mwp2, mwp3]);

    // --- each action node `references` ITS OWN waypoint node (not just any waypoint) ---
    const refEdges = await prisma.memoryEdge.findMany({ where: { businessId: biz, kind: "references" } });
    expect(refEdges).toHaveLength(4); // one per action
    const wpNodeBySource = new Map(wpNodes.map((n) => [n.sourceId, n.id]));
    for (const an of actionNodes) {
      const expectedWpNodeId = wpNodeBySource.get(mActionToWaypoint[an.sourceId!]);
      const edge = refEdges.find((e) => e.fromId === an.id && e.toId === expectedWpNodeId);
      expect(edge, `action node ${an.sourceId} must reference its own waypoint node`).toBeDefined();
    }
  });

  // inv2 — IDEMPOTENT (the lazy-on-view invariant). Call #1 ran in beforeAll; call it a
  // 2nd and 3rd time. After EACH call the node/edge counts are the exact fixture counts
  // (6 nodes, 5 edges — not just "unchanged from a black-box baseline") and the returned
  // node ids are identical, proving a re-run duplicates NOTHING.
  it("inv2 idempotent: three mirror calls leave exactly 6 nodes / 5 edges each time, with stable node ids", async () => {
    const biz = IDEM.businessId;
    const EXPECT_NODES = 6; // 3 waypoint + 3 action
    const EXPECT_EDGES = 5; // 2 next + 3 references

    // after call #1 (in beforeAll)
    expect(await prisma.memoryNode.count({ where: { businessId: biz } })).toBe(EXPECT_NODES);
    expect(await prisma.memoryEdge.count({ where: { businessId: biz } })).toBe(EXPECT_EDGES);

    const two = await mirrorPlanToGraph(IDEM, idemRouteId, NOW); // call #2
    expect(await prisma.memoryNode.count({ where: { businessId: biz } })).toBe(EXPECT_NODES);
    expect(await prisma.memoryEdge.count({ where: { businessId: biz } })).toBe(EXPECT_EDGES);
    expect(new Set(two.waypointNodeIds)).toEqual(new Set(idem1.waypointNodeIds));
    expect(new Set(two.actionNodeIds)).toEqual(new Set(idem1.actionNodeIds));

    const three = await mirrorPlanToGraph(IDEM, idemRouteId, NOW); // call #3
    expect(await prisma.memoryNode.count({ where: { businessId: biz } })).toBe(EXPECT_NODES);
    expect(await prisma.memoryEdge.count({ where: { businessId: biz } })).toBe(EXPECT_EDGES);
    expect(new Set(three.waypointNodeIds)).toEqual(new Set(idem1.waypointNodeIds));
    expect(new Set(three.actionNodeIds)).toEqual(new Set(idem1.actionNodeIds));
  });

  // inv3 — MIRROR NODES ARE TRUSTED. Every plan-mirror node (waypoint/action) is
  // tainted:false (persistMemoryNode's default); a recordObservation market-observation
  // node in the SAME business is tainted:true (recordObservation forces it). Both are
  // asserted so the contrast — default vs forced — is proven, not assumed. Non-vacuous:
  // the mirror-node set is non-empty and contains BOTH a waypoint and an action node.
  it("inv3 mirror nodes trusted: every waypoint/action node is tainted:false while a same-business market-observation is tainted:true", async () => {
    const biz = TRUST.businessId;

    const mirrorNodes = await prisma.memoryNode.findMany({ where: { businessId: biz, type: { in: ["waypoint", "action"] } } });
    expect(mirrorNodes.length).toBeGreaterThan(0); // not vacuously true over an empty set
    expect(mirrorNodes.some((n) => n.type === "waypoint")).toBe(true);
    expect(mirrorNodes.some((n) => n.type === "action")).toBe(true);
    for (const n of mirrorNodes) expect(n.tainted).toBe(false); // TRUSTED — persistMemoryNode default

    const obs = await prisma.memoryNode.findMany({ where: { businessId: biz, type: "market-observation" } });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.tainted).toBe(true); // recordObservation forces tainted:true
  });

  // inv4 — EDGE FK GUARD (scoped). persistMemoryEdge with a toId that is a node in ANOTHER
  // business is refused (/not found|scope/) and writes NO edge row. Non-vacuous: the
  // other-business node GENUINELY EXISTS (asserted), so the refusal is the scope guard, not
  // a missing id; the from-node genuinely exists in the caller's business. Count-pinned:
  // GUARD's edge count is unchanged and no edge anywhere points at the cross-tenant node.
  it("inv4 edge FK guard: an edge to a node in another business is refused and writes no row (the other node genuinely exists)", async () => {
    // precondition — the target node EXISTS, in the OTHER business
    const other = await prisma.memoryNode.findUnique({ where: { id: guardOtherNodeId } });
    expect(other).not.toBeNull();
    expect(other!.businessId).toBe(GUARD_OTHER.businessId);

    // a valid from-node inside the caller's business
    const fromNode = await prisma.memoryNode.findFirst({ where: { businessId: GUARD.businessId, type: "waypoint" } });
    expect(fromNode).not.toBeNull();

    const edgesBefore = await prisma.memoryEdge.count({ where: { businessId: GUARD.businessId } });
    await expect(persistMemoryEdge(GUARD, { fromId: fromNode!.id, toId: guardOtherNodeId, kind: "next" }))
      .rejects.toThrow(/not found|scope/i);

    // no edge row written — count-pinned in the caller's business AND against the cross node
    expect(await prisma.memoryEdge.count({ where: { businessId: GUARD.businessId } })).toBe(edgesBefore);
    expect(await prisma.memoryEdge.count({ where: { toId: guardOtherNodeId } })).toBe(0);
  });

  // inv5 — CROSS-TENANT MIRROR. mirrorPlanToGraph(B, A's routeId) is refused at the scoped
  // route load (/not found|scope/); B gets ZERO graph rows from A's plan and A's graph is
  // untouched. Non-vacuous: A genuinely has graph rows (a broken guard would copy them into
  // B), and ghost B EXISTS with a clean, zero-row starting state.
  it("inv5 cross-tenant mirror: a ghost tenant cannot mirror tenant A's route -> refused, B gets zero rows, A untouched", async () => {
    // ghost B EXISTS and starts with zero graph rows
    expect(await prisma.memoryNode.count({ where: { businessId: XB.businessId } })).toBe(0);
    expect(await prisma.memoryEdge.count({ where: { businessId: XB.businessId } })).toBe(0);

    // A has real graph rows to (illegally) copy — the non-vacuous target
    const aNodesBefore = await prisma.memoryNode.count({ where: { businessId: XA.businessId } });
    const aEdgesBefore = await prisma.memoryEdge.count({ where: { businessId: XA.businessId } });
    expect(aNodesBefore).toBeGreaterThan(0);
    expect(aEdgesBefore).toBeGreaterThan(0);

    await expect(mirrorPlanToGraph(XB, xaRouteId, NOW)).rejects.toThrow(/not found|scope/i);

    // B got ZERO graph rows from A's plan
    expect(await prisma.memoryNode.count({ where: { businessId: XB.businessId } })).toBe(0);
    expect(await prisma.memoryEdge.count({ where: { businessId: XB.businessId } })).toBe(0);
    // A's graph unaffected
    expect(await prisma.memoryNode.count({ where: { businessId: XA.businessId } })).toBe(aNodesBefore);
    expect(await prisma.memoryEdge.count({ where: { businessId: XA.businessId } })).toBe(aEdgesBefore);
  });

  // inv6 — WHITELIST UNTOUCHED. The graph writers (persistMemoryNode/persistMemoryEdge/
  // mirrorPlanToGraph) take an Identity first and are NOT MCP-registered, so no agent can
  // trigger a graph write. The agent surface stays the exact 11 tools; the sorted 11 is
  // pinned canonically by the stage-3c lifecycle gate (test/lifecycle-eval.e2e.test.ts) —
  // here we pin the count and the specific forbidden graph-writer names.
  it("inv6 whitelist untouched: TOOL_SCHEMAS stays exactly 11 and never exposes a graph writer", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    expect(toolNames).not.toContain("persist_memory");
    expect(toolNames).not.toContain("persist_memory_node");
    expect(toolNames).not.toContain("persist_memory_edge");
    expect(toolNames).not.toContain("mirror_plan");
    expect(toolNames).not.toContain("mirror_plan_to_graph");
  });
});
