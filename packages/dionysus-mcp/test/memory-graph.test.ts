import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { persistMemoryNode, persistMemoryEdge } from "../src/tools/memory-graph.js";

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
