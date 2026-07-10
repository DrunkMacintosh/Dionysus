import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

const BIZ = "biz_mem";

describe("MemoryNode schema", () => {
  beforeAll(async () => {
    await prisma.memoryNode.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "MEM" }, update: {} });
  });

  it("persists a market-observation node with taint + source + confidence", async () => {
    const row = await prisma.memoryNode.create({ data: {
      businessId: BIZ, type: "market-observation",
      title: "Show HN: rival launched X", body: "A competitor shipped X to strong reception.",
      confidence: 0.55, sourceUrl: "https://news.ycombinator.com/item?id=1", tainted: true } });
    expect(row.type).toBe("market-observation");
    expect(row.tainted).toBe(true);
    expect(row.sourceUrl).toBe("https://news.ycombinator.com/item?id=1");
    expect(row.confidence).toBeCloseTo(0.55);
    expect(row.role).toBeNull();
    expect(row.waypointId).toBeNull();
  });

  it("tainted defaults to false when unset", async () => {
    const row = await prisma.memoryNode.create({ data: {
      businessId: BIZ, type: "learning", title: "t", body: "b", confidence: 0.5 } });
    expect(row.tainted).toBe(false);
  });
});
