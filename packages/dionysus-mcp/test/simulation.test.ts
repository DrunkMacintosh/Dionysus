import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

const BIZ = "biz_sim";

describe("SimulationResult schema", () => {
  beforeAll(async () => {
    await prisma.simulationResult.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "SIM" }, update: {} });
  });

  it("persists a prediction row with engine, JSON payload, and confidence", async () => {
    const row = await prisma.simulationResult.create({ data: {
      businessId: BIZ, routeActionId: "act_x", engine: "focus_group",
      predictionJson: JSON.stringify({ engagementScore: 7 }), confidence: 0.6 } });
    expect(row.engine).toBe("focus_group");
    expect(JSON.parse(row.predictionJson).engagementScore).toBe(7);
    expect(row.confidence).toBeCloseTo(0.6);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
