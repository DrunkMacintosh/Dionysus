import { describe, it, expect, beforeAll } from "vitest";
import { proposeRoute } from "../src/propose-route.js";
import { prisma } from "dionysus-mcp/db";
import { persistCase } from "dionysus-mcp/tools/persist-case";
import type { Harness, AgentDef } from "../src/llm/types.js";

const IDENTITY = { businessId: "biz_route" };
let caseId = "";

beforeAll(async () => {
  await prisma.routeAction.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.route.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.objective.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.business.upsert({ where: { id: IDENTITY.businessId },
    create: { id: IDENTITY.businessId, name: "Route Co", maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 } });
  const persisted = await persistCase(IDENTITY, {
    name: "Supabase", platform: "hackernews", mode: "launch-led", rank: 1,
    historicalArc: [{ when: "2020", beat: "Show HN" }], modernizedPlan: { steps: ["Show HN"] },
    insight: "Authenticity wins", sources: [{ url: "https://x", kind: "EXTRACTED" }], confidence: 0.7 });
  caseId = persisted.caseId;
});

function fakeHarness(): Harness {
  return {
    async runAgent(_def: AgentDef, _input: string) {
      return { finalOutput: JSON.stringify({ waypoints: [
        { title: "Launch on HN", goal: "First 30 signups toward 100 users",
          actions: [{ employeeRole: "copywriter", type: "post", rationale: "HN rewards authentic Show HN posts", features: { channel: "hackernews" } }] },
        { title: "Follow-up thread", goal: "Next 30 signups",
          actions: [{ employeeRole: "social", type: "reply", rationale: "Engage commenters", features: { channel: "hackernews" } }] },
      ] }) };
    },
    async completeOnce() { return "unused"; },
  };
}

describe("proposeRoute", () => {
  it("creates objective→route→ordered waypoints→proposed actions, grounded in the case", async () => {
    const plan = await proposeRoute(IDENTITY,
      { objective: { kind: "signups", target: "100", metric: "users" }, caseId },
      { harness: fakeHarness(), models: { brain: "fake" } });
    expect(plan.waypoints).toHaveLength(2);
    expect(plan.waypoints[0]!.order).toBe(1);
    expect(plan.waypoints[1]!.order).toBe(2);
    expect(plan.waypoints[0]!.actions[0]!.rationale).toContain("authentic");

    const route = await prisma.route.findUnique({ where: { id: plan.routeId } });
    expect(route?.objectiveId).toBe(plan.objectiveId);
    expect(route?.caseRef).toBe(caseId);            // grounded in the case
    const wp1 = await prisma.routeWaypoint.findFirst({ where: { routeId: plan.routeId, order: 1 } });
    expect(wp1?.status).toBe("active");             // first waypoint active
    const actions = await prisma.routeAction.findMany({ where: { businessId: IDENTITY.businessId } });
    expect(actions.every((a) => a.status === "proposed")).toBe(true);
  });

  it("fails closed when the budget is exhausted", async () => {
    await prisma.business.update({ where: { id: IDENTITY.businessId }, data: { maxTokensPerDay: 0 } });
    await expect(proposeRoute(IDENTITY,
      { objective: { kind: "k", target: "1", metric: "m" }, caseId },
      { harness: fakeHarness(), models: { brain: "fake" } })).rejects.toThrow(/budget/i);
    await prisma.business.update({ where: { id: IDENTITY.businessId }, data: { maxTokensPerDay: 100000 } });
  });

  it("rejects a caseId from another tenant (fail-closed)", async () => {
    await prisma.business.upsert({ where: { id: "biz_route_x" }, create: { id: "biz_route_x", name: "X", maxTokensPerDay: 100000 }, update: {} });
    await expect(proposeRoute({ businessId: "biz_route_x" },
      { objective: { kind: "k", target: "1", metric: "m" }, caseId },
      { harness: fakeHarness(), models: { brain: "fake" } })).rejects.toThrow(/case .* not found|scope/i);
  });

  it("leaves no orphan objective when the model output fails to parse", async () => {
    await prisma.business.upsert({ where: { id: "biz_route_orphan" },
      create: { id: "biz_route_orphan", name: "Orphan Co", maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000 } });
    await prisma.objective.deleteMany({ where: { businessId: "biz_route_orphan" } });
    // Need a case owned by biz_route_orphan (proposeRoute guards case scope before objective):
    const oc = await persistCase({ businessId: "biz_route_orphan" }, { name: "C", platform: "hn", mode: "m", rank: 1, historicalArc: [], modernizedPlan: {}, insight: "i", sources: [], confidence: 0.5 });
    const badHarness: Harness = { async runAgent() { return { finalOutput: "not json at all" }; }, async completeOnce() { return "x"; } };
    await expect(proposeRoute({ businessId: "biz_route_orphan" },
      { objective: { kind: "k", target: "1", metric: "m" }, caseId: oc.caseId },
      { harness: badHarness, models: { brain: "b" } })).rejects.toThrow();
    const objs = await prisma.objective.findMany({ where: { businessId: "biz_route_orphan" } });
    expect(objs).toHaveLength(0); // no orphan
  });
});
