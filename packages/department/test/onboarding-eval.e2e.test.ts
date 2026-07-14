// §15 stage-6f eval gate — OBJECTIVE ONBOARDING, wired into the nightly, is
// (inv1) THE FIRST MORNING END-TO-END: a founder-stated objective (via the REAL
// createObjective) + a discovered Case + no route → ONE full runNightly produces a
// `proposed` route grounded in the BEST case, an order-1 `active` waypoint with
// `proposed` actions, AND at least one action DRAFTED (asset bound) the SAME night —
// while NOTHING is approved/executed (every action `proposed`, every approvedAt null).
// The complete never-auto morning briefing. (inv2) ONE-STANDING: a second nightly never
// re-fires the bootstrap — the route count stays 1. (inv3) NO-CASES HONESTY: an objective
// with no discovered cases skips with ZERO route-strategist model calls and zero routes.
// (inv4) NO-OBJECTIVE: neither objective nor route → skip "no objective" (the objective
// gate short-circuits BEFORE the case lookup) with nothing persisted. (inv5) NO DUPLICATE
// OBJECTIVE: the nightly reuses the founder-stated row (existingObjectiveId) — objective
// count stays 1 and the route hangs off the created objective's id. (inv6) NON-MCP: the
// whitelist stays 11 — onboarding is a cockpit form + a department pipeline, never an
// agent-assertable tool.
//
// The composition proof is inv1's drafted-same-night assertion: the plan section runs
// FIRST (bootstrapping the route + its proposed action on an order-1 active waypoint), so
// the SAME night's drafts section finds an undrafted proposal and binds it an asset. A real
// Asset row (assetId → asset) proves the draft branch genuinely fired on the bootstrapped
// route — not a vacuous pass.
//
// The dual/tri-purpose fake harness answers the route-strategist call (its context contains
// "Chosen case:") with a schema-valid RouteProposal, the copywriter draft call ("Action:
// draft ...") with a schema-valid Draft, and the (quiet) radar call with empty observations;
// it records every input so a test can prove a route-strategist call did (or did NOT) happen.
// A quiet HN transport keeps radar from proposing; a throwing metric transport keeps the
// metrics section from connecting a source (so CRO never triggers). Tenants live under
// biz_onboardeval_* so this gate never collides with other suites sharing the DB.
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { createObjective } from "dionysus-mcp/tools/plan";
import type { MetricTransport } from "dionysus-mcp/tools/analytics";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";
import { runNightly, type NightlyDeps } from "../src/run-nightly.js";

// A schema-valid RouteProposal (parseRouteProposal): one waypoint, one draftable action
// (type "post", channel "hackernews") so the plan's order-1 waypoint carries a proposed
// action the same night's drafts section can bind.
const ROUTE_PROPOSAL = JSON.stringify({ waypoints: [
  { title: "Launch on HN", goal: "First signups toward the goal",
    actions: [{ employeeRole: "copywriter", type: "post", rationale: "authentic Show HN post", features: { channel: "hackernews" } }] },
] });
// A schema-valid Draft (parseDraft) so the copywriter binds an asset.
const DRAFT_JSON = JSON.stringify({ channel: "hackernews", kind: "post", content: { title: "T", body: "A crisp launch note for HN." } });
// The (quiet) radar payload — no observations, so radar proposes nothing and stays out of
// the way of the plan → draft composition under test.
const OBSERVATIONS_JSON = JSON.stringify({ observations: [] });

// The route-strategist probe: proposeRoute fences the chosen case behind "Chosen case:" —
// counting inputs that contain it is a bulletproof "did the bootstrap reach the model?" check.
const CASE_MARKER = "Chosen case:";

function onboardingHarness(): { harness: Harness; inputs: string[] } {
  const inputs: string[] = [];
  const harness: Harness = {
    async runAgent(_def: AgentDef, input: string) {
      inputs.push(input);
      if (input.includes(CASE_MARKER)) return { finalOutput: ROUTE_PROPOSAL };
      if (input.includes("Action: draft")) return { finalOutput: DRAFT_JSON };
      return { finalOutput: OBSERVATIONS_JSON };
    },
    async completeOnce() { return "unused"; },
  };
  return { harness, inputs };
}

const quietHn: HnTransport = async () => ({ status: 200, body: JSON.stringify({ hits: [] }) });
const failMetrics: MetricTransport = async () => { throw new Error("no metric endpoint in eval"); };

function makeDeps(): { deps: NightlyDeps; inputs: string[] } {
  const { harness, inputs } = onboardingHarness();
  return { deps: { harness, models: { brain: "fake" }, hnTransport: quietHn, metricTransport: failMetrics }, inputs };
}

// Seed a discovered Case via raw prisma with exactly the columns proposeRoute reads
// (name/platform/mode/historicalArcJson/modernizedPlanJson/insight) plus rank (the nightly
// orders by rank asc — the historian ranks 1 = most relevant, so rank 1 is the BEST case)
// and the two required-but-unread columns the schema demands (sourcesJson/confidence).
async function seedCase(businessId: string, rank: number, name: string) {
  return prisma.case.create({ data: {
    businessId, name, platform: "hackernews", mode: "launch-led", rank,
    historicalArcJson: JSON.stringify([{ when: "2020", beat: "Show HN" }]),
    modernizedPlanJson: JSON.stringify({ steps: ["Show HN"] }),
    insight: "Authenticity wins", sourcesJson: JSON.stringify([]), confidence: 0.7 } });
}

// FK-safe teardown (edges → nodes → revisions → snapshots → integrations → assets →
// actions → waypoints → routes → objectives → cases → products); leaves the Business row.
async function wipeChildren(businessId: string): Promise<void> {
  await prisma.nightlyRun.deleteMany({ where: { businessId } }); // 6j: the diary FK-guards business deletion
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
  await prisma.case.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
}

async function freshBusiness(businessId: string): Promise<void> {
  await wipeChildren(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name: businessId, maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 } });
}

const OBJ = { kind: "growth", target: "100 signups", metric: "signups" } as const;

const TENANTS = [
  "biz_onboardeval_firstmorning",
  "biz_onboardeval_standing",
  "biz_onboardeval_nocases",
  "biz_onboardeval_noobjective",
  "biz_onboardeval_noduplicate",
];

describe("§15 stage-6f eval gate — the first morning is complete, never-auto, honest-skipping, non-MCP", () => {
  afterAll(async () => {
    for (const b of TENANTS) await wipeChildren(b);
    await prisma.business.deleteMany({ where: { id: { in: TENANTS } } });
  });

  it("inv1 THE FIRST MORNING: objective + Case + no route → one nightly → a proposed route, an active waypoint with proposed actions, at least one DRAFTED, nothing approved", async () => {
    const BIZ = "biz_onboardeval_firstmorning";
    await freshBusiness(BIZ);
    const { objectiveId } = await createObjective({ businessId: BIZ }, OBJ); // the REAL founder-stated objective
    // Two cases: the nightly must pick the BEST (rank 1), not merely the first inserted.
    await seedCase(BIZ, 2, "Runner-up");
    const best = await seedCase(BIZ, 1, "Best Case");

    const { deps } = makeDeps();
    const res = await runNightly({ businessId: BIZ }, deps);

    // The bootstrap fired: exactly one PROPOSED route grounded in the rank-1 case.
    expect(res.plan.status).toBe("ok");
    const routes = await prisma.route.findMany({ where: { businessId: BIZ } });
    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route.status).toBe("proposed");        // never-auto: no route-activation theater
    expect(route.caseRef).toBe(best.id);          // the BEST case (rank asc), not the runner-up
    expect(route.objectiveId).toBe(objectiveId);  // hangs off the founder-stated objective

    // Order-1 waypoint is active and carries proposed actions.
    const wp1 = await prisma.routeWaypoint.findFirst({ where: { businessId: BIZ, routeId: route.id, order: 1 } });
    expect(wp1).not.toBeNull();
    expect(wp1!.status).toBe("active");
    const wpActions = await prisma.routeAction.findMany({ where: { businessId: BIZ, waypointId: wp1!.id } });
    expect(wpActions.length).toBeGreaterThanOrEqual(1);
    expect(wpActions.every((a) => a.status === "proposed")).toBe(true);

    // COMPOSITION PROOF: the same night DRAFTED at least one action (asset bound) — the plan
    // section ran first, the drafts section found the undrafted proposal and bound it an asset.
    expect(res.drafts.status).toBe("ok");
    const drafted = await prisma.routeAction.findMany({ where: { businessId: BIZ, assetId: { not: null } } });
    expect(drafted.length).toBeGreaterThanOrEqual(1);
    for (const a of drafted) {
      // Non-vacuous: the bound assetId points at a real Asset row this night.
      expect(await prisma.asset.count({ where: { businessId: BIZ, id: a.assetId! } })).toBe(1);
    }

    // NEVER-AUTO: across the ENTIRE tenant, nothing is beyond `proposed`, nothing approved.
    expect(await prisma.routeAction.count({ where: { businessId: BIZ, status: { not: "proposed" } } })).toBe(0);
    const allActions = await prisma.routeAction.findMany({ where: { businessId: BIZ } });
    expect(allActions.every((a) => a.approvedAt === null)).toBe(true);
  });

  it("inv2 ONE-STANDING: a second nightly never re-fires the bootstrap — the route count stays 1", async () => {
    const BIZ = "biz_onboardeval_standing";
    await freshBusiness(BIZ);
    await createObjective({ businessId: BIZ }, OBJ);
    await seedCase(BIZ, 1, "Best Case");

    const first = await runNightly({ businessId: BIZ }, makeDeps().deps);
    expect(first.plan.status).toBe("ok");
    expect(await prisma.route.count({ where: { businessId: BIZ } })).toBe(1); // the bootstrap ran once

    const { deps, inputs } = makeDeps();
    const second = await runNightly({ businessId: BIZ }, deps);
    expect(second.plan).toMatchObject({ status: "skipped", reason: expect.stringContaining("already exists") });
    expect(await prisma.route.count({ where: { businessId: BIZ } })).toBe(1); // still one — no re-plan
    expect(inputs.some((i) => i.includes(CASE_MARKER))).toBe(false); // short-circuited before the model
  });

  it("inv3 NO-CASES HONESTY: objective + no cases → plan skips 'no discovered cases' with ZERO route-strategist calls and zero routes", async () => {
    const BIZ = "biz_onboardeval_nocases";
    await freshBusiness(BIZ);
    await createObjective({ businessId: BIZ }, OBJ); // objective present, but no discovered cases

    const { deps, inputs } = makeDeps();
    const res = await runNightly({ businessId: BIZ }, deps);
    expect(res.plan).toMatchObject({ status: "skipped", reason: expect.stringContaining("no discovered cases") });
    expect(await prisma.route.count({ where: { businessId: BIZ } })).toBe(0);
    expect(inputs.some((i) => i.includes(CASE_MARKER))).toBe(false); // the honest skip made no model call
  });

  it("inv4 NO-OBJECTIVE: neither objective nor route → plan skips 'no objective' (the objective gate precedes the case lookup), nothing persisted", async () => {
    const BIZ = "biz_onboardeval_noobjective";
    await freshBusiness(BIZ);
    // A Case IS present but there is no objective — the plan must skip for the RIGHT reason.
    await seedCase(BIZ, 1, "Best Case");

    const { deps, inputs } = makeDeps();
    const res = await runNightly({ businessId: BIZ }, deps);
    expect(res.plan).toMatchObject({ status: "skipped", reason: expect.stringContaining("no objective") });
    // Nothing was persisted by the nightly — no route, no objective (the seeded case is untouched).
    expect(await prisma.route.count({ where: { businessId: BIZ } })).toBe(0);
    expect(await prisma.objective.count({ where: { businessId: BIZ } })).toBe(0);
    expect(inputs.some((i) => i.includes(CASE_MARKER))).toBe(false);
  });

  it("inv5 NO DUPLICATE OBJECTIVE: the nightly reuses the founder-stated row — objective count stays 1 and the route hangs off the created id", async () => {
    const BIZ = "biz_onboardeval_noduplicate";
    await freshBusiness(BIZ);
    const { objectiveId } = await createObjective({ businessId: BIZ }, OBJ);
    await seedCase(BIZ, 1, "Best Case");

    const res = await runNightly({ businessId: BIZ }, makeDeps().deps);
    expect(res.plan.status).toBe("ok");
    // The bootstrap passed existingObjectiveId → NO second objective row was created.
    expect(await prisma.objective.count({ where: { businessId: BIZ } })).toBe(1);
    const route = await prisma.route.findFirst({ where: { businessId: BIZ } });
    expect(route!.objectiveId).toBe(objectiveId);
  });

  it("inv6 WHITELIST: TOOL_SCHEMAS stays exactly 11 and never exposes an onboarding tool (onboarding is a cockpit form + department pipeline, non-MCP)", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toHaveLength(11);
    for (const forbidden of ["propose_route_bootstrap", "create_objective_form"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
