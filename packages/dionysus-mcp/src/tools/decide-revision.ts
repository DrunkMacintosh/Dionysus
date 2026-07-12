// Stage 6c — decideRouteRevision: the founder-gated APPLY of a proposed route revision.
// Cockpit-tier, NON-MCP (a session-authed cockpit action, never a model tool). NEVER-AUTO:
// nothing applies without this explicit decision. Order IS the contract:
//   approve = guarded waypoint apply FIRST (still-locked-and-in-scope) → flip the revision
//   atomically → best-effort graph record (was/now/why node + mirror refresh + references edge).
// The RouteRevision row is already the durable was/now/why record, so the graph writes are
// best-effort (try/catch + console.error) — a graph failure never blocks the applied goal.
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { persistMemoryNode, persistMemoryEdge } from "./memory-graph.js";

export async function decideRouteRevision(
  identity: Identity,
  input: { revisionId: string; decision: "approved" | "rejected" },
  now: Date,
): Promise<{ applied: boolean }> {
  const businessId = identity.businessId;

  // 1. Scoped load of the PROPOSED revision — missing/decided/foreign is one indistinguishable
  //    not-found (no cross-tenant existence leak; a double-decide hits this too).
  const revision = await prisma.routeRevision.findFirst({
    where: { id: input.revisionId, businessId, status: "proposed" } });
  if (!revision) throw new Error(`Revision ${input.revisionId} not found or already decided in this business scope.`);

  // 2. Reject: atomic status flip, waypoint untouched.
  if (input.decision === "rejected") {
    await prisma.routeRevision.updateMany({
      where: { id: revision.id, businessId, status: "proposed" },
      data: { status: "rejected", decidedAt: now } });
    return { applied: false };
  }

  // 3. Approve — APPLY FIRST, guarded: the goal changes ONLY if the waypoint is still `locked`
  //    and in scope (atomic guard against a raced/advanced waypoint). count 0 → the revision
  //    STAYS proposed so the founder sees the failure honestly and can reject.
  const applied = await prisma.routeWaypoint.updateMany({
    where: { id: revision.waypointId, businessId, status: "locked" },
    data: { goal: revision.proposedGoal } });
  if (applied.count === 0) throw new Error(`Waypoint ${revision.waypointId} is no longer revisable (not locked/in-scope).`);

  // Flip the revision to approved UNCONDITIONALLY now the goal is applied: "goal applied ⟺
  // status approved" is the invariant. A racing reject that slipped between our proposed-load
  // and this flip loses — the applied goal IS an approval, and the record must say so (a
  // status-guarded flip here would leave goal-applied + status-rejected: an inconsistent record).
  await prisma.routeRevision.updateMany({
    where: { id: revision.id, businessId },
    data: { status: "approved", decidedAt: now } });

  // BEST-EFFORT graph record — the RouteRevision row is already durable, so a graph failure is
  // logged (console.error) and never blocks the applied goal. The record corrects, honestly:
  //   - a `revision` node carrying was → now → why;
  //   - the waypoint MIRROR node body refreshed to the new goal (recall must not cite the stale goal);
  //   - a `references` edge revision-node → waypoint-node when the mirror exists.
  try {
    const { nodeId: revisionNodeId } = await persistMemoryNode(identity, {
      type: "revision", title: "route revised",
      body: `Goal was: ${revision.priorGoal} → now: ${revision.proposedGoal}. Why: ${revision.rationale}`,
      waypointId: revision.waypointId, sourceId: revision.id, confidence: 1 });

    await prisma.memoryNode.updateMany({
      where: { businessId, type: "waypoint", sourceId: revision.waypointId },
      data: { body: revision.proposedGoal } });

    const waypointNode = await prisma.memoryNode.findFirst({
      where: { businessId, type: "waypoint", sourceId: revision.waypointId } });
    if (waypointNode) {
      await persistMemoryEdge(identity, { fromId: revisionNodeId, toId: waypointNode.id, kind: "references" });
    }
  } catch (error: unknown) {
    console.error("decideRouteRevision: best-effort graph record failed (revision applied + recorded)", error);
  }

  return { applied: true };
}
