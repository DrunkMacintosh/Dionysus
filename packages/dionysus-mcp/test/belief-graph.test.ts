import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { persistCraftBelief } from "../src/tools/belief-graph.js";
import type { CraftBelief } from "../src/lib/belief.js";

const BIZ = "biz-belief-a";
const OTHER = "biz-belief-b";

// Business needs only { id, name }. Wipe child rows scoped to the two tenants
// (FK order: edges/nodes/actions/waypoints/routes/objectives) then upsert the business.
async function resetBusinesses() {
  for (const id of [BIZ, OTHER]) {
    await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
    await prisma.memoryNode.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
}

const positive: CraftBelief = { confidence: 0.7, stance: "positive", lowConfidence: false, summary: "Tends to approve (5 as-is, 0 rejected)." };
const negative: CraftBelief = { confidence: 0.6, stance: "negative", lowConfidence: false, summary: "Tends to reject (0 as-is, 4 rejected)." };

describe("persistCraftBelief", () => {
  beforeEach(resetBusinesses);

  it("creates one live learning node keyed by role::featureKey, tainted false", async () => {
    const { beliefNodeId, superseded } = await persistCraftBelief(
      { businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    expect(superseded).toBe(false);
    const node = await prisma.memoryNode.findUnique({ where: { id: beliefNodeId } });
    expect(node?.type).toBe("learning");
    expect(node?.role).toBe("copywriter");
    expect(node?.sourceId).toBe("copywriter::channel=linkedin");
    expect(node?.stance).toBe("positive");
    expect(node?.confidence).toBeCloseTo(0.7);
    expect(node?.tainted).toBe(false);
  });

  it("updates the live node in place on corroboration (same stance) — zero new rows", async () => {
    const first = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const stronger: CraftBelief = { ...positive, confidence: 0.85, summary: "Tends to approve (8 as-is, 0 rejected)." };
    const second = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: stronger });

    expect(second.beliefNodeId).toBe(first.beliefNodeId);
    expect(second.superseded).toBe(false);
    const learningNodes = await prisma.memoryNode.findMany({ where: { businessId: BIZ, type: "learning" } });
    expect(learningNodes).toHaveLength(1);
    expect(learningNodes[0]?.confidence).toBeCloseTo(0.85);
    expect(learningNodes[0]?.body).toContain("8 as-is");
  });

  it("snapshots + supersedes when the stance flips positive→negative", async () => {
    const first = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const flipped = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: negative });

    expect(flipped.beliefNodeId).toBe(first.beliefNodeId);
    expect(flipped.superseded).toBe(true);
    const live = await prisma.memoryNode.findUnique({ where: { id: flipped.beliefNodeId } });
    expect(live?.stance).toBe("negative");

    const snapshot = await prisma.memoryNode.findFirst({ where: { businessId: BIZ, type: "learning", sourceId: "copywriter::channel=linkedin::superseded::0" } });
    expect(snapshot?.stance).toBe("positive");
    const edge = await prisma.memoryEdge.findFirst({ where: { businessId: BIZ, kind: "supersedes", fromId: flipped.beliefNodeId, toId: snapshot?.id } });
    expect(edge).not.toBeNull();
  });

  it("scopes to the caller's business — the same key in another tenant is a separate node", async () => {
    const a = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const b = await persistCraftBelief({ businessId: OTHER }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    expect(b.beliefNodeId).not.toBe(a.beliefNodeId);
    const aNodes = await prisma.memoryNode.findMany({ where: { businessId: BIZ, type: "learning" } });
    const bNodes = await prisma.memoryNode.findMany({ where: { businessId: OTHER, type: "learning" } });
    expect(aNodes).toHaveLength(1);
    expect(bNodes).toHaveLength(1);
  });
});
