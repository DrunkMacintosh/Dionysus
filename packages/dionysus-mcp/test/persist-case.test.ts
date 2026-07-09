import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { persistCase } from "../src/tools/persist-case.js";

describe("persistCase", () => {
  beforeAll(async () => {
    await prisma.case.deleteMany({ where: { businessId: "biz_case" } });
    await prisma.business.upsert({ where: { id: "biz_case" },
      create: { id: "biz_case", name: "Case Co" }, update: {} });
  });

  it("persists a scoped Case with JSON payloads", async () => {
    const out = await persistCase({ businessId: "biz_case" }, {
      name: "Notion", platform: "producthunt", mode: "community-led", rank: 1,
      historicalArc: [{ year: 2019, beat: "PH launch" }],
      modernizedPlan: { steps: ["a"] },
      insight: "Community first.",
      sources: [{ url: "https://example.com/a", kind: "EXTRACTED" }],
      confidence: 0.8,
    });
    const row = await prisma.case.findUnique({ where: { id: out.caseId } });
    expect(row?.businessId).toBe("biz_case");
    expect(JSON.parse(row!.historicalArcJson)[0].beat).toBe("PH launch");
    expect(row?.rank).toBe(1);
  });
});
