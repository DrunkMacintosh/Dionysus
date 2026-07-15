// §15 stage-6b eval gate — the MORNING BRIEFING (learn → recommend → draft) is
// (1) MEASURED-ONLY PERFORMANCE (a performance belief exists ONLY when a real analytics
// source is connected AND real snapshots bracket real sends; the body reports DIRECTION +
// COUNTS, never a metric word / %), (2) NEVER-AUTO END-TO-END (a full nightly proposes and
// DRAFTS but every row stays `proposed`/`executed` — nothing approves or sends), (3) EDIT-
// SACRED (a proposed action that already carries a founder-bound asset is NEVER re-drafted —
// its assetId is byte-unchanged after the night), (4) DETERMINISTIC (two identically-seeded
// tenants pick the SAME channel — no model call in the recommender), (5) EXPLAINABLE (the
// recommended action's rationale QUOTES the positive belief body it acted on), (6) NON-MCP
// (the whitelist stays 11 — no recommend/derive/draft tool), plus two folded from the T1
// review: (7) BRACKET-GAP (a send with a baseline but NO in-window after-reading contributes
// zero evidence, past the <2-snapshot short-circuit) and (8) PERF SUPERSEDE FLIP (a clearly
// positive belief that turns clearly negative supersedes exactly once and the live node flips).
// Tenants live under biz_morningeval_* so this gate never collides with other suites.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { connectIntegration } from "dionysus-mcp/tools/integration";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";
import { persistCraftBelief } from "dionysus-mcp/tools/belief-graph";
import { derivePerformanceBeliefs, GROWTH_ROLE } from "dionysus-mcp/tools/performance-belief";
import { recommendNextAction } from "dionysus-mcp/tools/recommend";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import type { CraftBelief } from "dionysus-mcp/lib/belief";
import type { MetricTransport } from "dionysus-mcp/tools/analytics";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";
import { runNightly } from "../src/run-nightly.js";

const A = { businessId: "biz_morningeval_a" };
const B = { businessId: "biz_morningeval_b" };

// A fixed clock for the direct-derivation invariants (7/8) — deterministic recency.
const NOW = new Date("2026-07-11T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

// The 5c/5d honesty invariant: a performance belief body NEVER carries a metric word or %.
const METRIC_WORDS = /%|percent|conversion|engagement|impressions|clicks|reach/i;

// One grounded HN signal; the fake model cites it (radar records + proposes). The dual-purpose
// harness (run-nightly.test.ts's goodHarness) answers an "Action: draft ..." instruction with a
// schema-valid draft so the briefing can BIND an asset, and everything else with observations.
const SIGNAL_URL = "https://news.ycombinator.com/item?id=42";
const hnTransport: HnTransport = async () => ({ status: 200,
  body: JSON.stringify({ hits: [{ title: "Devtool wave", objectID: "42", points: 120 }] }) });
const goodHarness = (): Harness => ({
  async runAgent(_def: AgentDef, input: string) {
    if (input.includes("Action: draft")) {
      return { finalOutput: JSON.stringify({ channel: "hackernews", kind: "post", content: { title: "T", body: "B" } }) };
    }
    return { finalOutput: JSON.stringify({ observations: [{ title: "Devtool wave", body: "B", sourceUrl: SIGNAL_URL, relevance: 8, confidence: 0.6 }] }) };
  },
});
// A degraded metric transport: the metrics section reads nothing (ok:false) and fabricates
// nothing, so a full nightly never makes a real network call for these direction-seeded tests.
const noMetric: MetricTransport = async () => ({ ok: false, status: 503, json: async () => ({}) });
const fullDeps = () => ({ harness: goodHarness(), models: { brain: "fake" }, hnTransport, metricTransport: noMetric });

async function wipe(businessId: string) {
  await prisma.nightlyRun.deleteMany({ where: { businessId } }); // 6j: the diary the full nightly writes — cleared for sibling-eval teardown parity
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

// A business with an objective + one ACTIVE waypoint (the attach point the recommender needs).
async function seedBusiness(businessId: string, name: string) {
  await wipe(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name, maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000, name } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
}

// A real VERIFIED send on the seeded waypoint (the unit performance evidence brackets).
async function seedSend(businessId: string, channel: string, verifiedAt: Date) {
  const wp = await prisma.routeWaypoint.findFirst({ where: { businessId } });
  return prisma.routeAction.create({ data: {
    businessId, waypointId: wp!.id, employeeRole: "copywriter", type: "post",
    status: "executed", verifiedAt, featuresJson: JSON.stringify({ channel }) } });
}

async function snap(businessId: string, integrationId: string, value: number, capturedAt: Date) {
  await prisma.metricSnapshot.create({ data: { businessId, integrationId, metric: "signups", value, capturedAt } });
}

async function connectSource(businessId: string): Promise<string> {
  const { integrationId } = await connectIntegration({ businessId },
    { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
  return integrationId;
}

// A send whose 7d window ROSE: baseline reading BEFORE it (100), a higher reading INSIDE (200).
async function seedRoseSend(businessId: string, integrationId: string, d: number) {
  await seedSend(businessId, "hackernews", daysAgo(d));
  await snap(businessId, integrationId, 100, daysAgo(d + 1)); // baseline at/before the send
  await snap(businessId, integrationId, 200, daysAgo(d - 2)); // higher reading in-window after
}
// A send whose 7d window FELL: baseline reading BEFORE it (500), a lower reading INSIDE (100).
async function seedFellSend(businessId: string, integrationId: string, d: number) {
  await seedSend(businessId, "hackernews", daysAgo(d));
  await snap(businessId, integrationId, 500, daysAgo(d + 1));
  await snap(businessId, integrationId, 100, daysAgo(d - 2));
}

// A live craft/performance belief for (role, channel) with an exact body — seeded, not derived,
// so the deterministic recommender's choice and cited rationale are fully controlled.
const belief = (stance: "positive" | "negative", confidence: number, summary: string): CraftBelief =>
  ({ confidence, stance, lowConfidence: false, summary });

describe("§15 stage-6b eval gate — the morning briefing", () => {
  beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });
  beforeEach(async () => { await seedBusiness(A.businessId, "Alpha Co"); await seedBusiness(B.businessId, "Beta Co"); });
  // Leave NO connected analytics source (or other state) in the shared test DB: runNightlySweep
  // in other suites iterates EVERY business with the production metric transport, and a lingering
  // "https://x" source would make it attempt a real (slow) network fetch for our tenants.
  afterAll(async () => { await wipe(A.businessId); await wipe(B.businessId); });

  it("inv1 — MEASURED-ONLY: no connected source forms ZERO growth beliefs; the SAME data WITH a source forms one, correlation-labeled, never a metric word", async () => {
    // Identical data present in BOTH halves — only the connected source differs, so the honesty
    // gate (not missing data) is what's proven. Three hackernews sends whose windows rose.
    for (const d of [20, 14, 8]) await seedRoseSend(A.businessId, "pending", d);

    // Half 1: no analytics source connected → a full nightly performs no performance learning.
    await runNightly(A, fullDeps());
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "learning", role: GROWTH_ROLE } })).toBe(0);

    // Half 2: connect the source; the SAME bracketing snapshots now measure the SAME sends.
    await connectSource(A.businessId);
    await runNightly(A, fullDeps());
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "learning", role: GROWTH_ROLE } })).toBe(1);
    const node = await prisma.memoryNode.findFirst({ where: { businessId: A.businessId, type: "learning", role: GROWTH_ROLE } });
    expect(node?.stance).toBe("positive");
    expect(node?.body).toContain("Correlation"); // correlation, not proven causation
    expect(node?.body).not.toMatch(METRIC_WORDS); // direction + counts only — never a metric word/%
  });

  it("inv2 — NEVER-AUTO END-TO-END: a full nightly proposes + DRAFTS the recommendation, but every row stays proposed/executed — nothing approves or sends", async () => {
    await connectSource(A.businessId);
    for (const d of [20, 14, 8]) await seedRoseSend(A.businessId, "pending", d); // a positive hackernews belief → the recommender EXPLOITS

    await runNightly(A, fullDeps());

    // The recommender proposed AND the drafts section bound an asset — a reviewable draft.
    const rec = await prisma.routeAction.findFirst({
      where: { businessId: A.businessId, featuresJson: { contains: '"recommender":true' } } });
    expect(rec).not.toBeNull();
    expect(rec?.status).toBe("proposed"); // NEVER-AUTO — still needs the founder
    expect(rec?.assetId).not.toBeNull();  // but ALREADY drafted → visible on /drafts
    expect(rec?.approvedAt).toBeNull();   // and NOT approved

    // The whole night never advanced ANY row past the founder gate.
    expect(await prisma.routeAction.count({
      where: { businessId: A.businessId, status: { notIn: ["proposed", "executed"] } } })).toBe(0);
  });

  it("inv3 — EDIT-SACRED: a proposed action that already carries a founder-bound asset is never re-drafted (assetId byte-unchanged after the night)", async () => {
    const wp = await prisma.routeWaypoint.findFirst({ where: { businessId: A.businessId, status: "active" } });
    // A proposed action the founder has already edited-and-rebound (4b) — it carries a bound asset.
    const bound = await prisma.routeAction.create({ data: {
      businessId: A.businessId, waypointId: wp!.id, employeeRole: "copywriter", type: "post",
      status: "proposed", featuresJson: JSON.stringify({ channel: "hackernews" }) } });
    const asset = await prisma.asset.create({ data: {
      businessId: A.businessId, routeActionId: bound.id, channel: "hackernews", kind: "post",
      contentJson: JSON.stringify({ title: "founder edit", body: "sacred" }) } });
    await prisma.routeAction.update({ where: { id: bound.id }, data: { assetId: asset.id } });

    // The night DOES draft (radar + the recommender propose fresh undrafted actions), so the
    // sacred-skip is exercised while drafting is actually happening — not vacuously idle.
    await runNightly(A, fullDeps());

    const after = await prisma.routeAction.findUnique({ where: { id: bound.id } });
    expect(after?.assetId).toBe(asset.id); // byte-equal — the founder's binding survived the nightly
    expect(await prisma.asset.count({ where: { businessId: A.businessId, routeActionId: bound.id } })).toBe(1); // no orphan re-draft
  });

  it("inv4 — DETERMINISTIC: two identically-seeded tenants pick the SAME (evidence-driven) channel — no model call in the recommender", async () => {
    for (const t of [A, B]) {
      // Register x + linkedin as candidates (past sends), then seed identical beliefs.
      await seedSend(t.businessId, "x", daysAgo(3));
      await seedSend(t.businessId, "linkedin", daysAgo(3));
      await persistCraftBelief(t, { role: GROWTH_ROLE, featureKey: "channel=x", belief: belief("positive", 0.6, "number rose after") });
      await persistCraftBelief(t, { role: "copywriter", featureKey: "channel=x", belief: belief("positive", 0.5, "approved as-is") });
      await persistCraftBelief(t, { role: GROWTH_ROLE, featureKey: "channel=linkedin", belief: belief("negative", 0.7, "number fell after") });
    }
    const recA = await recommendNextAction(A);
    const recB = await recommendNextAction(B);
    expect(recA?.channel).toBe("x"); // 0.6*2 + 0.5*1 = 1.7 beats linkedin's -1.4 and hackernews's 0.3 explore
    expect(recB?.channel).toBe(recA?.channel); // deterministic — identical seed ⇒ identical choice
    expect(recA?.channel).not.toBe("hackernews"); // non-vacuous: evidence overrode the default explore channel
  });

  it("inv5 — EXPLAINABLE: the recommended action's rationale quotes the positive belief body it acted on", async () => {
    await seedSend(A.businessId, "x", daysAgo(3)); // register x as a candidate
    await persistCraftBelief(A, { role: GROWTH_ROLE, featureKey: "channel=x",
      belief: belief("positive", 0.6, "your number tended to rise after quokka-marker posts") });

    const rec = await recommendNextAction(A);
    expect(rec?.channel).toBe("x");
    expect(rec?.reason).toContain("quokka-marker"); // the returned reason cites the belief
    const action = await prisma.routeAction.findUnique({ where: { id: rec!.actionId } });
    expect(action?.rationale).toContain("quokka-marker"); // and it is PERSISTED on the proposed action
  });

  it("inv6 — NON-MCP: the whitelist stays exactly 11 with no recommend/derive/draft tool", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    for (const forbidden of ["recommend_next_action", "derive_performance_beliefs", "draft_waypoint"]) {
      expect(toolNames).not.toContain(forbidden);
    }
  });

  it("inv7 — BRACKET-GAP: a send with a baseline but NO in-window after-reading contributes zero evidence (past the <2-snapshot short-circuit)", async () => {
    const integrationId = await connectSource(A.businessId);
    // TWO snapshots exist (so we're PAST the snapshots.length < 2 short-circuit)...
    await snap(A.businessId, integrationId, 100, daysAgo(30));
    await snap(A.businessId, integrationId, 100, daysAgo(25));
    // ...but the send's 7d window (daysAgo(10) → daysAgo(3)) contains NEITHER snapshot: it has a
    // baseline (daysAgo(25) ≤ send) yet no reading strictly after it inside the window.
    await seedSend(A.businessId, "hackernews", daysAgo(10));

    const result = await derivePerformanceBeliefs(A, NOW);
    expect(result.beliefNodeIds).toHaveLength(0); // the per-send skip branch: no invented direction
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "learning", role: GROWTH_ROLE } })).toBe(0);
  });

  it("inv8 — PERF SUPERSEDE FLIP: a clearly-positive belief that turns clearly-negative supersedes exactly once and the live node flips", async () => {
    const integrationId = await connectSource(A.businessId);
    // Epoch 1: three sends whose windows rose → a clearly POSITIVE hackernews belief.
    for (const d of [20, 14, 8]) await seedRoseSend(A.businessId, integrationId, d);
    const first = await derivePerformanceBeliefs(A, NOW);
    expect(first.beliefNodeIds).toHaveLength(1);
    const positive = await prisma.memoryNode.findFirst({
      where: { businessId: A.businessId, type: "learning", sourceId: `${GROWTH_ROLE}::channel=hackernews` } });
    expect(positive?.stance).toBe("positive"); // non-vacuous baseline: the flip really flips something

    // Delete the old sends + snapshots so ONLY fell-evidence is present at the next derive.
    await prisma.routeAction.deleteMany({ where: { businessId: A.businessId } });
    await prisma.metricSnapshot.deleteMany({ where: { businessId: A.businessId } });
    // Epoch 2: four sends whose windows fell (4 fell vs 0 rose → aggregate net = -1 < -0.15).
    for (const d of [20, 16, 12, 8]) await seedFellSend(A.businessId, integrationId, d);

    const second = await derivePerformanceBeliefs(A, NOW);
    expect(second.supersededCount).toBe(1); // exactly one contradiction snapshotted
    const live = await prisma.memoryNode.findFirst({
      where: { businessId: A.businessId, type: "learning", sourceId: `${GROWTH_ROLE}::channel=hackernews` } });
    expect(live?.stance).toBe("negative"); // the live growth-analyst node now reflects the reversed measurement
  });
});
