// §15 stage-4f eval gate — the CMO report can NEVER fabricate an unmeasured
// outcome. This is the stage's headline honesty invariant (§3 / D21 / D31) under
// attack end-to-end: at 4f `analyticsConnected` is hardcoded false, so the
// grader's MEASURED branch is structurally unreachable and every verdict the
// report can emit is an unmeasured state that LEADS with the measurement gap.
// The report never claims the objective's metric moved.
//
// Every executed send in this gate is GENUINE: it is driven through the REAL
// lifecycle (upsertRouteAction -> persistAsset -> setActionAsset -> approveAction
// -> startExecution -> completeExecution), never a raw `status: "executed"` poke.
// completeExecution leaves `verifiedAt` null, so we backdate verifiedAt via
// prisma.routeAction.update to place each real send in the intended window — that
// backdating is what makes the window/stall assertions load-bearing.
//
// The CLOCK is a FIXED `now` passed to buildCmoReport; nothing reads wall-clock,
// so every window (7d whatRan, 21d stall) is deterministic against backdated rows.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { buildCmoReport } from "../src/tools/cmo-report.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction, startExecution, completeExecution } from "../src/tools/lifecycle.js";

// A FIXED clock. Every window in buildCmoReport is derived from this `now`.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

// Window anchors (cmo-verdict.ts: MIN_WEEKS_TO_JUDGE = 2, STALL_WEEKS = 3 -> a
// 21-day "recent"/stall window; buildCmoReport's whatRan window is the last 7d).
const IN_WEEK = daysAgo(2); //           inside the 7d whatRan window AND the 21d recent window
const IN_RECENT_NOT_WEEK = daysAgo(20); //  outside 7d (not in whatRan) but inside 21d (still "recent")
const BEFORE_STALL = daysAgo(30); //     older than the 21d stall window -> executedRecent = 0

// Route ages -> weeksActive = floor((now - earliestRoute.createdAt) / 7d).
const ROUTE_JUDGED = daysAgo(35); //     weeksActive = 5  (>= MIN_WEEKS_TO_JUDGE, >= STALL_WEEKS)
const ROUTE_STALLABLE = daysAgo(56); //  weeksActive = 8  (>= STALL_WEEKS)
const ROUTE_TOO_NEW = daysAgo(10); //    weeksActive = 1  (< MIN_WEEKS_TO_JUDGE)

// Tenants — one per invariant, all under a biz_cmoeval_* namespace so this gate
// never collides with the other e2e suites sharing the test DB.
const SHIPPED = { businessId: "biz_cmoeval_shipped" }; // inv1: genuinely shipped, unmeasured
const STALLED = { businessId: "biz_cmoeval_stalled" }; // inv2: flat weeks
const RECENT = { businessId: "biz_cmoeval_recent" }; //   inv2 contrast: recent send -> not stalled
const FRESH = { businessId: "biz_cmoeval_fresh" }; //     inv3: brand-new, zero executed
const TOONEW = { businessId: "biz_cmoeval_toonew" }; //   inv3: shipped but under MIN_WEEKS_TO_JUDGE
const WINDOW = { businessId: "biz_cmoeval_window" }; //   inv4: 7d window correctness
const TENANT_A = { businessId: "biz_cmoeval_a" }; //      inv5: scope target
const GHOST_B = { businessId: "biz_cmoeval_ghost" }; //   inv5: ghost tenant (EXISTS, own data)

const ALL = [SHIPPED, STALLED, RECENT, FRESH, TOONEW, WINDOW, TENANT_A, GHOST_B];

async function wipe(businessId: string): Promise<void> {
  // FK-safe order: Asset -> RouteAction -> RouteWaypoint -> Route -> Objective; MemoryNode is independent.
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
}

/** objective -> route (createdAt backdated to control weeksActive) -> order-1 waypoint. */
async function scaffold(identity: { businessId: string }, routeCreatedAt: Date): Promise<{ waypointId: string }> {
  const { objectiveId } = await createObjective(identity, { kind: "growth", target: "500 signups", metric: "signups" });
  const { routeId } = await persistRoute(identity, { objectiveId, source: "case" });
  await prisma.route.update({ where: { id: routeId }, data: { createdAt: routeCreatedAt } });
  const { waypointId } = await persistWaypoint(identity, { routeId, order: 1, title: "Launch", goal: "20 signups" });
  return { waypointId };
}

let runSeq = 0;
/**
 * Ship ONE genuinely executed+verified send through the real lifecycle, then
 * backdate verifiedAt so it lands in the intended window. "Executed" here is the
 * real terminal state (approve -> startExecution -> completeExecution), never a
 * raw status write — so the gate defends the report against real loop output.
 */
async function shipVerified(
  identity: { businessId: string },
  waypointId: string,
  opts: { channel: string; title: string; verifiedAt: Date },
): Promise<string> {
  const { actionId } = await upsertRouteAction(identity, { waypointId, employeeRole: "copywriter", type: "post", rationale: "launch" });
  const { assetId } = await persistAsset(identity, { channel: opts.channel, kind: "post", content: { title: opts.title, body: "b" }, routeActionId: actionId });
  await setActionAsset(identity, actionId, assetId);
  await approveAction(identity, { routeActionId: actionId, principal: "founder@example.com" });
  await startExecution(identity, { routeActionId: actionId, runId: `run_${++runSeq}` });
  await completeExecution(identity, { routeActionId: actionId });
  // completeExecution sets status=executed but leaves verifiedAt null. Backdate it
  // (and record a postedUrl) so this real send falls in the window under test.
  await prisma.routeAction.update({
    where: { id: actionId },
    data: { verifiedAt: opts.verifiedAt, postedUrl: `https://live.test/${opts.channel}` },
  });
  return actionId;
}

/** A bound proposed draft that never ships — proves "route exists, nothing executed". */
async function proposedDraft(identity: { businessId: string }, waypointId: string): Promise<void> {
  const { actionId } = await upsertRouteAction(identity, { waypointId, employeeRole: "copywriter", type: "post" });
  const { assetId } = await persistAsset(identity, { channel: "x", kind: "post", content: { title: "Draft", body: "b" }, routeActionId: actionId });
  await setActionAsset(identity, actionId, assetId);
}

async function observe(identity: { businessId: string }, title: string): Promise<void> {
  await prisma.memoryNode.create({
    data: { businessId: identity.businessId, type: "market-observation", title, body: "b", confidence: 0.6, sourceUrl: "https://n.test/" + title, tainted: true, createdAt: IN_WEEK },
  });
}

describe("§15 stage-4f eval gate — the CMO report never fabricates an unmeasured outcome", () => {
  beforeAll(async () => {
    for (const t of ALL) await wipe(t.businessId);
    for (const t of ALL) await prisma.business.upsert({ where: { id: t.businessId }, create: { id: t.businessId, name: t.businessId }, update: {} });

    // inv1 SHIPPED: judged loop, one real verified send in-week -> live but unmeasured.
    const shipped = await scaffold(SHIPPED, ROUTE_JUDGED);
    await shipVerified(SHIPPED, shipped.waypointId, { channel: "x", title: "Launch tweet", verifiedAt: IN_WEEK });

    // inv2 STALLED: history exists but the only send is older than the stall window.
    const stalled = await scaffold(STALLED, ROUTE_STALLABLE);
    await shipVerified(STALLED, stalled.waypointId, { channel: "x", title: "Old launch", verifiedAt: BEFORE_STALL });

    // inv2 RECENT contrast: SAME route age as STALLED; ONLY the verifiedAt differs
    // (recent vs before-stall) -> proves the backdating alone flips stalled.
    const recent = await scaffold(RECENT, ROUTE_STALLABLE);
    await shipVerified(RECENT, recent.waypointId, { channel: "x", title: "Fresh launch", verifiedAt: IN_WEEK });

    // inv3 FRESH: brand-new route, a draft exists but nothing has ever executed.
    const fresh = await scaffold(FRESH, NOW);
    await proposedDraft(FRESH, fresh.waypointId);

    // inv3 TOONEW: HAS shipped a real send, but the route is < MIN_WEEKS_TO_JUDGE old.
    const toonew = await scaffold(TOONEW, ROUTE_TOO_NEW);
    await shipVerified(TOONEW, toonew.waypointId, { channel: "x", title: "Day-one post", verifiedAt: IN_WEEK });

    // inv4 WINDOW: two genuine sends — one 2d ago (in whatRan), one 20d ago (excluded).
    const win = await scaffold(WINDOW, ROUTE_JUDGED);
    await shipVerified(WINDOW, win.waypointId, { channel: "x", title: "In-week send", verifiedAt: IN_WEEK });
    await shipVerified(WINDOW, win.waypointId, { channel: "linkedin", title: "Out-of-week send", verifiedAt: IN_RECENT_NOT_WEEK });

    // inv5 A + ghost B: each has its own objective, send and radar observation.
    const a = await scaffold(TENANT_A, ROUTE_JUDGED);
    await shipVerified(TENANT_A, a.waypointId, { channel: "x", title: "Alpha tenant post", verifiedAt: IN_WEEK });
    await observe(TENANT_A, "Alpha radar signal");
    const b = await scaffold(GHOST_B, ROUTE_JUDGED);
    await shipVerified(GHOST_B, b.waypointId, { channel: "linkedin", title: "Beta ghost post", verifiedAt: IN_WEEK });
    await observe(GHOST_B, "Beta radar signal");
  });

  // inv1 — HONESTY CORE (the marquee). A business that GENUINELY shipped work
  // (real executed+verified send) but has no analytics connected must NEVER get a
  // measured verdict and must NEVER claim the metric moved. Non-vacuous: the biz
  // really shipped (objective present, whatRan non-empty), so this is exactly the
  // case where a naive report might be tempted to fabricate a % move.
  it("inv1 honesty core: a genuinely-shipped-but-unmeasured business never claims the metric moved", async () => {
    const report = await buildCmoReport(SHIPPED, NOW);

    // Precondition: the business genuinely shipped — honesty is not vacuously true on an empty tenant.
    expect(report.objective).not.toBeNull();
    expect(report.whatRan.length).toBeGreaterThanOrEqual(1);

    // §3 / D21: analytics disconnected -> an unmeasured verdict that claims nothing moved.
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    expect(["getting-started", "shipping-unmeasured", "stalled"]).toContain(report.verdict.state);
    expect(report.verdict.state).not.toBe("measured-working");
    expect(report.verdict.state).not.toBe("measured-flat");
    // Concrete: live + judged + no analytics is the shipping-unmeasured verdict.
    expect(report.verdict.state).toBe("shipping-unmeasured");
    // "What moved" honesty: no fabricated percentage anywhere in the human-facing verdict.
    // The measured-working headline ("Your number is up N% …") is the only verdict that
    // carries a %, so its absence is the machine-checkable proxy that nothing was faked.
    expect(report.verdict.headline).not.toMatch(/%/);
    expect(report.verdict.recommendation).not.toMatch(/%/);
  });

  // inv2 — STALLED leads with the flat weeks (D31.A), and the contrast proves the
  // backdating is load-bearing: RECENT is byte-for-byte the same setup as STALLED
  // (same route age, one real send) EXCEPT its send is recent -> NOT stalled.
  it("inv2 stalled: flat weeks -> stalled + route/pause; a recent send with identical setup is NOT stalled", async () => {
    const stalled = await buildCmoReport(STALLED, NOW);
    expect(stalled.verdict.state).toBe("stalled");
    expect(stalled.verdict.claimsMetricMoved).toBe(false);
    expect(stalled.verdict.recommendation.toLowerCase()).toMatch(/route|pause/);
    // It genuinely shipped once (history exists) — stalled is not "never shipped".
    expect(stalled.whatRan).toHaveLength(0); // the lone send is 30d old -> outside the 7d whatRan window

    // Contrast: same route age, only verifiedAt differs -> the stall flips off.
    const recent = await buildCmoReport(RECENT, NOW);
    expect(recent.verdict.state).not.toBe("stalled");
    expect(recent.verdict.state).toBe("shipping-unmeasured");
    expect(recent.whatRan).toHaveLength(1); // the recent send shows up in-week
  });

  // inv3 — getting-started at small N, both sub-cases: (a) nothing ever executed,
  // and (b) work HAS shipped but the loop is too new to judge. (b) is the sharp
  // one: it stays getting-started DESPITE a real in-week send, so the
  // MIN_WEEKS_TO_JUDGE gate is load-bearing (contrast inv1: same "shipped" fact,
  // older route -> shipping-unmeasured).
  it("inv3 getting-started: zero-executed AND shipped-but-too-new both grade getting-started", async () => {
    const fresh = await buildCmoReport(FRESH, NOW);
    expect(fresh.whatRan).toHaveLength(0);
    expect(fresh.verdict.state).toBe("getting-started");
    expect(fresh.verdict.claimsMetricMoved).toBe(false);

    const toonew = await buildCmoReport(TOONEW, NOW);
    expect(toonew.whatRan).toHaveLength(1); // it DID ship a real send this week…
    expect(toonew.verdict.state).toBe("getting-started"); // …yet is too new to judge
    expect(toonew.verdict.claimsMetricMoved).toBe(false);
  });

  // inv4 — the 7d whatRan window, read from the ASSEMBLED report (not the raw
  // query). Both sends are genuinely executed; only the 2d-old one is in-week, the
  // 20d-old one is excluded (though still inside the 21d "recent" window).
  it("inv4 week window: whatRan includes the 2d send and excludes the 20d one", async () => {
    const report = await buildCmoReport(WINDOW, NOW);
    expect(report.whatRan).toHaveLength(1);
    expect(report.whatRan[0]!.title).toBe("In-week send");
    expect(report.whatRan.map((w) => w.title)).not.toContain("Out-of-week send");
    // shipping-unmeasured, not stalled: the 20d send keeps executedRecent > 0.
    expect(report.verdict.state).toBe("shipping-unmeasured");
  });

  // inv5 — scoped by businessId. Ghost tenant B EXISTS with its own objective,
  // send and radar; buildCmoReport(A) reflects ONLY A, B gets its own report, and
  // neither leaks the other's whatRan/radar.
  it("inv5 scoped: A's report shows only A; ghost B gets its own; neither leaks the other", async () => {
    const a = await buildCmoReport(TENANT_A, NOW);
    expect(a.whatRan.map((w) => w.title)).toEqual(["Alpha tenant post"]);
    expect(a.whatRan.map((w) => w.title)).not.toContain("Beta ghost post");
    expect(a.radarNoticed.map((r) => r.title)).toEqual(["Alpha radar signal"]);
    expect(a.radarNoticed.map((r) => r.title)).not.toContain("Beta radar signal");

    const b = await buildCmoReport(GHOST_B, NOW);
    expect(b.whatRan.map((w) => w.title)).toEqual(["Beta ghost post"]);
    expect(b.whatRan.map((w) => w.title)).not.toContain("Alpha tenant post");
    expect(b.radarNoticed.map((r) => r.title)).toEqual(["Beta radar signal"]);
    expect(b.radarNoticed.map((r) => r.title)).not.toContain("Alpha radar signal");

    // A re-read after touching B is byte-for-byte the same: B never perturbs A.
    const aAgain = await buildCmoReport(TENANT_A, NOW);
    expect(aAgain.whatRan.map((w) => w.title)).toEqual(["Alpha tenant post"]);
    expect(aAgain.radarNoticed.map((r) => r.title)).toEqual(["Alpha radar signal"]);
  });
});
