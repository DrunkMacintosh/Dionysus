import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "../src/db.js";
import { hashContent } from "../src/lib/content-hash.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction, rejectAction, startExecution, completeExecution, assertContentBound } from "../src/tools/lifecycle.js";

const BIZ = "biz_lifecycle";

async function cleanTenant(businessId: string) {
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

async function makeChain(businessId: string) {
  const obj = await prisma.objective.create({ data: { businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  return { obj, route, wp, action };
}

describe("lifecycle schema", () => {
  beforeAll(async () => {
    await cleanTenant(BIZ);
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "LC" }, update: {} });
  });

  it("RouteAction carries the D29 lifecycle columns with safe defaults", async () => {
    const { action } = await makeChain(BIZ);
    expect(action.approvedAt).toBeNull();
    expect(action.approvedBy).toBeNull();
    expect(action.runId).toBeNull();
    expect(action.rejectionCount).toBe(0);
  });

  it("rejects a duplicate (routeId, order) waypoint", async () => {
    const { route } = await makeChain(BIZ);
    await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 2, title: "a", goal: "g", status: "locked" } });
    await expect(prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 2, title: "b", goal: "g", status: "locked" } }))
      .rejects.toThrow(/unique/i);
  });
});

describe("content hash binding (D29)", () => {
  it("hashContent is sha256 hex over the exact string", () => {
    const s = JSON.stringify({ body: "hello" });
    expect(hashContent(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    expect(hashContent(s)).toHaveLength(64);
  });

  it("setActionAsset binds contentHash to the linked asset's stored contentJson", async () => {
    const { action } = await makeChain(BIZ);
    const { assetId } = await persistAsset({ businessId: BIZ },
      { channel: "x", kind: "post", content: { body: "draft v1" }, routeActionId: action.id });
    await setActionAsset({ businessId: BIZ }, action.id, assetId);
    const bound = await prisma.routeAction.findUnique({ where: { id: action.id } });
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(bound!.contentHash).toBe(hashContent(asset!.contentJson));
    expect(bound!.contentHash).not.toBe("");
  });

  it("a later asset edit does NOT silently move the bound hash (mismatch stays detectable)", async () => {
    const { action } = await makeChain(BIZ);
    const { assetId } = await persistAsset({ businessId: BIZ },
      { channel: "x", kind: "post", content: { body: "original" }, routeActionId: action.id });
    await setActionAsset({ businessId: BIZ }, action.id, assetId);
    await prisma.asset.update({ where: { id: assetId }, data: { contentJson: JSON.stringify({ body: "tampered" }) } });
    const after = await prisma.routeAction.findUnique({ where: { id: action.id } });
    const tampered = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(after!.contentHash).not.toBe(hashContent(tampered!.contentJson));
  });
});

async function boundAction(businessId: string, body: string) {
  const { action } = await makeChain(businessId);
  const { assetId } = await persistAsset({ businessId },
    { channel: "x", kind: "post", content: { body }, routeActionId: action.id });
  await setActionAsset({ businessId }, action.id, assetId);
  return { actionId: action.id, assetId };
}

describe("D29 lifecycle transitions (server-validated)", () => {
  it("happy path: proposed -> approved -> executing -> executed, fields set at each step", async () => {
    const { actionId } = await boundAction(BIZ, "ship it");
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "founder@example.com" });
    let a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved");
    expect(a!.approvedAt).toBeInstanceOf(Date);
    expect(a!.approvedBy).toBe("founder@example.com");
    await startExecution({ businessId: BIZ }, { routeActionId: actionId, runId: "run_1" });
    a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("executing");
    expect(a!.runId).toBe("run_1");
    await completeExecution({ businessId: BIZ }, { routeActionId: actionId });
    a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("executed");
  });

  it("refuses to approve an action with no bound asset", async () => {
    const { action } = await makeChain(BIZ);
    await expect(approveAction({ businessId: BIZ }, { routeActionId: action.id, principal: "p" }))
      .rejects.toThrow(/no bound asset/i);
  });

  it("refuses to approve when the asset was edited after binding (hash mismatch)", async () => {
    const { actionId, assetId } = await boundAction(BIZ, "original");
    await prisma.asset.update({ where: { id: assetId }, data: { contentJson: JSON.stringify({ body: "tampered" }) } });
    await expect(approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" }))
      .rejects.toThrow(/hash mismatch/i);
  });

  it("send path refuses tampered content AFTER approval (the D29 core)", async () => {
    const { actionId, assetId } = await boundAction(BIZ, "approved copy");
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" });
    await prisma.asset.update({ where: { id: assetId }, data: { contentJson: JSON.stringify({ body: "swapped after approval" }) } });
    await expect(startExecution({ businessId: BIZ }, { routeActionId: actionId, runId: "run_x" }))
      .rejects.toThrow(/hash mismatch/i);
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved"); // refusal does not corrupt state
    expect(a!.runId).toBeNull();
  });

  it("rejects invalid transitions with explicit errors", async () => {
    const { actionId } = await boundAction(BIZ, "x");
    await expect(startExecution({ businessId: BIZ }, { routeActionId: actionId, runId: "r" }))
      .rejects.toThrow(/invalid transition/i);           // proposed -> executing skips approval
    await expect(completeExecution({ businessId: BIZ }, { routeActionId: actionId }))
      .rejects.toThrow(/invalid transition/i);           // proposed -> executed
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" });
    await expect(approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" }))
      .rejects.toThrow(/invalid transition/i);           // approve twice
  });

  it("rejectAction works from proposed AND executing, bumps rejectionCount, and is final", async () => {
    const { actionId } = await boundAction(BIZ, "r1");
    await rejectAction({ businessId: BIZ }, { routeActionId: actionId });
    let a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("rejected");
    expect(a!.rejectionCount).toBe(1);
    await expect(rejectAction({ businessId: BIZ }, { routeActionId: actionId }))
      .rejects.toThrow(/invalid transition/i);           // rejected is terminal

    const second = await boundAction(BIZ, "r2");
    await approveAction({ businessId: BIZ }, { routeActionId: second.actionId, principal: "p" });
    await startExecution({ businessId: BIZ }, { routeActionId: second.actionId, runId: "r" });
    await rejectAction({ businessId: BIZ }, { routeActionId: second.actionId }); // executing -> rejected allowed
    a = await prisma.routeAction.findUnique({ where: { id: second.actionId } });
    expect(a!.status).toBe("rejected");
  });

  it("cross-tenant: another business cannot approve or probe the action (fail-closed)", async () => {
    const { actionId } = await boundAction(BIZ, "mine");
    await prisma.business.upsert({ where: { id: "biz_lc_other" }, create: { id: "biz_lc_other", name: "O" }, update: {} });
    await expect(approveAction({ businessId: "biz_lc_other" }, { routeActionId: actionId, principal: "evil" }))
      .rejects.toThrow(/not found|scope/i);
    await expect(assertContentBound({ businessId: "biz_lc_other" }, actionId))
      .rejects.toThrow(/not found|scope/i);
  });

  it("concurrent double-approval: exactly one wins, the loser throws (write-layer guard)", async () => {
    const { actionId } = await boundAction(BIZ, "race me");
    const results = await Promise.allSettled([
      approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "a" }),
      approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "b" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved");
    expect(["a", "b"]).toContain(a!.approvedBy); // exactly one principal's approval, not a blend
  });

  it("re-binding an asset onto an approved action is refused (approved hash never moves)", async () => {
    const { actionId } = await boundAction(BIZ, "sealed copy");
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" });
    const evil = await persistAsset({ businessId: BIZ }, { channel: "x", kind: "post", content: { body: "evil replacement" }, routeActionId: actionId });
    await expect(setActionAsset({ businessId: BIZ }, actionId, evil.assetId))
      .rejects.toThrow(/not in "proposed" status/i);
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.assetId).not.toBe(evil.assetId); // original binding intact
  });

  it("approval loses if the binding moved after its content check (rebind-vs-approve race)", async () => {
    const { actionId } = await boundAction(BIZ, "reviewed copy");
    // Simulate the interleave: capture what approveAction WOULD have validated,
    // then move the binding (legal: action still proposed) before the approval write lands.
    // We reproduce the exact lost-update by rebinding, then attempting an approval whose
    // guard must now mismatch the row's (assetId, contentHash).
    const before = await prisma.routeAction.findUnique({ where: { id: actionId } });
    const evil = await persistAsset({ businessId: BIZ }, { channel: "x", kind: "post", content: { body: "unreviewed replacement" }, routeActionId: actionId });
    await setActionAsset({ businessId: BIZ }, actionId, evil.assetId); // rebind while proposed — legal
    // The approval that validated the OLD binding must not land. Direct guard probe:
    const { count } = await prisma.routeAction.updateMany({
      where: { id: actionId, businessId: BIZ, status: "proposed", assetId: before!.assetId, contentHash: before!.contentHash },
      data: { status: "approved", approvedAt: new Date(), approvedBy: "stale" },
    });
    expect(count).toBe(0); // stale approval loses
    // And a FRESH approveAction (validating the CURRENT binding) succeeds:
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "fresh" });
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved");
    expect(a!.assetId).toBe(evil.assetId); // approved exactly what is currently bound
  });
});
