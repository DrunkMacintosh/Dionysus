// §15 stage-5b eval gate — recall is FAITHFUL, HONEST, BUDGET-CAPPED, SCOPED, and
// CONCURRENCY-SAFE. Stage 5b turns the mirrored evolution graph into an agent's
// causal recall: `buildAgentContext` reads the plan-anchored graph (ancestor path +
// the anchor's action/outcome neighborhood) as a PURE, businessId-scoped, budget-capped
// read, and `mirrorPlanToGraph` records a verified-live `outcome` node ONLY for a real
// executed+verified send. This gate defends that the recall is (1) HONEST — an outcome
// exists only for an executed+verified action and states the go-live FACT (the postedUrl),
// never a fabricated metric; (2) FAITHFUL + ORDERED — the ancestor path reconstructs the
// waypoint order and the anchor's neighborhood carries its actions + their outcome;
// (3) BUDGET-CAPPED — maxItems hard-bounds both the item list and the rendered text;
// (4) DEGRADING — a never-mirrored route yields an all-empty context, no throw (no invented
// recall); (5) CONCURRENCY-SAFE — two concurrent mirrors never duplicate and the DB @@unique
// is real; (6) SCOPED — one tenant cannot read another's graph; (7) NON-AGENT — the traversal
// and writers stay off the 11-tool whitelist.
//
// Every chain is built with the REAL plan + lifecycle tools end-to-end (createObjective ->
// persistRoute -> persistWaypoint -> upsertRouteAction, then persistAsset -> setActionAsset
// -> approveAction -> startExecution -> completeExecution + the verified-send fact), never a
// raw prisma plan row, so the gate exercises the genuine surface recall reads from. Assertions
// read back from the DB rows / the real function returns (not just a mirror echo). Tenants live
// under a biz_ctxeval_* namespace so this gate never collides with memory-graph.test.ts
// (biz_agentctx_*, biz_mirror_*, biz_memgraph_*) or the other e2e suites sharing the test DB.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { TOOL_SCHEMAS } from "../src/server.js";
import { mirrorPlanToGraph, buildAgentContext } from "../src/tools/memory-graph.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction, startExecution, completeExecution } from "../src/tools/lifecycle.js";

// A FIXED clock. 5b does not window on `now`, but pass it explicitly (mirror-signature consistency).
const NOW = new Date("2026-07-10T12:00:00.000Z");

// One tenant per invariant so no fixture perturbs another; all EXIST (upserted) so every
// cross-tenant refusal is scope-based, never an artifact of an unknown business.
const OUT = { businessId: "biz_ctxeval_out" }; //     inv1: outcome honesty (executed+verified vs proposed)
const READ = { businessId: "biz_ctxeval_read" }; //   inv2 traversal + inv3 budget cap + inv4 degrade
const GHOST = { businessId: "biz_ctxeval_ghost" }; // inv6: ghost tenant reads READ's route -> refused
const CONC = { businessId: "biz_ctxeval_conc" }; //   inv5: concurrency-safe mirror + raw-dup constraint

const ALL = [OUT, READ, GHOST, CONC];

// Verified-live URLs — a plain FACT (the live post URL), never a metric. The in-URL digits are a
// legitimate post id, NOT a fabricated number: the honesty regex forbids `%`/metric words, not digits.
const OUT_POSTED_URL = "https://instagram.com/p/outcome123";
const READ_POSTED_URL = "https://instagram.com/p/recall777";

async function wipe(businessId: string): Promise<void> {
  // Graph rows use scalar refs (no FK cascade) — edges then nodes. Break the RouteAction<->Asset FK
  // cycle (null the bound asset) before deleting either side, then FK-safe: Asset -> RouteAction ->
  // RouteWaypoint -> Route -> Objective.
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.routeAction.updateMany({ where: { businessId }, data: { assetId: null } });
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

/** Drive one action all the way to a REAL verified send (bind asset -> approve -> execute -> complete + verified-live fact). */
async function driveToVerified(
  identity: { businessId: string }, actionId: string, channel: string, postedUrl: string, runId: string,
): Promise<void> {
  const { assetId } = await persistAsset(identity, { channel, kind: "post", content: { caption: "hi" }, routeActionId: actionId });
  await setActionAsset(identity, actionId, assetId);
  await approveAction(identity, { routeActionId: actionId, principal: "founder" });
  await startExecution(identity, { routeActionId: actionId, runId });
  await completeExecution(identity, { routeActionId: actionId });
  // The verified-send fact: a real live URL + verification timestamp — what makes an outcome node honest.
  await prisma.routeAction.update({ where: { id: actionId }, data: { verifiedAt: NOW, postedUrl } });
}

// ---- inv1 fixture handles ----
let outExecutedActionId: string, outProposedActionId: string;
let outMirror: Awaited<ReturnType<typeof mirrorPlanToGraph>>;

// ---- inv2/3/4 fixture handles ----
let readRouteId: string;      // 3 scrambled-creation-order waypoints; executed+verified + proposed action on the LAST
let readEmptyRouteId: string; // a route in the SAME tenant, NEVER mirrored (degrade + per-route scoping)

// ---- inv5 fixture handles ----
let concRouteId: string, concWp1Id: string;

describe("§15 stage-5b eval gate — recall is faithful, honest, budget-capped, scoped, concurrency-safe", () => {
  beforeAll(async () => {
    for (const t of ALL) await wipe(t.businessId);
    for (const t of ALL) await prisma.business.upsert({ where: { id: t.businessId }, create: { id: t.businessId, name: t.businessId }, update: {} });

    // inv1 — one route, one waypoint, TWO actions: one driven executed+verified, one left proposed.
    // Exactly one outcome node must result (the honesty gate).
    {
      const { objectiveId } = await createObjective(OUT, { kind: "growth", target: "1k signups", metric: "signups" });
      const { routeId } = await persistRoute(OUT, { objectiveId, source: "composed" });
      const { waypointId } = await persistWaypoint(OUT, { routeId, order: 1, title: "Launch", goal: "Go live" });
      ({ actionId: outExecutedActionId } = await upsertRouteAction(OUT, { waypointId, employeeRole: "cmo", type: "post", rationale: "ship it" }));
      ({ actionId: outProposedActionId } = await upsertRouteAction(OUT, { waypointId, employeeRole: "cto", type: "build", rationale: "later" }));
      await driveToVerified(OUT, outExecutedActionId, "instagram", OUT_POSTED_URL, "run_out_1");
      // outProposedActionId stays "proposed" — it must NOT earn an outcome node.
      outMirror = await mirrorPlanToGraph(OUT, routeId, NOW);
    }

    // inv2/3/4 — 3 waypoints inserted in SCRAMBLED creation order (Beta=2, Alpha=1, Gamma=3) with explicit
    // `order` values, so a createdAt-ordered traversal would yield a DIFFERENT sequence than the correct
    // order-based one — making the ancestor-path ORDER assertion load-bearing. The actions live on the LAST
    // waypoint (Gamma, the default anchor); the executed one (created first) carries the recalled outcome.
    {
      const { objectiveId } = await createObjective(READ, { kind: "growth", target: "1k signups", metric: "signups" });
      ({ routeId: readRouteId } = await persistRoute(READ, { objectiveId, source: "composed" }));
      await persistWaypoint(READ, { routeId: readRouteId, order: 2, title: "Beta", goal: "Reach beta" });
      await persistWaypoint(READ, { routeId: readRouteId, order: 1, title: "Alpha", goal: "Reach alpha" });
      const { waypointId: gamma } = await persistWaypoint(READ, { routeId: readRouteId, order: 3, title: "Gamma", goal: "Reach gamma" });
      const { actionId: readExecuted } = await upsertRouteAction(READ, { waypointId: gamma, employeeRole: "cmo", type: "post", rationale: "ship it" });
      await upsertRouteAction(READ, { waypointId: gamma, employeeRole: "cto", type: "build", rationale: "later" });
      await driveToVerified(READ, readExecuted, "instagram", READ_POSTED_URL, "run_read_1");
      await mirrorPlanToGraph(READ, readRouteId, NOW); // the WRITE; buildAgentContext then only READS.

      // A SECOND route in the SAME tenant, NEVER mirrored — the degrade case AND per-route scoping proof
      // (READ already has graph rows from readRouteId; this route's read must still be all-empty).
      const { objectiveId: emptyObj } = await createObjective(READ, { kind: "growth", target: "later", metric: "signups" });
      ({ routeId: readEmptyRouteId } = await persistRoute(READ, { objectiveId: emptyObj, source: "composed" }));
      await persistWaypoint(READ, { routeId: readEmptyRouteId, order: 1, title: "Unmirrored", goal: "No graph yet" });
    }

    // inv5 — a route with 2 waypoints, 1 action each (both proposed → no outcomes): 4 nodes, 3 edges.
    {
      const { objectiveId } = await createObjective(CONC, { kind: "growth", target: "500", metric: "signups" });
      ({ routeId: concRouteId } = await persistRoute(CONC, { objectiveId, source: "composed" }));
      ({ waypointId: concWp1Id } = await persistWaypoint(CONC, { routeId: concRouteId, order: 1, title: "C1", goal: "cg1" }));
      const { waypointId: cwp2 } = await persistWaypoint(CONC, { routeId: concRouteId, order: 2, title: "C2", goal: "cg2" });
      await upsertRouteAction(CONC, { waypointId: concWp1Id, employeeRole: "cmo", type: "post", rationale: "ca1" });
      await upsertRouteAction(CONC, { waypointId: cwp2, employeeRole: "cto", type: "build", rationale: "ca2" });
    }
  });

  // inv1 — OUTCOME HONESTY. Exactly ONE outcome node, keyed to the executed+verified action; its body is
  // the go-live FACT (the postedUrl) and NEVER a fabricated metric; it is TRUSTED (tainted:false); a
  // `caused` edge wires the action node → the outcome node. The proposed action earns NO outcome. Every
  // half is non-vacuous: the executed action genuinely reached executed+verified and the proposed one is
  // genuinely still proposed (read back from the DB), so the single outcome is a real honesty result.
  it("inv1 outcome honesty: an outcome exists ONLY for the executed+verified action, states the go-live URL (not a metric), is trusted, and is `caused` by its action; the proposed action has none", async () => {
    const biz = OUT.businessId;

    // preconditions — the executed action really went live+verified; the proposed one really did not.
    const executed = await prisma.routeAction.findUnique({ where: { id: outExecutedActionId } });
    expect(executed?.status).toBe("executed");
    expect(executed?.verifiedAt).not.toBeNull();
    const proposed = await prisma.routeAction.findUnique({ where: { id: outProposedActionId } });
    expect(proposed?.status).toBe("proposed");
    expect(proposed?.verifiedAt).toBeNull();

    // exactly ONE outcome node — from the mirror return AND from the DB.
    expect(outMirror.outcomeNodeIds).toHaveLength(1);
    expect(await prisma.memoryNode.count({ where: { businessId: biz, type: "outcome" } })).toBe(1);

    const outcome = await prisma.memoryNode.findUnique({ where: { id: outMirror.outcomeNodeIds[0] } });
    expect(outcome?.sourceId).toBe(outExecutedActionId); // keyed to the executed action, disambiguated from its action node by type
    expect(outcome?.title).toBe("went live on instagram"); // channel from the bound asset
    expect(outcome?.body).toBe(OUT_POSTED_URL);           // the live URL FACT, exactly
    expect(outcome?.tainted).toBe(false);                 // TRUSTED — our own verified send, not ingested content
    // honesty: the body invents no metric — no percentage and no measured-outcome word.
    expect(outcome?.body).not.toContain("%");
    expect(outcome?.body).not.toMatch(/\d+\s*%|\bengagement\b|\bimpressions\b|\bclicks\b|\breach\b|\blikes\b|\bviews\b|\bfollowers\b/i);

    // `caused` edge: the executed action node → the outcome node.
    const actionNode = await prisma.memoryNode.findFirst({ where: { businessId: biz, type: "action", sourceId: outExecutedActionId } });
    expect(actionNode).not.toBeNull();
    const causedEdge = await prisma.memoryEdge.findFirst({
      where: { businessId: biz, fromId: actionNode!.id, toId: outMirror.outcomeNodeIds[0], kind: "caused" } });
    expect(causedEdge).not.toBeNull();

    // the proposed action has NO outcome node (honesty gate blocks the un-executed action).
    const outcomeForProposed = await prisma.memoryNode.findFirst({ where: { businessId: biz, type: "outcome", sourceId: outProposedActionId } });
    expect(outcomeForProposed).toBeNull();
  });

  // inv2 — TRAVERSAL FAITHFUL + ORDERED. buildAgentContext reconstructs the ancestor path in the
  // RouteWaypoint.order sequence (Alpha, Beta, Gamma) — asserted as the exact ordered sequence, NOT merely
  // length 3 — even though the waypoints were CREATED in a scrambled order (a createdAt-ordered traversal
  // would return Beta, Alpha, Gamma and go RED). The anchor's (Gamma's) neighborhood carries its OWN
  // action (detail "ship it") and the executed action's recalled outcome (title + the postedUrl detail).
  it("inv2 traversal faithful + ordered: ancestorPath reconstructs the waypoint ORDER, and the anchor's neighborhood carries its actions + the executed action's outcome", async () => {
    const ctx = await buildAgentContext(READ, { routeId: readRouteId });

    // ORDERED ancestor path — the exact sequence, in RouteWaypoint.order (not creation order).
    expect(ctx.ancestorPath).toHaveLength(3);
    expect(ctx.ancestorPath.map((w) => w.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(ctx.ancestorPath).toEqual([
      { title: "Alpha", goal: "Reach alpha" },
      { title: "Beta", goal: "Reach beta" },
      { title: "Gamma", goal: "Reach gamma" },
    ]);

    // the anchor (Gamma) neighborhood — its own action AND the executed action's caused outcome.
    const kinds = ctx.neighborhood.map((n) => n.kind);
    expect(kinds).toContain("action");
    expect(kinds).toContain("outcome");
    const actionDetails = ctx.neighborhood.filter((n) => n.kind === "action").map((n) => n.detail);
    expect(actionDetails).toContain("ship it"); // Gamma's action rationale — proves it's THIS anchor's neighborhood
    const outcome = ctx.neighborhood.find((n) => n.kind === "outcome");
    expect(outcome?.title).toBe("went live on instagram");
    expect(outcome?.detail).toBe(READ_POSTED_URL); // the recalled verified-live URL
  });

  // inv3 — BUDGET CAP REAL. maxItems:1 hard-bounds the neighborhood to ONE item AND yields a strictly
  // shorter rendered text than the uncapped call (the cap drops the outcome's "Done:" line). The uncapped
  // call returns MORE than one item — the contrast makes the cap load-bearing: a bug that ignored maxItems
  // would return the same (>1) items and an equal-length text, turning BOTH assertions RED.
  it("inv3 budget cap real: maxItems:1 bounds the neighborhood to 1 item and a strictly shorter text than the uncapped call, which returns more", async () => {
    const capped = await buildAgentContext(READ, { routeId: readRouteId }, { maxItems: 1 });
    const uncapped = await buildAgentContext(READ, { routeId: readRouteId }); // default 12

    expect(capped.neighborhood).toHaveLength(1);              // hard cap on the item list
    expect(uncapped.neighborhood.length).toBeGreaterThan(1);  // action(s) + outcome — the cap has something to cut
    expect(capped.text.length).toBeLessThan(uncapped.text.length); // cap bounds the rendered text too
  });

  // inv4 — EMPTY-GRAPH DEGRADE. buildAgentContext on a route that EXISTS but was never mirrored returns an
  // all-empty context and does NOT throw (honest: no invented recall). Non-vacuous + per-route scoped: the
  // SAME tenant genuinely has graph rows (from readRouteId), so an all-empty result proves the read is
  // route-scoped and degrades cleanly — not that the tenant is simply empty.
  it("inv4 empty-graph degrade: a never-mirrored route yields an all-empty context (no throw), while the tenant's other route has real graph rows", async () => {
    // the tenant is NOT empty — the mirrored route left rows behind.
    expect(await prisma.memoryNode.count({ where: { businessId: READ.businessId } })).toBeGreaterThan(0);
    // the unmirrored route genuinely exists (a waypoint) but has zero mirror nodes.
    expect(await prisma.routeWaypoint.count({ where: { businessId: READ.businessId, routeId: readEmptyRouteId } })).toBeGreaterThan(0);

    const ctx = await buildAgentContext(READ, { routeId: readEmptyRouteId });
    expect(ctx).toEqual({ ancestorPath: [], neighborhood: [], learnings: [], text: "" });
  });

  // inv5 — CONCURRENCY-SAFE (5a precondition discharged). Two concurrent mirrors of the same route both
  // fulfil and leave EXACTLY the expected counts (4 nodes: 2 wp + 2 action; 3 edges: 1 next + 2 references)
  // — a broken @@unique/refetch would duplicate under the race. And a RAW duplicate create on the dedup key
  // (businessId, type, sourceId) is rejected by the DB @@unique (P2002) — deterministic proof the constraint
  // exists (SQLite's single writer may not force the race above).
  it("inv5 concurrency-safe: two concurrent mirrors leave exactly 4 nodes / 3 edges (no dup), and a raw duplicate (businessId,type,sourceId) is rejected by @@unique", async () => {
    const biz = CONC.businessId;

    const [a, b] = await Promise.allSettled([
      mirrorPlanToGraph(CONC, concRouteId, NOW),
      mirrorPlanToGraph(CONC, concRouteId, NOW),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");

    // exact counts — no duplicate nodes/edges despite two concurrent mirrors.
    expect(await prisma.memoryNode.count({ where: { businessId: biz } })).toBe(4); // 2 waypoint + 2 action
    expect(await prisma.memoryNode.count({ where: { businessId: biz, type: "waypoint" } })).toBe(2);
    expect(await prisma.memoryNode.count({ where: { businessId: biz, type: "action" } })).toBe(2);
    expect(await prisma.memoryEdge.count({ where: { businessId: biz } })).toBe(3); // 1 next + 2 references

    // deterministic constraint proof: a raw create with the SAME (businessId, type, sourceId) as a mirrored
    // waypoint node is rejected by @@unique([businessId, type, sourceId]).
    await expect(
      prisma.memoryNode.create({ data: { businessId: biz, type: "waypoint", title: "dup", body: "b", confidence: 1, sourceId: concWp1Id } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // ...and no duplicate slipped in for that key.
    expect(await prisma.memoryNode.count({ where: { businessId: biz, type: "waypoint", sourceId: concWp1Id } })).toBe(1);
  });

  // inv6 — SCOPED. buildAgentContext(GHOST, READ's routeId) is refused at the scoped route load
  // (/not found|scope/); the ghost tenant sees NONE of READ's graph. Non-vacuous: READ's route genuinely
  // has graph rows (a broken scope guard would surface them into the ghost's context), and the ghost tenant
  // EXISTS with a clean, zero-row starting state.
  it("inv6 scoped: a ghost tenant cannot buildAgentContext another tenant's route -> refused, and it holds zero graph rows", async () => {
    // ghost EXISTS and holds zero graph rows.
    expect(await prisma.memoryNode.count({ where: { businessId: GHOST.businessId } })).toBe(0);
    expect(await prisma.memoryEdge.count({ where: { businessId: GHOST.businessId } })).toBe(0);
    // READ's route has real graph rows to (illegally) surface — the non-vacuous target.
    expect(await prisma.memoryNode.count({ where: { businessId: READ.businessId, type: "waypoint" } })).toBeGreaterThan(0);

    await expect(buildAgentContext(GHOST, { routeId: readRouteId })).rejects.toThrow(/not found|scope/i);

    // still zero graph rows in the ghost tenant — nothing leaked or was written.
    expect(await prisma.memoryNode.count({ where: { businessId: GHOST.businessId } })).toBe(0);
  });

  // inv7 — WHITELIST UNTOUCHED. The traversal (buildAgentContext) and the graph writers
  // (mirrorPlanToGraph/persistMemoryNode/persistMemoryEdge) take an Identity first and are NOT
  // MCP-registered — no agent can trigger a graph read/write at 5b (a coordinator loop wiring them in is
  // 5c). The agent surface stays the exact 11 tools; the sorted 11 is pinned canonically by the stage-3c
  // lifecycle gate (test/lifecycle-eval.e2e.test.ts) — here we pin the count and the specific forbidden names.
  it("inv7 whitelist untouched: TOOL_SCHEMAS stays exactly 11 and exposes neither the traversal nor a graph writer", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    expect(toolNames).not.toContain("build_agent_context");
    expect(toolNames).not.toContain("persist_memory");
    expect(toolNames).not.toContain("persist_memory_node");
    expect(toolNames).not.toContain("persist_memory_edge");
    expect(toolNames).not.toContain("mirror_plan");
    expect(toolNames).not.toContain("mirror_plan_to_graph");
  });
});
