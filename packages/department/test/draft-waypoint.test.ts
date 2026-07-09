import { describe, it, expect, beforeAll } from "vitest";
import { draftWaypoint } from "../src/draft-waypoint.js";
import { prisma } from "dionysus-mcp/db";
import type { Harness, AgentDef } from "../src/llm/types.js";

const IDENTITY = { businessId: "biz_draft" };
let waypointId = "";
let actionIds: string[] = [];

beforeAll(async () => {
  await prisma.asset.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.route.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.objective.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.business.upsert({ where: { id: IDENTITY.businessId },
    create: { id: IDENTITY.businessId, name: "Draft Co", maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 } });
  const obj = await prisma.objective.create({ data: { businessId: IDENTITY.businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: IDENTITY.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: IDENTITY.businessId, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  waypointId = wp.id;
  const a1 = await prisma.routeAction.create({ data: { businessId: IDENTITY.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed", featuresJson: JSON.stringify({ channel: "hackernews" }) } });
  const a2 = await prisma.routeAction.create({ data: { businessId: IDENTITY.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed", featuresJson: JSON.stringify({ channel: "x" }) } });
  actionIds = [a1.id, a2.id];
});

function fakeHarness(): Harness {
  return {
    async runAgent(_def: AgentDef, input: string) {
      const channel = input.includes("hackernews") ? "hackernews" : "x";
      return { finalOutput: JSON.stringify({ channel, kind: "post", content: { title: `T-${channel}`, body: `Draft for ${channel}` } }) };
    },
    async completeOnce() { return "unused"; },
  };
}

describe("draftWaypoint (parallel fan-out)", () => {
  it("drafts one channel-native asset per proposed action, linked + assetId set", async () => {
    const res = await draftWaypoint(IDENTITY, { waypointId }, { harness: fakeHarness(), models: { brain: "fake" } });
    expect(res.drafts).toHaveLength(2);
    const channels = res.drafts.map((d) => d.channel).sort();
    expect(channels).toEqual(["hackernews", "x"]);
    // each asset persisted + linked + action.assetId set
    const assets = await prisma.asset.findMany({ where: { businessId: IDENTITY.businessId } });
    expect(assets).toHaveLength(2);
    for (const id of actionIds) {
      const action = await prisma.routeAction.findUnique({ where: { id } });
      expect(action?.assetId).toBeTruthy();
      const asset = await prisma.asset.findFirst({ where: { routeActionId: id } });
      expect(asset).toBeTruthy();
      expect(JSON.parse(asset!.contentJson).body).toContain("Draft for");
    }
  });

  it("fails closed when the budget is exhausted (before any drafting)", async () => {
    await prisma.business.update({ where: { id: IDENTITY.businessId }, data: { maxTokensPerDay: 0 } });
    await expect(draftWaypoint(IDENTITY, { waypointId }, { harness: fakeHarness(), models: { brain: "fake" } }))
      .rejects.toThrow(/budget/i);
    await prisma.business.update({ where: { id: IDENTITY.businessId }, data: { maxTokensPerDay: 100000 } });
  });

  it("rejects a waypoint from another tenant (fail-closed)", async () => {
    await prisma.business.upsert({ where: { id: "biz_draft_x" }, create: { id: "biz_draft_x", name: "X", maxTokensPerDay: 100000 }, update: {} });
    await expect(draftWaypoint({ businessId: "biz_draft_x" }, { waypointId }, { harness: fakeHarness(), models: { brain: "fake" } }))
      .rejects.toThrow(/waypoint .* not found|scope/i);
  });
});
