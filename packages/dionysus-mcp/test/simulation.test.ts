import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { recordSimulation, SIMULATION_ENGINES } from "../src/tools/simulation.js";

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

describe("recordSimulation (identity-scoped)", () => {
  let actionId = "";
  beforeAll(async () => {
    await prisma.business.upsert({ where: { id: "biz_sim2" }, create: { id: "biz_sim2", name: "S2" }, update: {} });
    await prisma.business.upsert({ where: { id: "biz_sim_other" }, create: { id: "biz_sim_other", name: "SO" }, update: {} });
    const obj = await prisma.objective.create({ data: { businessId: "biz_sim2", kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: "biz_sim2", objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: "biz_sim2", routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
    const action = await prisma.routeAction.create({ data: { businessId: "biz_sim2", waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
    actionId = action.id;
  });

  it("records a scoped prediction", async () => {
    const { simulationId } = await recordSimulation({ businessId: "biz_sim2" },
      { routeActionId: actionId, engine: "focus_group", prediction: { verdict: "ship it" }, confidence: 0.7 });
    const row = await prisma.simulationResult.findUnique({ where: { id: simulationId } });
    expect(row?.businessId).toBe("biz_sim2");
    expect(JSON.parse(row!.predictionJson).verdict).toBe("ship it");
  });

  it("rejects a cross-tenant routeActionId, a bad engine, and out-of-range confidence", async () => {
    await expect(recordSimulation({ businessId: "biz_sim_other" },
      { routeActionId: actionId, engine: "focus_group", prediction: {}, confidence: 0.5 }))
      .rejects.toThrow(/not found|scope/i);
    await expect(recordSimulation({ businessId: "biz_sim2" },
      { routeActionId: actionId, engine: "oracle" as never, prediction: {}, confidence: 0.5 }))
      .rejects.toThrow(/invalid simulation engine/i);
    await expect(recordSimulation({ businessId: "biz_sim2" },
      { routeActionId: actionId, engine: "focus_group", prediction: {}, confidence: 1.5 }))
      .rejects.toThrow(/confidence/i);
  });

  it("a simulation NEVER mutates the action (status, binding, hash untouched)", async () => {
    const before = await prisma.routeAction.findUnique({ where: { id: actionId } });
    await recordSimulation({ businessId: "biz_sim2" },
      { routeActionId: actionId, engine: "focus_group", prediction: { verdict: "meh" }, confidence: 0.4 });
    const after = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(after).toEqual(before);
  });
});

