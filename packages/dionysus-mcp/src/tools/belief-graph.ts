import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { isUniqueViolation } from "./memory-graph.js";
import type { CraftBelief } from "../lib/belief.js";
import { canonicalFeatureKey, scoreCraftBelief, type FeatureEvidence } from "../lib/belief.js";

/** The stable idempotency key for a business's live belief about a (role, feature) pair. */
function beliefSourceId(role: string, featureKey: string): string {
  return `${role}::${featureKey}`;
}

/**
 * Persist a CRAFT belief as the single LIVE `learning` node for (businessId, role, featureKey),
 * found-or-created by sourceId. Corroboration (same stance) UPDATES the live node in place — zero
 * new rows. A stance FLIP (positive↔negative — a contradiction) snapshots the prior belief into a
 * superseded node and writes a `supersedes` edge (live → snapshot, spec §10 line 171), then updates
 * the live node to the new stance. neutral is not a contradiction (it only ever updates in place).
 * Belief nodes are TRUSTED (tainted:false) — our own summary of the founder's own actions.
 */
export async function persistCraftBelief(
  identity: Identity,
  input: { role: string; featureKey: string; belief: CraftBelief },
): Promise<{ beliefNodeId: string; superseded: boolean }> {
  const { role, featureKey, belief } = input;
  const sourceId = beliefSourceId(role, featureKey);
  const title = `${role} · ${featureKey}`;

  const existing = await prisma.memoryNode.findFirst({
    where: { businessId: identity.businessId, type: "learning", sourceId },
  });

  if (!existing) {
    try {
      const row = await prisma.memoryNode.create({
        data: {
          businessId: identity.businessId, type: "learning", role, waypointId: null,
          title, body: belief.summary, confidence: belief.confidence, stance: belief.stance,
          sourceId, tainted: false,
        },
      });
      return { beliefNodeId: row.id, superseded: false };
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        const row = await prisma.memoryNode.findFirst({ where: { businessId: identity.businessId, type: "learning", sourceId } });
        if (row) return { beliefNodeId: row.id, superseded: false };
      }
      throw error;
    }
  }

  const isFlip =
    (existing.stance === "positive" && belief.stance === "negative") ||
    (existing.stance === "negative" && belief.stance === "positive");

  let superseded = false;
  if (isFlip) {
    const snapshotCount = await prisma.memoryNode.count({
      where: { businessId: identity.businessId, type: "learning", sourceId: { startsWith: `${sourceId}::superseded::` } },
    });
    const snapshot = await prisma.memoryNode.create({
      data: {
        businessId: identity.businessId, type: "learning", role, waypointId: null,
        title: `${title} (superseded)`, body: existing.body, confidence: existing.confidence, stance: existing.stance,
        sourceId: `${sourceId}::superseded::${snapshotCount}`, tainted: false,
      },
    });
    await prisma.memoryEdge.create({
      data: { businessId: identity.businessId, fromId: existing.id, toId: snapshot.id, kind: "supersedes" },
    });
    superseded = true;
  }

  await prisma.memoryNode.update({
    where: { id: existing.id },
    data: { body: belief.summary, confidence: belief.confidence, stance: belief.stance, title },
  });
  return { beliefNodeId: existing.id, superseded };
}

/** Founder-acceptance classification of a single action into the evidence tally. */
function classifyAction(status: string, editDistance: number | null, rejectionCount: number): "acceptedAsIs" | "acceptedWithEdits" | "rejected" | "none" {
  if (status === "rejected" || rejectionCount > 0) return "rejected";
  if (status === "approved" || status === "executing" || status === "executed") {
    return editDistance && editDistance > 0 ? "acceptedWithEdits" : "acceptedAsIs";
  }
  return "none"; // proposed = no signal yet
}

/**
 * Derive CRAFT beliefs for a route: scan its actions (all statuses, scoped), group by
 * (employeeRole, canonicalFeatureKey), aggregate founder-acceptance evidence, score, and persist
 * the live belief per group. Each belief is wired by `informed-by` edges to the REAL action mirror
 * nodes it was derived from (honest, non-free-floating — the action nodes must already be mirrored;
 * draftWaypoint calls mirrorPlanToGraph first). Idempotent + scoped; a cross-tenant routeId throws
 * before any write. `now` drives recency decay (injected — never new Date() here).
 */
export async function deriveCraftBeliefs(
  identity: Identity, input: { routeId: string }, now: Date,
): Promise<{ beliefNodeIds: string[]; supersededCount: number }> {
  const route = await prisma.route.findFirst({ where: { id: input.routeId, businessId: identity.businessId } });
  if (!route) throw new Error(`Route ${input.routeId} not found in this business scope.`);

  const waypoints = await prisma.routeWaypoint.findMany({ where: { routeId: input.routeId, businessId: identity.businessId } });
  const waypointIds = waypoints.map((w) => w.id);
  const actions = waypointIds.length === 0 ? [] : await prisma.routeAction.findMany({
    where: { businessId: identity.businessId, waypointId: { in: waypointIds } } });

  type Group = { evidence: FeatureEvidence; actionIds: string[] };
  const groups = new Map<string, Group>();
  for (const action of actions) {
    const featureKey = canonicalFeatureKey(action.featuresJson);
    if (featureKey === "") continue;
    const cls = classifyAction(action.status, action.editDistance, action.rejectionCount);
    if (cls === "none") continue;
    const groupKey = `${action.employeeRole}::${featureKey}`;
    const group = groups.get(groupKey) ?? { evidence: { acceptedAsIs: 0, acceptedWithEdits: 0, rejected: 0, lastEventAt: null }, actionIds: [] };
    group.evidence[cls] += 1;
    if (!group.evidence.lastEventAt || action.createdAt > group.evidence.lastEventAt) group.evidence.lastEventAt = action.createdAt;
    group.actionIds.push(action.id);
    groups.set(groupKey, group);
  }

  const beliefNodeIds: string[] = [];
  let supersededCount = 0;
  for (const [groupKey, group] of groups) {
    const sep = groupKey.indexOf("::");
    const role = groupKey.slice(0, sep);
    const featureKey = groupKey.slice(sep + 2);
    const belief = scoreCraftBelief(group.evidence, now);
    const { beliefNodeId, superseded } = await persistCraftBelief(identity, { role, featureKey, belief });
    if (superseded) supersededCount += 1;
    beliefNodeIds.push(beliefNodeId);

    for (const actionId of group.actionIds) {
      const actionNode = await prisma.memoryNode.findFirst({ where: { businessId: identity.businessId, type: "action", sourceId: actionId } });
      if (!actionNode) continue;
      const existing = await prisma.memoryEdge.findFirst({ where: { businessId: identity.businessId, fromId: beliefNodeId, toId: actionNode.id, kind: "informed-by" } });
      if (existing) continue;
      try {
        await prisma.memoryEdge.create({ data: { businessId: identity.businessId, fromId: beliefNodeId, toId: actionNode.id, kind: "informed-by" } });
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  return { beliefNodeIds, supersededCount };
}

export type CraftBeliefView = { title: string; body: string; confidence: number; stance: string; role: string };

/**
 * The LIVE, non-superseded craft beliefs for the business (optionally role-filtered), ordered by
 * confidence desc. Superseded snapshots are excluded via the "::superseded::" sourceId marker.
 * Scoped read, no writes.
 */
export async function listCraftBeliefs(identity: Identity, opts?: { role?: string; limit?: number }): Promise<CraftBeliefView[]> {
  const nodes = await prisma.memoryNode.findMany({
    where: {
      businessId: identity.businessId, type: "learning",
      NOT: { sourceId: { contains: "::superseded::" } },
      ...(opts?.role ? { role: opts.role } : {}),
    },
    orderBy: { confidence: "desc" },
    take: opts?.limit ?? 50,
  });
  return nodes.map((n) => ({ title: n.title, body: n.body, confidence: n.confidence, stance: n.stance ?? "neutral", role: n.role ?? "" }));
}
