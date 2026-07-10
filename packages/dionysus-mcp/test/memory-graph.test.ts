import { describe, it, expect, beforeAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { persistMemoryNode, persistMemoryEdge, mirrorPlanToGraph, buildAgentContext } from "../src/tools/memory-graph.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction, startExecution, completeExecution } from "../src/tools/lifecycle.js";
import { persistCraftBelief } from "../src/tools/belief-graph.js";

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

describe("persistMemoryNode + persistMemoryEdge (identity-scoped, FK-guarded)", () => {
  const NBIZ = "biz_memgraph_fn";
  const OTHER = "biz_memgraph_other";

  beforeAll(async () => {
    for (const id of [NBIZ, OTHER]) {
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
      await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
      await prisma.memoryNode.deleteMany({ where: { businessId: id } });
    }
  });

  it("persistMemoryNode writes a waypoint node with tainted:false default, scoped", async () => {
    const { nodeId } = await persistMemoryNode({ businessId: NBIZ },
      { type: "waypoint", title: "wp", body: "b", confidence: 0.8, sourceId: "rw_1" });
    const row = await prisma.memoryNode.findUnique({ where: { id: nodeId } });
    expect(row?.businessId).toBe(NBIZ);
    expect(row?.type).toBe("waypoint");
    expect(row?.tainted).toBe(false);
    expect(row?.sourceId).toBe("rw_1");
  });

  it("rejects a bad type and an out-of-range confidence", async () => {
    await expect(persistMemoryNode({ businessId: NBIZ },
      { type: "bogus" as never, title: "t", body: "b", confidence: 0.5 }))
      .rejects.toThrow(/invalid memory node type/i);
    await expect(persistMemoryNode({ businessId: NBIZ },
      { type: "waypoint", title: "t", body: "b", confidence: 1.5 }))
      .rejects.toThrow(/confidence/i);
  });

  it("persistMemoryEdge links two same-business nodes with a validated kind", async () => {
    const a = await persistMemoryNode({ businessId: NBIZ }, { type: "waypoint", title: "a", body: "b", confidence: 1 });
    const b = await persistMemoryNode({ businessId: NBIZ }, { type: "action", title: "b", body: "b", confidence: 1 });
    const { edgeId } = await persistMemoryEdge({ businessId: NBIZ }, { fromId: a.nodeId, toId: b.nodeId, kind: "references" });
    const row = await prisma.memoryEdge.findUnique({ where: { id: edgeId } });
    expect(row?.businessId).toBe(NBIZ);
    expect(row?.kind).toBe("references");
    expect(row?.fromId).toBe(a.nodeId);
    expect(row?.toId).toBe(b.nodeId);
  });

  it("rejects a cross-tenant toId (a node in another business)", async () => {
    const here = await persistMemoryNode({ businessId: NBIZ }, { type: "waypoint", title: "h", body: "b", confidence: 1 });
    const there = await persistMemoryNode({ businessId: OTHER }, { type: "waypoint", title: "t", body: "b", confidence: 1 });
    await expect(persistMemoryEdge({ businessId: NBIZ }, { fromId: here.nodeId, toId: there.nodeId, kind: "next" }))
      .rejects.toThrow(/not found|scope/i);
  });

  it("rejects a bad kind", async () => {
    const a = await persistMemoryNode({ businessId: NBIZ }, { type: "waypoint", title: "a", body: "b", confidence: 1 });
    const b = await persistMemoryNode({ businessId: NBIZ }, { type: "waypoint", title: "b", body: "b", confidence: 1 });
    await expect(persistMemoryEdge({ businessId: NBIZ }, { fromId: a.nodeId, toId: b.nodeId, kind: "bogus" as never }))
      .rejects.toThrow(/invalid memory edge kind/i);
  });

  it("dedups an identical (from,to,kind) edge — returns the SAME edgeId, one DB row", async () => {
    const a = await persistMemoryNode({ businessId: NBIZ }, { type: "waypoint", title: "a", body: "b", confidence: 1 });
    const b = await persistMemoryNode({ businessId: NBIZ }, { type: "waypoint", title: "b", body: "b", confidence: 1 });
    const first = await persistMemoryEdge({ businessId: NBIZ }, { fromId: a.nodeId, toId: b.nodeId, kind: "next" });
    const second = await persistMemoryEdge({ businessId: NBIZ }, { fromId: a.nodeId, toId: b.nodeId, kind: "next" });
    expect(second.edgeId).toBe(first.edgeId);
    const rows = await prisma.memoryEdge.findMany({ where: { businessId: NBIZ, fromId: a.nodeId, toId: b.nodeId, kind: "next" } });
    expect(rows).toHaveLength(1);
  });
});

describe("mirrorPlanToGraph — §13 plan mirror (waypoint spine + action references, idempotent)", () => {
  const A = { businessId: "biz_mirror_a" };
  const B = { businessId: "biz_mirror_b" };
  const NOW = new Date("2026-07-10T12:00:00.000Z");

  let routeId: string;
  let wp1: string;
  let wp2: string;
  let a1: string;
  let a2: string;
  let mirror: Awaited<ReturnType<typeof mirrorPlanToGraph>>;

  beforeAll(async () => {
    for (const id of [A.businessId, B.businessId]) {
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
      await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
      await prisma.memoryNode.deleteMany({ where: { businessId: id } });
    }

    // Seed via the real plan tools (createObjective → persistRoute → persistWaypoint×2 → upsertRouteAction×2 on wp1).
    const { objectiveId } = await createObjective(A, { kind: "growth", target: "1k signups", metric: "signups" });
    ({ routeId } = await persistRoute(A, { objectiveId, source: "composed" }));
    ({ waypointId: wp1 } = await persistWaypoint(A, { routeId, order: 1, title: "WP One", goal: "Goal one" }));
    ({ waypointId: wp2 } = await persistWaypoint(A, { routeId, order: 2, title: "WP Two", goal: "Goal two" }));
    ({ actionId: a1 } = await upsertRouteAction(A, { waypointId: wp1, employeeRole: "cmo", type: "post", rationale: "because one" }));
    ({ actionId: a2 } = await upsertRouteAction(A, { waypointId: wp1, employeeRole: "cto", type: "build", rationale: "because two" }));

    mirror = await mirrorPlanToGraph(A, routeId, NOW);
  });

  it("mirrors one waypoint node per RouteWaypoint, in order, sourceId→wp id, body==goal, trusted", async () => {
    expect(mirror.waypointNodeIds).toHaveLength(2);
    const nodes = await Promise.all(mirror.waypointNodeIds.map((id) => prisma.memoryNode.findUnique({ where: { id } })));
    // ordered by RouteWaypoint.order
    expect(nodes[0]?.sourceId).toBe(wp1);
    expect(nodes[1]?.sourceId).toBe(wp2);
    // shape of the first waypoint mirror node
    expect(nodes[0]?.type).toBe("waypoint");
    expect(nodes[0]?.title).toBe("WP One");
    expect(nodes[0]?.body).toBe("Goal one"); // body == wp.goal
    expect(nodes[0]?.waypointId).toBe(wp1);
    expect(nodes[0]?.confidence).toBe(1);
    expect(nodes[0]?.tainted).toBe(false); // mirror nodes are TRUSTED
    expect(nodes[0]?.businessId).toBe(A.businessId);
  });

  it("wires a `next` edge along the ordered waypoint spine", async () => {
    const edge = await prisma.memoryEdge.findFirst({
      where: { businessId: A.businessId, fromId: mirror.waypointNodeIds[0], toId: mirror.waypointNodeIds[1], kind: "next" },
    });
    expect(edge).not.toBeNull();
  });

  it("mirrors one action node per RouteAction (title=role/type, body=rationale) with a `references` edge to its waypoint node", async () => {
    expect(mirror.actionNodeIds).toHaveLength(2);
    const nodes = await Promise.all(mirror.actionNodeIds.map((id) => prisma.memoryNode.findUnique({ where: { id } })));
    // sourceId maps back to each RouteAction id
    expect(new Set(nodes.map((n) => n?.sourceId))).toEqual(new Set([a1, a2]));

    const byA1 = nodes.find((n) => n?.sourceId === a1);
    expect(byA1?.type).toBe("action");
    expect(byA1?.title).toBe("cmo/post");
    expect(byA1?.body).toBe("because one");
    expect(byA1?.waypointId).toBe(wp1);
    expect(byA1?.confidence).toBe(1);
    expect(byA1?.tainted).toBe(false);

    // each action node references wp1's mirror node (the first waypoint node)
    const wp1NodeId = mirror.waypointNodeIds[0];
    for (const actionNodeId of mirror.actionNodeIds) {
      const edge = await prisma.memoryEdge.findFirst({
        where: { businessId: A.businessId, fromId: actionNodeId, toId: wp1NodeId, kind: "references" },
      });
      expect(edge).not.toBeNull();
    }
    // total edges = 1 next + 2 references
    expect(mirror.edgeCount).toBe(3);
  });

  it("is idempotent (lazy-on-view safe): re-run returns the SAME node ids and adds ZERO rows", async () => {
    const nodeCountBefore = await prisma.memoryNode.count({ where: { businessId: A.businessId } });
    const edgeCountBefore = await prisma.memoryEdge.count({ where: { businessId: A.businessId } });

    const again = await mirrorPlanToGraph(A, routeId, NOW);

    expect(new Set(again.waypointNodeIds)).toEqual(new Set(mirror.waypointNodeIds));
    expect(new Set(again.actionNodeIds)).toEqual(new Set(mirror.actionNodeIds));
    expect(again.edgeCount).toBe(mirror.edgeCount);

    const nodeCountAfter = await prisma.memoryNode.count({ where: { businessId: A.businessId } });
    const edgeCountAfter = await prisma.memoryEdge.count({ where: { businessId: A.businessId } });
    expect(nodeCountAfter).toBe(nodeCountBefore); // no duplicate nodes
    expect(edgeCountAfter).toBe(edgeCountBefore); // no duplicate edges
  });

  it("rejects a cross-tenant route load (route not in the caller's business)", async () => {
    await expect(mirrorPlanToGraph(B, routeId, NOW)).rejects.toThrow(/not found|scope/i);
  });
});

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

  it("raw duplicate (businessId,type,sourceId) is rejected by @@unique; find-or-create returns the existing id", async () => {
    // Deterministic proof of the DB constraint (SQLite single-writer may not force the race above):
    // seed a fresh route+waypoint, mirror once, then attempt a raw create with the SAME dedup key.
    const obj = await prisma.objective.create({ data: { businessId: B, kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: B, objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: B, routeId: route.id, order: 1, title: "t2", goal: "g2", status: "active" } });
    const first = await mirrorPlanToGraph({ businessId: B }, route.id, new Date());
    const nodeId = first.waypointNodeIds[0];

    // Raw create with the same (businessId, type, sourceId) must be rejected by the @@unique index.
    await expect(
      prisma.memoryNode.create({ data: { businessId: B, type: "waypoint", title: "dup", body: "b", confidence: 1, sourceId: wp.id } }),
    ).rejects.toMatchObject({ code: "P2002" });

    // find-or-create (re-mirror) returns the SAME existing id and adds zero rows for this key.
    const again = await mirrorPlanToGraph({ businessId: B }, route.id, new Date());
    expect(again.waypointNodeIds[0]).toBe(nodeId);
    const wpNodesForKey = await prisma.memoryNode.findMany({ where: { businessId: B, type: "waypoint", sourceId: wp.id } });
    expect(wpNodesForKey).toHaveLength(1);
  });

  it("multiple sourceId-NULL nodes still coexist (unique treats NULLs as distinct)", async () => {
    const n1 = await prisma.memoryNode.create({ data: { businessId: B, type: "market-observation", title: "o1", body: "b", confidence: 0.5 } });
    const n2 = await prisma.memoryNode.create({ data: { businessId: B, type: "market-observation", title: "o2", body: "b", confidence: 0.5 } });
    expect(n1.id).not.toBe(n2.id);
  });
});

describe("mirrorPlanToGraph — outcome mirror (executed→outcome node + caused edge, honesty-scoped)", () => {
  const C = { businessId: "biz_mirror_outcome" };
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const POSTED_URL = "https://instagram.com/p/verified123";

  let routeId: string;
  let wpId: string;
  let executedActionId: string;
  let proposedActionId: string;
  let mirror: Awaited<ReturnType<typeof mirrorPlanToGraph>>;

  beforeAll(async () => {
    await prisma.business.upsert({ where: { id: C.businessId }, create: { id: C.businessId, name: C.businessId }, update: {} });
    await prisma.memoryEdge.deleteMany({ where: { businessId: C.businessId } });
    await prisma.memoryNode.deleteMany({ where: { businessId: C.businessId } });

    // Seed a route + waypoint + 2 actions on the same waypoint.
    const { objectiveId } = await createObjective(C, { kind: "growth", target: "1k signups", metric: "signups" });
    ({ routeId } = await persistRoute(C, { objectiveId, source: "composed" }));
    ({ waypointId: wpId } = await persistWaypoint(C, { routeId, order: 1, title: "WP One", goal: "Goal one" }));
    ({ actionId: executedActionId } = await upsertRouteAction(C, { waypointId: wpId, employeeRole: "cmo", type: "post", rationale: "ship it" }));
    ({ actionId: proposedActionId } = await upsertRouteAction(C, { waypointId: wpId, employeeRole: "cto", type: "build", rationale: "later" }));

    // Bind a real asset (channel=instagram), then drive ONE action through the REAL lifecycle to executed.
    const { assetId } = await persistAsset(C, { channel: "instagram", kind: "post", content: { caption: "hi" }, routeActionId: executedActionId });
    await setActionAsset(C, executedActionId, assetId);
    await approveAction(C, { routeActionId: executedActionId, principal: "founder" });
    await startExecution(C, { routeActionId: executedActionId, runId: "run_1" });
    await completeExecution(C, { routeActionId: executedActionId });
    // The verified-send fact: a real live URL + verification timestamp (what makes an outcome node honest).
    await prisma.routeAction.update({ where: { id: executedActionId }, data: { verifiedAt: NOW, postedUrl: POSTED_URL } });
    // proposedActionId is left in "proposed" — it must NOT get an outcome node.

    mirror = await mirrorPlanToGraph(C, routeId, NOW);
  });

  it("creates an outcome node ONLY for the executed+verified action (honesty gate)", async () => {
    expect(mirror.outcomeNodeIds).toHaveLength(1);
    const node = await prisma.memoryNode.findUnique({ where: { id: mirror.outcomeNodeIds[0] } });
    expect(node?.type).toBe("outcome");
    expect(node?.sourceId).toBe(executedActionId); // keyed to the action, disambiguated from the action node by type
    expect(node?.businessId).toBe(C.businessId);
    expect(node?.confidence).toBe(1);
  });

  it("titles the outcome with the bound asset channel and carries the postedUrl as body — a verified-live FACT, not a metric", async () => {
    const node = await prisma.memoryNode.findUnique({ where: { id: mirror.outcomeNodeIds[0] } });
    expect(node?.title).toBe("went live on instagram"); // channel resolved from the bound asset
    expect(node?.body).toBe(POSTED_URL); // the live URL, NOT a measured number
    // honesty: the body invents no metric (no percent, engagement, or impression count)
    expect(node?.body).not.toMatch(/\d+\s*%|\bengagement\b|\bimpressions\b|\bclicks\b/i);
  });

  it("marks the outcome node TRUSTED (tainted:false — it mirrors our own verified send, not ingested content)", async () => {
    const node = await prisma.memoryNode.findUnique({ where: { id: mirror.outcomeNodeIds[0] } });
    expect(node?.tainted).toBe(false);
  });

  it("wires a `caused` edge from the action node to the outcome node", async () => {
    const actionNode = await prisma.memoryNode.findFirst({ where: { businessId: C.businessId, type: "action", sourceId: executedActionId } });
    expect(actionNode).not.toBeNull();
    const edge = await prisma.memoryEdge.findFirst({
      where: { businessId: C.businessId, fromId: actionNode!.id, toId: mirror.outcomeNodeIds[0], kind: "caused" },
    });
    expect(edge).not.toBeNull();
  });

  it("creates NO outcome node for the proposed (non-executed) action", async () => {
    const outcomeForProposed = await prisma.memoryNode.findFirst({ where: { businessId: C.businessId, type: "outcome", sourceId: proposedActionId } });
    expect(outcomeForProposed).toBeNull();
  });

  it("is idempotent: re-run yields the SAME outcomeNodeIds and adds ZERO rows", async () => {
    const nodeCountBefore = await prisma.memoryNode.count({ where: { businessId: C.businessId } });
    const edgeCountBefore = await prisma.memoryEdge.count({ where: { businessId: C.businessId } });

    const again = await mirrorPlanToGraph(C, routeId, NOW);
    expect(again.outcomeNodeIds).toEqual(mirror.outcomeNodeIds);

    const nodeCountAfter = await prisma.memoryNode.count({ where: { businessId: C.businessId } });
    const edgeCountAfter = await prisma.memoryEdge.count({ where: { businessId: C.businessId } });
    expect(nodeCountAfter).toBe(nodeCountBefore); // no duplicate outcome node
    expect(edgeCountAfter).toBe(edgeCountBefore); // no duplicate caused edge
  });

  it("creates NO outcome node for an EXECUTED-but-UNVERIFIED action (locks the verifiedAt half of the gate)", async () => {
    // Drive a fresh action through the REAL lifecycle all the way to "executed" but leave
    // verifiedAt null (completeExecution does NOT set it). The status half of the honesty gate
    // now passes; the verifiedAt half must INDEPENDENTLY block the outcome node. Mutation
    // intuition: drop `&& action.verifiedAt` from the gate and this test goes RED — an
    // executed-but-unverified send would wrongly earn an outcome node claiming it went live.
    const { actionId: unverifiedActionId } = await upsertRouteAction(C, { waypointId: wpId, employeeRole: "cmo", type: "post", rationale: "executed, not yet verified" });
    const { assetId } = await persistAsset(C, { channel: "instagram", kind: "post", content: { caption: "pending" }, routeActionId: unverifiedActionId });
    await setActionAsset(C, unverifiedActionId, assetId);
    await approveAction(C, { routeActionId: unverifiedActionId, principal: "founder" });
    await startExecution(C, { routeActionId: unverifiedActionId, runId: "run_unverified" });
    await completeExecution(C, { routeActionId: unverifiedActionId });
    // NB: verifiedAt intentionally left null — the send has NOT been verified live.

    const result = await mirrorPlanToGraph(C, routeId, NOW);

    // No outcome node is keyed to this executed-but-unverified action (type disambiguates from its action node).
    const outcome = await prisma.memoryNode.findFirst({ where: { businessId: C.businessId, type: "outcome", sourceId: unverifiedActionId } });
    expect(outcome).toBeNull();
    // ...and the mirror result surfaces no outcome node for it either.
    const outcomeNodes = await Promise.all(result.outcomeNodeIds.map((id) => prisma.memoryNode.findUnique({ where: { id } })));
    expect(outcomeNodes.some((n) => n?.sourceId === unverifiedActionId)).toBe(false);
  });

  it("titles the outcome with the action type when the executed+verified action has no bound asset (channel fallback)", async () => {
    // Path B: approveAction requires a bound asset for the content-hash check, so an asset-less
    // action cannot be driven through the lifecycle. Instead bind an asset, execute + verify,
    // then null out assetId BEFORE mirroring so the outcome channel resolves via the fallback
    // (action.type) rather than a bound asset's channel.
    const { actionId: fallbackActionId } = await upsertRouteAction(C, { waypointId: wpId, employeeRole: "cmo", type: "email", rationale: "verified, asset detached" });
    const { assetId } = await persistAsset(C, { channel: "instagram", kind: "post", content: { caption: "live" }, routeActionId: fallbackActionId });
    await setActionAsset(C, fallbackActionId, assetId);
    await approveAction(C, { routeActionId: fallbackActionId, principal: "founder" });
    await startExecution(C, { routeActionId: fallbackActionId, runId: "run_fallback" });
    await completeExecution(C, { routeActionId: fallbackActionId });
    // The verified-live fact, and detach the asset so channel must fall back to action.type ("email"), not "instagram".
    await prisma.routeAction.update({ where: { id: fallbackActionId }, data: { verifiedAt: NOW, postedUrl: POSTED_URL, assetId: null } });

    await mirrorPlanToGraph(C, routeId, NOW);

    const outcome = await prisma.memoryNode.findFirst({ where: { businessId: C.businessId, type: "outcome", sourceId: fallbackActionId } });
    expect(outcome).not.toBeNull();
    expect(outcome?.title).toBe("went live on email"); // fallback to action.type when no bound asset resolves
    expect(outcome?.body).toBe(POSTED_URL); // still the verified-live URL, not a fabricated metric
  });
});

describe("buildAgentContext — plan-anchored causal recall (pure scoped read, budget-capped)", () => {
  const A = { businessId: "biz_agentctx_a" };
  const B = { businessId: "biz_agentctx_b" };
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const POSTED_URL = "https://instagram.com/p/agentctx777";

  let routeId: string;
  let wp1: string;
  let wp2: string;
  let executedActionId: string;
  let proposedActionId: string;
  let emptyRouteId: string;
  let midRouteId: string;
  let midWp2: string;

  beforeAll(async () => {
    for (const id of [A.businessId, B.businessId]) {
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
      await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
      await prisma.memoryNode.deleteMany({ where: { businessId: id } });
    }

    // Route with 2 waypoints; the ACTIONS live on the LAST waypoint (the default anchor), so the
    // default-anchor neighborhood is non-empty and its outcome is recalled.
    const { objectiveId } = await createObjective(A, { kind: "growth", target: "1k signups", metric: "signups" });
    ({ routeId } = await persistRoute(A, { objectiveId, source: "composed" }));
    ({ waypointId: wp1 } = await persistWaypoint(A, { routeId, order: 1, title: "WP One", goal: "Goal one" }));
    ({ waypointId: wp2 } = await persistWaypoint(A, { routeId, order: 2, title: "WP Two", goal: "Goal two" }));
    // Executed action created FIRST (leads createdAt order → it + its outcome lead the neighborhood),
    // proposed action SECOND (no outcome).
    ({ actionId: executedActionId } = await upsertRouteAction(A, { waypointId: wp2, employeeRole: "cmo", type: "post", rationale: "ship it" }));
    ({ actionId: proposedActionId } = await upsertRouteAction(A, { waypointId: wp2, employeeRole: "cto", type: "build", rationale: "later" }));

    // Drive the executed action to a REAL verified send (asset channel=instagram → one outcome node).
    const { assetId } = await persistAsset(A, { channel: "instagram", kind: "post", content: { caption: "hi" }, routeActionId: executedActionId });
    await setActionAsset(A, executedActionId, assetId);
    await approveAction(A, { routeActionId: executedActionId, principal: "founder" });
    await startExecution(A, { routeActionId: executedActionId, runId: "run_ac_1" });
    await completeExecution(A, { routeActionId: executedActionId });
    await prisma.routeAction.update({ where: { id: executedActionId }, data: { verifiedAt: NOW, postedUrl: POSTED_URL } });

    // Mirror once (the WRITE). buildAgentContext then only READS this graph.
    await mirrorPlanToGraph(A, routeId, NOW);

    // A SECOND route in the SAME business, never mirrored — the degrade-to-empty case. Its presence
    // also proves route-scoping: the main route's mirror nodes must NOT leak into this route's read.
    const { objectiveId: emptyObj } = await createObjective(A, { kind: "growth", target: "later", metric: "signups" });
    ({ routeId: emptyRouteId } = await persistRoute(A, { objectiveId: emptyObj, source: "composed" }));
    await persistWaypoint(A, { routeId: emptyRouteId, order: 1, title: "Unmirrored", goal: "No graph yet" });

    // A THIRD route in business A with 3 ordered waypoints — the MID-SPINE waypointId-anchor case
    // (Task 4's draftWaypoint passes an explicit in-route waypointId). Distinctive actions live on BOTH
    // the mid waypoint (the anchor under test) and the last one, so the anchor's neighborhood can be
    // proven to be the MID one's, not the (default) last's.
    const { objectiveId: midObj } = await createObjective(A, { kind: "growth", target: "mid-spine", metric: "signups" });
    ({ routeId: midRouteId } = await persistRoute(A, { objectiveId: midObj, source: "composed" }));
    await persistWaypoint(A, { routeId: midRouteId, order: 1, title: "Mid WP One", goal: "Mid goal one" });
    ({ waypointId: midWp2 } = await persistWaypoint(A, { routeId: midRouteId, order: 2, title: "Mid WP Two", goal: "Mid goal two" }));
    const { waypointId: midWp3 } = await persistWaypoint(A, { routeId: midRouteId, order: 3, title: "Mid WP Three", goal: "Mid goal three" });
    await upsertRouteAction(A, { waypointId: midWp2, employeeRole: "cmo", type: "post", rationale: "mid-anchor action" });
    await upsertRouteAction(A, { waypointId: midWp3, employeeRole: "cto", type: "build", rationale: "last-wp action" });
    await mirrorPlanToGraph(A, midRouteId, NOW);
  });

  it("reconstructs the ancestorPath in next-spine (RouteWaypoint.order) order, up to & incl. the anchor", async () => {
    const ctx = await buildAgentContext(A, { routeId });
    expect(ctx.ancestorPath).toHaveLength(2);
    expect(ctx.ancestorPath[0]).toEqual({ title: "WP One", goal: "Goal one" });
    expect(ctx.ancestorPath[1]).toEqual({ title: "WP Two", goal: "Goal two" });
  });

  it("neighborhood around the default (last) anchor includes its action node(s) AND the executed action's outcome", async () => {
    const ctx = await buildAgentContext(A, { routeId });
    const kinds = ctx.neighborhood.map((n) => n.kind);
    expect(kinds).toContain("action");
    expect(kinds).toContain("outcome"); // the executed+verified action's caused outcome is recalled
    const outcome = ctx.neighborhood.find((n) => n.kind === "outcome");
    expect(outcome?.title).toBe("went live on instagram");
    expect(outcome?.detail).toBe(POSTED_URL);
  });

  it("text is a non-empty, bounded rendering that references the waypoint goals and marks the current anchor", async () => {
    const ctx = await buildAgentContext(A, { routeId });
    expect(ctx.text.length).toBeGreaterThan(0);
    expect(ctx.text).toContain("Goal one");
    expect(ctx.text).toContain("Goal two");
    expect(ctx.text).toMatch(/current/i); // the anchor waypoint is marked "(current)"
  });

  it("maxItems is load-bearing: cap 1 yields ONE neighborhood item and a strictly shorter text than uncapped", async () => {
    const capped = await buildAgentContext(A, { routeId }, { maxItems: 1 });
    const uncapped = await buildAgentContext(A, { routeId }); // default 12
    expect(capped.neighborhood).toHaveLength(1);
    expect(uncapped.neighborhood.length).toBeGreaterThan(1); // action(s) + outcome
    // The cap drops the outcome "Done:" line, so the rendered text is strictly shorter — the cap
    // bounds BOTH the item list and the prompt text.
    expect(capped.text.length).toBeLessThan(uncapped.text.length);
  });

  it("learnings is empty at 5b (no `learning` nodes yet) — forward-compatible", async () => {
    const ctx = await buildAgentContext(A, { routeId, role: "cmo" });
    expect(ctx.learnings).toEqual([]);
  });

  it("degrades to an all-empty context (no throw) for a route that exists but was never mirrored", async () => {
    const ctx = await buildAgentContext(A, { routeId: emptyRouteId });
    expect(ctx).toEqual({ ancestorPath: [], neighborhood: [], learnings: [], text: "" });
  });

  it("mid-spine waypointId anchor: truncates ancestorPath at the anchor and recalls THAT waypoint's neighborhood (not the last's)", async () => {
    const ctx = await buildAgentContext(A, { routeId: midRouteId, waypointId: midWp2 });

    // ancestorPath = head → anchor (WP2) inclusive = slice(0, anchorIndex+1) with anchorIndex 1 → length 2,
    // in spine order (WP1 then WP2) — NOT the full 3. WP3 (after the anchor) is truncated away.
    expect(ctx.ancestorPath).toHaveLength(2);
    expect(ctx.ancestorPath[0]).toEqual({ title: "Mid WP One", goal: "Mid goal one" });
    expect(ctx.ancestorPath[1]).toEqual({ title: "Mid WP Two", goal: "Mid goal two" });
    expect(ctx.ancestorPath.map((w) => w.title)).not.toContain("Mid WP Three");

    // The anchor (WP2) is the LAST / current entry — the "(current)" marker sits on WP2's line, and WP3
    // is not rendered at all (it is past the anchor).
    expect(ctx.text).toContain("Mid WP Two (current)");
    expect(ctx.text).not.toContain("Mid WP Three");

    // Neighborhood reflects the ANCHOR waypoint's action (mid), not the last waypoint's.
    const details = ctx.neighborhood.map((n) => n.detail);
    expect(details).toContain("mid-anchor action");
    expect(details).not.toContain("last-wp action");
  });

  it("rejects a cross-tenant routeId (route not in the caller's business)", async () => {
    await expect(buildAgentContext(B, { routeId })).rejects.toThrow(/not found|scope/i);
  });
});

describe("buildAgentContext learnings (5c)", () => {
  const L = { businessId: "biz_agentctx_learn" };
  const NOW = new Date("2026-07-11T00:00:00.000Z");
  let learnRouteId: string;
  let learnWpId: string;

  beforeAll(async () => {
    await prisma.business.upsert({ where: { id: L.businessId }, create: { id: L.businessId, name: L.businessId }, update: {} });
    await prisma.memoryEdge.deleteMany({ where: { businessId: L.businessId } });
    await prisma.memoryNode.deleteMany({ where: { businessId: L.businessId } });

    // A mirrored one-waypoint route so ancestorPath is non-empty.
    const { objectiveId } = await createObjective(L, { kind: "growth", target: "1k signups", metric: "signups" });
    ({ routeId: learnRouteId } = await persistRoute(L, { objectiveId, source: "composed" }));
    ({ waypointId: learnWpId } = await persistWaypoint(L, { routeId: learnRouteId, order: 1, title: "WP", goal: "Ship" }));
    await mirrorPlanToGraph(L, learnRouteId, NOW);

    // A copywriter belief that FLIPS positive→negative (so a superseded snapshot exists) + a strategist belief.
    await persistCraftBelief(L, { role: "copywriter", featureKey: "channel=linkedin", belief: { confidence: 0.8, stance: "positive", lowConfidence: false, summary: "Tends to approve these drafts with little editing (5 accepted as-is, 0 rejected)." } });
    await persistCraftBelief(L, { role: "copywriter", featureKey: "channel=linkedin", belief: { confidence: 0.6, stance: "negative", lowConfidence: false, summary: "Tends to reject these drafts (0 accepted as-is, 4 rejected)." } });
    await persistCraftBelief(L, { role: "strategist", featureKey: "channel=x", belief: { confidence: 0.9, stance: "positive", lowConfidence: false, summary: "strategist craft" } });
  });

  it("surfaces role-scoped live beliefs as labeled hypotheses, excludes superseded, never a metric", async () => {
    const ctx = await buildAgentContext(L, { routeId: learnRouteId, waypointId: learnWpId, role: "copywriter" });
    expect(ctx.learnings).toHaveLength(1); // only the LIVE (negative) copywriter belief — snapshot + strategist excluded
    expect(ctx.learnings[0]?.body).toContain("reject");
    expect(ctx.text.toLowerCase()).toContain("learned"); // labeled hypotheses heading
    expect(ctx.text).not.toMatch(/%|percent|conversion|engagement|impressions/i);
  });

  it("keeps learnings empty for a role with no beliefs (forward-compatible, no throw)", async () => {
    const ctx = await buildAgentContext(L, { routeId: learnRouteId, waypointId: learnWpId, role: "nonexistent-role" });
    expect(ctx.learnings).toEqual([]);
  });
});
