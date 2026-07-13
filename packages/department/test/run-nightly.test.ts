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

  it("the strategy section runs and skips for a young/healthy plan — never-auto, only stalled plans get revised", async () => {
    // The standard fixture (Alpha Co) is fresh with no stalled verdict → analyzeRouteForRevision
    // returns null → strategy reports skipped. (The stalled-path proposal is the T6 eval gate's job.)
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.strategy).toBeDefined();
    expect(res.strategy.status).toBe("skipped");
  });

  it("the cro section skips on a young/healthy plan — it runs only on the measured-flat traffic-without-conversion signal", async () => {
    // The standard fixture (Alpha Co) has no connected source / snapshots, so the CMO verdict is
    // unmeasured (never measured-flat) → the cro section skips WITHOUT a page fetch or model call.
    // (The measured-flat trigger path — the page may be the leak — is the T4 eval gate's job.)
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.cro).toBeDefined();
    expect(res.cro).toMatchObject({ status: "skipped", reason: "no traffic-without-conversion signal" });
  });

  it("the outreach section skips (honestly) when the founder has queued no pitch requests", async () => {
    // The standard fixture (Alpha Co) has ZERO founder pitch requests → runOutreach's pending-check
    // returns skipped BEFORE any budget/fetch/model call. Founder-targeted only: with no request,
    // Dionysus never invents a target. (The drafting path — a readable, grounded target — is the T4 gate's job.)
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.outreach).toBeDefined();
    expect(res.outreach).toMatchObject({ status: "skipped", reason: "no pitch requests pending" });
  });
});

// ── Stage 6f: the nightly PLAN section (bootstrap the first route) ────────────
const BOOT = { businessId: "biz_nightly_boot" };
const STANDING = { businessId: "biz_nightly_standing" };
const NOCASE = { businessId: "biz_nightly_nocase" };

async function resetPlanBiz(businessId: string, name: string) {
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.case.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name, maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000, name } });
}

// Seed a discovered Case via raw prisma with exactly the columns proposeRoute reads
// (name/platform/mode/historicalArcJson/modernizedPlanJson/insight) plus rank (the
// nightly orders by it — the historian ranks 1 = most relevant, so rank asc = best
// first) and the two required-but-unread columns the schema demands (sourcesJson/confidence).
async function seedCase(businessId: string, rank: number, name: string) {
  return prisma.case.create({ data: {
    businessId, name, platform: "hackernews", mode: "launch-led", rank,
    historicalArcJson: JSON.stringify([{ when: "2020", beat: "Show HN" }]),
    modernizedPlanJson: JSON.stringify({ steps: ["Show HN"] }),
    insight: "Authenticity wins", sourcesJson: JSON.stringify([]), confidence: 0.7 } });
}

// A harness that ALSO answers the route-strategist call (its context contains
// "Chosen case:") with a schema-valid RouteProposal, keeps the radar/draft branches,
// and records every input so a test can prove a call did (or did NOT) happen.
function bootstrapHarness(): { harness: Harness; inputs: string[] } {
  const inputs: string[] = [];
  const harness: Harness = {
    async runAgent(_def: AgentDef, input: string) {
      inputs.push(input);
      if (input.includes("Chosen case:")) {
        return { finalOutput: JSON.stringify({ waypoints: [
          { title: "Launch on HN", goal: "First signups toward the goal",
            actions: [{ employeeRole: "copywriter", type: "post", rationale: "authentic Show HN post", features: { channel: "hackernews" } }] },
        ] }) };
      }
      if (input.includes("Action: draft")) {
        return { finalOutput: JSON.stringify({ channel: "hackernews", kind: "post", content: { title: "T", body: "b" } }) };
      }
      return { finalOutput: JSON.stringify({ observations: [{ title: "Devtool wave", body: "b", sourceUrl: SIGNAL_URL, relevance: 8, confidence: 0.6 }] }) };
    },
    async completeOnce() { return "unused"; },
  };
  return { harness, inputs };
}

describe("runNightly — plan section (stage 6f bootstrap)", () => {
  it("BOOTSTRAP: objective + a discovered Case + NO route → proposes the first route from the BEST case (never-auto), no duplicate objective", async () => {
    await resetPlanBiz(BOOT.businessId, "Boot Co");
    const objective = await prisma.objective.create({ data: { businessId: BOOT.businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
    // Two cases: the nightly must pick the BEST (rank 1), not merely the first inserted.
    await seedCase(BOOT.businessId, 2, "Runner-up");
    const best = await seedCase(BOOT.businessId, 1, "Best Case");

    const { harness } = bootstrapHarness();
    const res = await runNightly(BOOT, { harness, models: { brain: "fake" }, hnTransport });

    expect(res.plan.status).toBe("ok");
    // A route now exists, grounded in the rank-1 case, with a waypoint + proposed actions.
    const routes = await prisma.route.findMany({ where: { businessId: BOOT.businessId } });
    expect(routes).toHaveLength(1);
    expect(routes[0]!.caseRef).toBe(best.id);                    // the BEST case (rank asc), not the runner-up
    expect(routes[0]!.objectiveId).toBe(objective.id);           // hangs off the founder-stated objective
    expect(await prisma.routeWaypoint.count({ where: { businessId: BOOT.businessId } })).toBeGreaterThanOrEqual(1);
    const actions = await prisma.routeAction.findMany({ where: { businessId: BOOT.businessId } });
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.every((a) => a.status === "proposed")).toBe(true); // never-auto
    // No duplicate objective — the nightly reused the founder-stated row.
    expect(await prisma.objective.count({ where: { businessId: BOOT.businessId } })).toBe(1);
  });

  it("ONE-STANDING: a business that already has a route → plan skips (the bootstrap fires once; re-planning is the Growth Analyst's job)", async () => {
    await seedBusiness(STANDING.businessId, "Standing Co"); // objective + route + waypoint
    const { harness, inputs } = bootstrapHarness();
    const res = await runNightly(STANDING, { harness, models: { brain: "fake" }, hnTransport });
    expect(res.plan).toMatchObject({ status: "skipped", reason: expect.stringContaining("already exists") });
    expect(inputs.some((i) => i.includes("Chosen case:"))).toBe(false); // short-circuited before the model
  });

  it("NO-CASES: objective + no route + no discovered cases → plan skips honestly with ZERO route-strategist calls, zero routes", async () => {
    await resetPlanBiz(NOCASE.businessId, "No Case Co");
    await prisma.objective.create({ data: { businessId: NOCASE.businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
    const { harness, inputs } = bootstrapHarness();
    const res = await runNightly(NOCASE, { harness, models: { brain: "fake" }, hnTransport });
    expect(res.plan).toMatchObject({ status: "skipped", reason: expect.stringContaining("no discovered cases") });
    expect(await prisma.route.count({ where: { businessId: NOCASE.businessId } })).toBe(0);
    expect(inputs.some((i) => i.includes("Chosen case:"))).toBe(false); // the honest skip made no model call
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
