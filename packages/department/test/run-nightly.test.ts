import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "dionysus-mcp/db";
import type { Harness, AgentDef } from "../src/llm/types.js";
import { runNightly, runNightlySweep } from "../src/run-nightly.js";
import type { HnTransport } from "../src/tools/hn-source.js";

const A = { businessId: "biz_nightly_a" };
const B = { businessId: "biz_nightly_b" };

async function wipe(businessId: string) {
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

async function seedBusiness(businessId: string, name: string) {
  await wipe(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name, maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000, name } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
}

// One grounded HN signal; the fake model cites it with high relevance.
const SIGNAL_URL = "https://news.ycombinator.com/item?id=42";
const hnTransport: HnTransport = async () => ({ status: 200,
  body: JSON.stringify({ hits: [{ title: "Devtool wave", objectID: "42", points: 120 }] }) });
// Dual-purpose fake: radar calls get an OBSERVATIONS payload; the nightly's drafts
// section (draftWaypoint) sends an "Action: draft ..." instruction — answer THOSE with a
// schema-valid draft ({channel, kind, content:{title, body}}) so the briefing can bind an asset.
const goodHarness = (): Harness => ({
  async runAgent(_def: AgentDef, input: string) {
    if (input.includes("Action: draft")) {
      return { finalOutput: JSON.stringify({ channel: "hackernews", kind: "post", content: { title: "T", body: "b" } }) };
    }
    return { finalOutput: JSON.stringify({ observations: [{ title: "Devtool wave", body: "b", sourceUrl: SIGNAL_URL, relevance: 8, confidence: 0.6 }] }) };
  },
});
const throwingHarness = (): Harness => ({ async runAgent() { throw new Error("model down"); } });

describe("runNightly", () => {
  beforeEach(async () => { await seedBusiness(A.businessId, "Alpha Co"); await seedBusiness(B.businessId, "Beta Co"); });

  it("runs radar for a business with an objective and records real observations + proposals", async () => {
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.radar.status).toBe("ok");
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(1);
    // Radar proposed exactly one action (the high-relevance observation). The nightly's learn
    // section now ALSO proposes a recommender action, so scope this count to radar's own proposal.
    expect(await prisma.routeAction.count({ where: { businessId: A.businessId, status: "proposed", featuresJson: { contains: '"radar":true' } } })).toBe(1);
  });

  it("skips radar (honestly) when the business has no objective; metrics skips when no source is connected", async () => {
    await wipe(A.businessId); // leaves the Business row, removes objective/route
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.radar.status).toBe("skipped");
    expect(res.metrics.status).toBe("skipped");
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId } })).toBe(0);
  });

  it("a radar failure is caught per business — reported failed, nothing persisted, metrics still attempted", async () => {
    const res = await runNightly(A, { harness: throwingHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.radar.status).toBe("failed");
    expect(res.metrics.status).toBe("skipped"); // the independent section still ran
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(0);
  });

  it("morning briefing: the nightly learns, recommends, and DRAFTS — the founder wakes to a reviewable draft", async () => {
    // A has an objective + active waypoint (seedBusiness) and NO proposed actions yet.
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.learn.status).toBe("ok");
    expect(res.drafts.status).toBe("ok");
    // The recommender proposed (recommender:true) AND the night drafted it: asset bound.
    const recommended = await prisma.routeAction.findFirst({
      where: { businessId: A.businessId, featuresJson: { contains: '"recommender":true' } } });
    expect(recommended).not.toBeNull();
    expect(recommended?.status).toBe("proposed"); // never-auto — still needs the founder
    expect(recommended?.assetId).not.toBeNull(); // but ALREADY DRAFTED → visible on /drafts
  });

  it("the drafts section reports skipped when there is nothing undrafted", async () => {
    await prisma.routeAction.deleteMany({ where: { businessId: A.businessId } });
    await prisma.routeWaypoint.updateMany({ where: { businessId: A.businessId }, data: { status: "done" } });
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.learn.status).toBe("skipped"); // no active waypoint → no recommendation
    expect(res.drafts.status).toBe("skipped");
  });
});

describe("runNightlySweep", () => {
  beforeEach(async () => { await seedBusiness(A.businessId, "Alpha Co"); await seedBusiness(B.businessId, "Beta Co"); });

  it("isolates failures: one business's broken night never blocks the next business", async () => {
    // A's budget is exhausted (runRadar throws fail-closed); B is healthy.
    await prisma.business.update({ where: { id: A.businessId }, data: { maxTokensPerDay: 0 } });
    const results = await runNightlySweep({ harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    const a = results.find((r) => r.businessId === A.businessId)!;
    const b = results.find((r) => r.businessId === B.businessId)!;
    expect(a.radar.status).toBe("failed"); // budget fail-closed, caught
    expect(b.radar.status).toBe("ok"); // the sweep continued
    expect(await prisma.memoryNode.count({ where: { businessId: B.businessId, type: "market-observation" } })).toBe(1);
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(0);
  });
});
