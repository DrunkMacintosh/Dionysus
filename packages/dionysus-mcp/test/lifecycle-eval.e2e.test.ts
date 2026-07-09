// §15 stage-3c eval gate — D29 lifecycle invariants under attack.
// Attacks: agent-asserted status (via the MCP tool surface), post-approval content swap,
// approval without content, duplicate waypoint order, garbage enum, cross-tenant approval.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { TOOL_SCHEMAS } from "../src/server.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction, startExecution, completeExecution } from "../src/tools/lifecycle.js";

const A = { businessId: "biz_lceval" };

beforeAll(async () => {
  await prisma.asset.deleteMany({ where: { businessId: A.businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId: A.businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: A.businessId } });
  await prisma.route.deleteMany({ where: { businessId: A.businessId } });
  await prisma.objective.deleteMany({ where: { businessId: A.businessId } });
  await prisma.business.upsert({ where: { id: A.businessId }, create: { id: A.businessId, name: "LcEval" }, update: {} });
});

describe("§15 stage-3c eval gate — D29 under attack", () => {
  it("no agent-reachable path can assert a status: the MCP tool surface exposes no approve/reject/execute tool and no status input on upsert_route_action", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    for (const forbidden of ["approve", "reject", "execute", "transition"]) {
      expect(toolNames.some((n) => n.includes(forbidden))).toBe(false);
    }
    expect(Object.keys(TOOL_SCHEMAS.upsert_route_action)).not.toContain("status");
  });

  it("full lifecycle through the REAL tool functions: draft-bind -> approve -> execute -> complete; then the tamper attack is refused end-to-end", async () => {
    // build the chain with the real (hardened) tools, not raw prisma
    const { objectiveId } = await createObjective(A, { kind: "signups", target: "100", metric: "users" });
    const { routeId } = await persistRoute(A, { objectiveId, source: "case" });
    const { waypointId } = await persistWaypoint(A, { routeId, order: 1, title: "Launch", goal: "20 signups" });
    const { actionId } = await upsertRouteAction(A, { waypointId, employeeRole: "copywriter", type: "post", rationale: "launch post" });

    const { assetId } = await persistAsset(A, { channel: "hackernews", kind: "post", content: { title: "Show HN", body: "We built X" }, routeActionId: actionId });
    await setActionAsset(A, actionId, assetId);

    await approveAction(A, { routeActionId: actionId, principal: "founder@example.com" });
    await startExecution(A, { routeActionId: actionId, runId: "run_ok" });
    await completeExecution(A, { routeActionId: actionId });
    const done = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(done!.status).toBe("executed");

    // attack: a second action, approved, then the asset content is swapped before send
    const { actionId: victim } = await upsertRouteAction(A, { waypointId, employeeRole: "copywriter", type: "post" });
    const bound = await persistAsset(A, { channel: "x", kind: "post", content: { body: "the approved words" }, routeActionId: victim });
    await setActionAsset(A, victim, bound.assetId);
    await approveAction(A, { routeActionId: victim, principal: "founder@example.com" });
    await prisma.asset.update({ where: { id: bound.assetId }, data: { contentJson: JSON.stringify({ body: "EVIL swapped copy" }) } });
    await expect(startExecution(A, { routeActionId: victim, runId: "run_evil" })).rejects.toThrow(/hash mismatch/i);
    const blocked = await prisma.routeAction.findUnique({ where: { id: victim } });
    expect(blocked!.status).toBe("approved"); // refused, not corrupted
    expect(blocked!.runId).toBeNull();

    // bind-guard (post-brief hardening): an approved action refuses a fresh asset re-bind;
    // the original binding survives so the approved contentHash can never be moved out from under approval.
    const fresh = await persistAsset(A, { channel: "x", kind: "post", content: { body: "sneaky re-bind" }, routeActionId: victim });
    await expect(setActionAsset(A, victim, fresh.assetId)).rejects.toThrow(/not in "proposed" status/i);
    const stillBound = await prisma.routeAction.findUnique({ where: { id: victim } });
    expect(stillBound!.assetId).toBe(bound.assetId); // original binding intact, not the fresh asset
  });

  it("approval without content is impossible; duplicate order and garbage enum are rejected by the hardened tools", async () => {
    const { objectiveId } = await createObjective(A, { kind: "k", target: "1", metric: "m" });
    const { routeId } = await persistRoute(A, { objectiveId, source: "composed" });
    const { waypointId } = await persistWaypoint(A, { routeId, order: 1, title: "t", goal: "g" });
    const { actionId } = await upsertRouteAction(A, { waypointId, employeeRole: "copywriter", type: "post" });
    await expect(approveAction(A, { routeActionId: actionId, principal: "p" })).rejects.toThrow(/no bound asset/i);

    await expect(persistWaypoint(A, { routeId, order: 1, title: "dupe", goal: "g" })).rejects.toThrow(/unique/i);
    await expect(persistRoute(A, { objectiveId, source: "case", status: "garbage" as never })).rejects.toThrow(/invalid route status/i);
  });

  it("cross-tenant approval attack fails closed", async () => {
    await prisma.business.upsert({ where: { id: "biz_lceval_ghost" }, create: { id: "biz_lceval_ghost", name: "G" }, update: {} });
    const rows = await prisma.routeAction.findMany({ where: { businessId: A.businessId, status: "approved" } });
    expect(rows.length).toBeGreaterThan(0);
    await expect(approveAction({ businessId: "biz_lceval_ghost" }, { routeActionId: rows[0]!.id, principal: "ghost" }))
      .rejects.toThrow(/not found|scope/i);
  });
});
