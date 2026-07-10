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
