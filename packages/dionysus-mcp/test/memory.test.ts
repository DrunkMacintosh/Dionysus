import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { recordObservation, listObservations } from "../src/tools/memory.js";

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

describe("recordObservation / listObservations (identity-scoped)", () => {
  const B = "biz_mem2";
  beforeAll(async () => {
    await prisma.memoryNode.deleteMany({ where: { businessId: B } });
    await prisma.memoryNode.deleteMany({ where: { businessId: "biz_mem_other" } });
    await prisma.business.upsert({ where: { id: B }, create: { id: B, name: "M2" }, update: {} });
    await prisma.business.upsert({ where: { id: "biz_mem_other" }, create: { id: "biz_mem_other", name: "MO" }, update: {} });
  });

  it("records a tainted, sourced observation and lists it scoped, newest-first", async () => {
    await recordObservation({ businessId: B }, { title: "older", body: "b1", sourceUrl: "https://a.test/1", confidence: 0.4 });
    const { nodeId } = await recordObservation({ businessId: B }, { title: "newer", body: "b2", sourceUrl: "https://a.test/2", confidence: 0.6 });
    const row = await prisma.memoryNode.findUnique({ where: { id: nodeId } });
    expect(row?.tainted).toBe(true);
    expect(row?.type).toBe("market-observation");
    const list = await listObservations({ businessId: B });
    expect(list[0]!.title).toBe("newer"); // newest first
    expect(list.map((o) => o.sourceUrl)).toContain("https://a.test/1");
  });

  it("refuses an empty/whitespace source URL (§6.2 — no unsourced observation)", async () => {
    await expect(recordObservation({ businessId: B }, { title: "x", body: "y", sourceUrl: "  ", confidence: 0.5 }))
      .rejects.toThrow(/source/i);
  });

  it("refuses out-of-range confidence", async () => {
    await expect(recordObservation({ businessId: B }, { title: "x", body: "y", sourceUrl: "https://a.test/3", confidence: 2 }))
      .rejects.toThrow(/confidence/i);
  });

  it("another tenant sees none of B's observations", async () => {
    expect(await listObservations({ businessId: "biz_mem_other" })).toHaveLength(0);
  });
});
