// Stage 6c — §15 EVAL GATE for route re-personalization (the Growth Analyst's strategic layer).
//
// This gate pins the load-bearing invariants of the full propose→decide chain end-to-end (mcp):
//   inv1 NEVER-AUTO      — analyze proposes; ONLY decide(approved) mutates the locked goal.
//   inv2 TRIGGER HONESTY — the verdict is the sole discriminator (young→null, mutate→proposes).
//   inv3 EVIDENCE-REQ    — stalled but no positive evidence (none, or negative-only) → null.
//   inv4 HONEST RATIONALE— cites the verdict phrase + the REAL belief body; never a fabricated metric.
//   inv5 GUARDED APPLY   — approve applies+records+refreshes the mirror; reject byte-unchanged; a raced
//                          unlock throws and leaves the revision proposed.
//   inv6 ONE-STANDING    — two analyzes → one revision; after reject a re-analyze may propose again.
//   inv7 WHITELIST       — TOOL_SCHEMAS stays 11; the revision tools are NON-MCP (never agent-assertable).
//   inv8 MEASURED-FLAT   — connected + a flat REAL delta → proposes with the measured-flat phrase
//                          (the previously-dark branch: shipping, but the number has not moved).
//
// Deterministic throughout: a FIXED clock `NOW`; buildCmoReport derives every window from it, so
// backdating route/verifiedAt/snapshot rows relative to `NOW` lands the verdict where each case needs.
// Isolated: tenants biz_receval_a/b, wiped before each test AND after all (a sibling suite counts
// RouteRevision rows — this gate must neither leak its proposals nor read another suite's).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { persistCraftBelief } from "../src/tools/belief-graph.js";
import { analyzeRouteForRevision } from "../src/tools/growth-analyst.js";
import { proposeRouteRevision } from "../src/tools/route-revision.js";
import { decideRouteRevision } from "../src/tools/decide-revision.js";
import { mirrorPlanToGraph } from "../src/tools/memory-graph.js";
import { connectIntegration } from "../src/tools/integration.js";
import { TOOL_SCHEMAS } from "../src/server.js";

const NOW = new Date("2026-07-13T00:00:00.000Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const weeksAgo = (n: number): Date => new Date(NOW.getTime() - n * WEEK_MS);

const A = "biz_receval_a";
const B = "biz_receval_b";
const GOAL = "old goal";
// Distinctive, METRIC-WORD-FREE nonce bodies so a rationale assertion proves the REAL belief body
// is cited (not a template) while /%|percent|conversion|engagement|impressions|clicks|reach/ stays absent.
const BELIEF_BODY = "readers replied warmly on hn RECEVALHNQ7";
const NEG_BELIEF_BODY = "readers ignored the hn thread RECEVALNEGQ3";
const METRIC_WORDS = /%|percent|conversion|engagement|impressions|clicks|reach/i;

async function wipe(businessId: string): Promise<void> {
  // FK-safe teardown: edges → nodes → revisions → snapshots → integrations → assets → actions →
  // waypoints → routes → objectives (matches the cmo-report/decide-revision wipe orders).
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.routeRevision.deleteMany({ where: { businessId } });
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.business.upsert({ where: { id: businessId }, create: { id: businessId, name: businessId }, update: {} });
}

/**
 * A STALLED fixture: route created 6 weeks ago + ONE verified send 5 weeks ago (executedTotal>0 but
 * executedRecent 0 over the 3-week stall window → the grader lands on "stalled"). The single waypoint's
 * status is caller-chosen: `locked` is the analyzer's revisable target; `active` gives it no target.
 */
async function seedStalled(businessId: string, waypointStatus: "locked" | "active"): Promise<{ routeId: string; waypointId: string }> {
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active", createdAt: weeksAgo(6) } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Grow", goal: GOAL, status: waypointStatus, createdAt: weeksAgo(6) } });
  await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: weeksAgo(5), createdAt: weeksAgo(5) } });
  return { routeId: route.id, waypointId: wp.id };
}

/** Seed a positive-evidence channel (hackernews) whose cited body is a distinctive metric-free nonce. */
async function seedPositiveHackernews(businessId: string, body: string = BELIEF_BODY): Promise<void> {
  await persistCraftBelief({ businessId }, {
    role: "copywriter", featureKey: "channel=hackernews",
    belief: { confidence: 0.5, stance: "positive", lowConfidence: false, summary: body },
  });
}

/** Seed a NEGATIVE hackernews belief — evidence exists, but nothing positive to cite (cited stays empty). */
async function seedNegativeHackernews(businessId: string): Promise<void> {
  await persistCraftBelief({ businessId }, {
    role: "copywriter", featureKey: "channel=hackernews",
    belief: { confidence: 0.5, stance: "negative", lowConfidence: false, summary: NEG_BELIEF_BODY },
  });
}

describe("stage-6c eval gate — route revisions: never-auto, evidence-required, honestly-recorded, guarded, non-MCP", () => {
  beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });
  beforeEach(async () => { await wipe(A); await wipe(B); });
  afterAll(async () => { await wipe(A); await wipe(B); });

  it("inv1 NEVER-AUTO: analyze proposes but never applies; only decide(approved) changes the locked goal", async () => {
    const { waypointId } = await seedStalled(A, "locked");
    await seedPositiveHackernews(A);

    const res = await analyzeRouteForRevision({ businessId: A }, NOW);
    expect(res).not.toBeNull();

    // After the PROPOSAL the locked waypoint's goal is BYTE-UNCHANGED (nothing auto-applied).
    expect((await prisma.routeWaypoint.findUnique({ where: { id: waypointId } }))?.goal).toBe(GOAL);
    const row = await prisma.routeRevision.findUnique({ where: { id: res!.revisionId } });
    expect(row?.status).toBe("proposed");
    const proposedGoal = row!.proposedGoal;
    expect(proposedGoal).not.toBe(GOAL); // the proposal is a real, DIFFERENT goal — so the apply-check below is non-vacuous

    // Cross-tenant: a foreign business can neither see nor decide A's revision; the goal stays put.
    await expect(decideRouteRevision({ businessId: B }, { revisionId: res!.revisionId, decision: "approved" }, NOW))
      .rejects.toThrow(/not found/i);
    expect((await prisma.routeWaypoint.findUnique({ where: { id: waypointId } }))?.goal).toBe(GOAL);

    // ONLY the owner's explicit approve applies it.
    expect(await decideRouteRevision({ businessId: A }, { revisionId: res!.revisionId, decision: "approved" }, NOW)).toEqual({ applied: true });
    expect((await prisma.routeWaypoint.findUnique({ where: { id: waypointId } }))?.goal).toBe(proposedGoal);
  });

  it("inv2 TRIGGER HONESTY: the verdict is the sole discriminator — young→null, then mutate to stalled→proposes", async () => {
    // Everything inv1's proposing fixture has (locked waypoint + a positive belief) EXCEPT the verdict:
    // a route THIS week is getting-started, not stalled.
    const obj = await prisma.objective.create({ data: { businessId: A, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: A, objectiveId: obj.id, source: "composed", status: "active", createdAt: weeksAgo(0) } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: A, routeId: route.id, order: 1, title: "Grow", goal: GOAL, status: "locked", createdAt: weeksAgo(0) } });
    const action = await prisma.routeAction.create({ data: { businessId: A, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: weeksAgo(0), createdAt: weeksAgo(0) } });
    await seedPositiveHackernews(A);

    // Young/healthy → getting-started → no proposal.
    expect(await analyzeRouteForRevision({ businessId: A }, NOW)).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: A } })).toBe(0);

    // Mutate ONLY the verdict-driving fields (age the route + backdate the send) → stalled. Same
    // waypoint, same belief — the verdict is the only thing that changed, and now it proposes.
    await prisma.route.update({ where: { id: route.id }, data: { createdAt: weeksAgo(6) } });
    await prisma.routeAction.update({ where: { id: action.id }, data: { verifiedAt: weeksAgo(5), createdAt: weeksAgo(5) } });

    const res = await analyzeRouteForRevision({ businessId: A }, NOW);
    expect(res).not.toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: A } })).toBe(1);
  });

  it("inv3 EVIDENCE-REQUIRED: stalled with NO beliefs → null; stalled + only NEGATIVE beliefs → null (cited empty)", async () => {
    await seedStalled(A, "locked");

    // (a) No beliefs at all → no positive-evidence channel → null.
    expect(await analyzeRouteForRevision({ businessId: A }, NOW)).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: A } })).toBe(0);

    // (b) A negative belief exists (hasEvidence) but nothing positive → cited is empty → still null.
    await seedNegativeHackernews(A);
    expect(await analyzeRouteForRevision({ businessId: A }, NOW)).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: A } })).toBe(0);
  });

  it("inv4 HONEST RATIONALE: cites the verdict phrase + the REAL cited belief body (nonce), never a fabricated metric", async () => {
    await seedStalled(A, "locked");
    await seedPositiveHackernews(A);

    const res = await analyzeRouteForRevision({ businessId: A }, NOW);
    const row = await prisma.routeRevision.findUnique({ where: { id: res!.revisionId } });

    expect(row?.proposedGoal.startsWith("Lead with hackernews — ")).toBe(true);
    expect(row?.rationale).toContain("The plan has stalled"); // the stalled verdict phrase
    expect(row?.rationale).toContain(BELIEF_BODY);            // the REAL cited belief body (nonce) — not a template
    expect(row!.rationale).not.toMatch(METRIC_WORDS);         // never fabricates a %/metric move
  });

  it("inv5 GUARDED APPLY: approve applies+records+refreshes the mirror; reject byte-unchanged; a raced unlock throws + stays proposed", async () => {
    // One route, three locked waypoints — decide each before proposing the next (one-standing-per-route).
    const obj = await prisma.objective.create({ data: { businessId: A, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: A, objectiveId: obj.id, source: "composed", status: "active" } });
    const wp1 = await prisma.routeWaypoint.create({ data: { businessId: A, routeId: route.id, order: 1, title: "Grow", goal: GOAL, status: "locked" } });
    const wp2 = await prisma.routeWaypoint.create({ data: { businessId: A, routeId: route.id, order: 2, title: "Scale", goal: GOAL, status: "locked" } });
    const wp3 = await prisma.routeWaypoint.create({ data: { businessId: A, routeId: route.id, order: 3, title: "Expand", goal: GOAL, status: "locked" } });
    // Seed the plan mirror so each waypoint mirror node exists (body === the old goal).
    await mirrorPlanToGraph({ businessId: A }, route.id, NOW);

    // --- APPROVE: applies the goal, records an honest was/now/why node, refreshes the mirror ---
    const newGoal = "Lead with hackernews — old goal";
    const approved = await proposeRouteRevision({ businessId: A }, { routeId: route.id, waypointId: wp1.id, proposedGoal: newGoal, rationale: "Work is shipping but the number has not moved. The evidence favors hackernews: hn nonce" });
    // Before approve the mirror still carries the OLD goal — so the refresh assertion below is non-vacuous.
    expect((await prisma.memoryNode.findFirst({ where: { businessId: A, type: "waypoint", sourceId: wp1.id } }))?.body).toBe(GOAL);

    expect(await decideRouteRevision({ businessId: A }, { revisionId: approved!.revisionId, decision: "approved" }, NOW)).toEqual({ applied: true });
    expect((await prisma.routeWaypoint.findUnique({ where: { id: wp1.id } }))?.goal).toBe(newGoal);
    const revNode = await prisma.memoryNode.findFirst({ where: { businessId: A, type: "revision", sourceId: approved!.revisionId } });
    expect(revNode?.waypointId).toBe(wp1.id);
    expect(revNode?.body).toContain("Goal was: old goal");
    expect(revNode?.body).toContain(`now: ${newGoal}`);
    // The waypoint MIRROR node body is refreshed to the new goal — recall must not cite the stale goal.
    expect((await prisma.memoryNode.findFirst({ where: { businessId: A, type: "waypoint", sourceId: wp1.id } }))?.body).toBe(newGoal);

    // --- REJECT: the goal is byte-unchanged and NO revision node is recorded for wp2 ---
    const rejected = await proposeRouteRevision({ businessId: A }, { routeId: route.id, waypointId: wp2.id, proposedGoal: "new goal", rationale: "r" });
    expect(await decideRouteRevision({ businessId: A }, { revisionId: rejected!.revisionId, decision: "rejected" }, NOW)).toEqual({ applied: false });
    expect((await prisma.routeWaypoint.findUnique({ where: { id: wp2.id } }))?.goal).toBe(GOAL);
    expect((await prisma.routeRevision.findUnique({ where: { id: rejected!.revisionId } }))?.status).toBe("rejected");
    expect(await prisma.memoryNode.count({ where: { businessId: A, type: "revision", sourceId: rejected!.revisionId } })).toBe(0);

    // --- RACED: wp3 leaves `locked` before the decision → approve throws, revision STAYS proposed, goal unchanged ---
    const raced = await proposeRouteRevision({ businessId: A }, { routeId: route.id, waypointId: wp3.id, proposedGoal: "new goal", rationale: "r" });
    await prisma.routeWaypoint.update({ where: { id: wp3.id }, data: { status: "active" } });
    await expect(decideRouteRevision({ businessId: A }, { revisionId: raced!.revisionId, decision: "approved" }, NOW))
      .rejects.toThrow(/no longer revisable/i);
    expect((await prisma.routeRevision.findUnique({ where: { id: raced!.revisionId } }))?.status).toBe("proposed");
    expect((await prisma.routeWaypoint.findUnique({ where: { id: wp3.id } }))?.goal).toBe(GOAL);
  });

  it("inv6 ONE-STANDING + rerun-safe: two analyzes → one revision; after reject a re-analyze may propose again", async () => {
    await seedStalled(A, "locked");
    await seedPositiveHackernews(A);

    const first = await analyzeRouteForRevision({ businessId: A }, NOW);
    expect(first).not.toBeNull();
    // A second analyze while one still stands → null; still exactly one.
    expect(await analyzeRouteForRevision({ businessId: A }, NOW)).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: A } })).toBe(1);

    // The founder REJECTS that change; the trigger still holds (stalled + evidence + still-locked waypoint)...
    await decideRouteRevision({ businessId: A }, { revisionId: first!.revisionId, decision: "rejected" }, NOW);

    // ...so a re-analyze may propose a SECOND, distinct revision — the "no" was to THAT change, not to all change.
    const second = await analyzeRouteForRevision({ businessId: A }, NOW);
    expect(second).not.toBeNull();
    expect(second!.revisionId).not.toBe(first!.revisionId);

    // Both are recorded: the first rejected, the second proposed.
    expect(await prisma.routeRevision.count({ where: { businessId: A } })).toBe(2);
    expect((await prisma.routeRevision.findUnique({ where: { id: first!.revisionId } }))?.status).toBe("rejected");
    expect((await prisma.routeRevision.findUnique({ where: { id: second!.revisionId } }))?.status).toBe("proposed");
  });

  it("inv7 WHITELIST: TOOL_SCHEMAS stays 11 and never exposes the revision tools (they are NON-MCP)", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toHaveLength(11);
    for (const forbidden of ["propose_route_revision", "decide_route_revision", "analyze_route"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("inv8 MEASURED-FLAT TRIGGER: connected + a flat REAL delta → proposes with the measured-flat phrase (the previously-dark branch)", async () => {
    // A shipping-but-flat business: route 6w old, a verified send 1w ago (so NOT stalled — executedRecent>0),
    // analytics connected with two EQUAL real snapshots (delta 0 → measured-flat, not measured-working).
    const obj = await prisma.objective.create({ data: { businessId: A, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: A, objectiveId: obj.id, source: "composed", status: "active", createdAt: weeksAgo(6) } });
    const activeWp = await prisma.routeWaypoint.create({ data: { businessId: A, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active", createdAt: weeksAgo(6) } });
    const lockedWp = await prisma.routeWaypoint.create({ data: { businessId: A, routeId: route.id, order: 2, title: "Grow", goal: GOAL, status: "locked", createdAt: weeksAgo(6) } });
    // The verified send that keeps the loop out of `stalled` (recent) while the metric stays flat.
    await prisma.routeAction.create({ data: { businessId: A, waypointId: activeWp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: weeksAgo(1), createdAt: weeksAgo(1) } });

    const { integrationId } = await connectIntegration({ businessId: A }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: A, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: A, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(0) } });

    await seedPositiveHackernews(A);

    const res = await analyzeRouteForRevision({ businessId: A }, NOW);
    expect(res).not.toBeNull();
    const row = await prisma.routeRevision.findUnique({ where: { id: res!.revisionId } });
    expect(row?.waypointId).toBe(lockedWp.id); // targeted the next locked waypoint
    // The measured-flat phrase — the branch that was previously dark (only `stalled` used to reach here).
    expect(row?.rationale).toContain("shipping but the number has not moved");
    expect(row?.rationale).toContain(BELIEF_BODY);
    expect(row!.rationale).not.toMatch(METRIC_WORDS);
    // NEVER-AUTO holds on the measured-flat path too: the locked goal is untouched until decide.
    expect((await prisma.routeWaypoint.findUnique({ where: { id: lockedWp.id } }))?.goal).toBe(GOAL);
  });
});
