import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { persistMemoryNode, persistMemoryEdge, mirrorPlanToGraph } from "../src/tools/memory-graph.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";

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
