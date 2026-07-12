// Stage 6b — PERFORMANCE beliefs: measured, direction-only correlations per feature.
// A belief forms ONLY from real MetricSnapshot readings bracketing a real verified send
// (baseline at/before the send; a reading inside the GROWTH_WINDOW after it). No connected
// source, or no bracketing pair → that send contributes NOTHING (no invented direction).
// Persisted via the existing persistCraftBelief under role "growth-analyst" — a distinct
// sourceId namespace (no craft collision) with supersede-on-flip and update-in-place free.
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { canonicalFeatureKey, scorePerformanceBelief, type DirectionEvidence } from "../lib/belief.js";
import { persistCraftBelief } from "./belief-graph.js";
import { getConnectedAnalytics } from "./integration.js";

export const GROWTH_WINDOW_DAYS = 7;
export const GROWTH_ROLE = "growth-analyst";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function derivePerformanceBeliefs(
  identity: Identity, now: Date,
): Promise<{ beliefNodeIds: string[]; supersededCount: number }> {
  const businessId = identity.businessId;
  // HONESTY GATE: no connected analytics source → no performance learning at all.
  const connected = await getConnectedAnalytics(identity);
  if (!connected) return { beliefNodeIds: [], supersededCount: 0 };

  const snapshots = await prisma.metricSnapshot.findMany({
    where: { businessId, metric: connected.metric }, orderBy: { capturedAt: "asc" } });
  if (snapshots.length < 2) return { beliefNodeIds: [], supersededCount: 0 };

  const sends = await prisma.routeAction.findMany({
    where: { businessId, status: "executed", verifiedAt: { not: null } } });

  // Group direction evidence by feature key. Each send needs a REAL bracketing pair that
  // brackets THIS send tightly (overlapping windows must not cross-contaminate): baseline =
  // the last snapshot at/before the send; after = the FIRST snapshot strictly after the send
  // and inside the window. (snapshots is ascending; find picks the earliest in-window reading.)
  const groups = new Map<string, DirectionEvidence>();
  for (const send of sends) {
    const featureKey = canonicalFeatureKey(send.featuresJson);
    if (featureKey === "") continue;
    const at = send.verifiedAt as Date;
    const windowEnd = new Date(at.getTime() + GROWTH_WINDOW_DAYS * DAY_MS);
    const baseline = [...snapshots].reverse().find((s) => s.capturedAt <= at);
    const after = snapshots.find((s) => s.capturedAt > at && s.capturedAt <= windowEnd);
    if (!baseline || !after || baseline.value <= 0) continue; // no real pair → no evidence
    const g = groups.get(featureKey) ?? { rose: 0, fell: 0, flat: 0, lastSendAt: null };
    if (after.value > baseline.value) g.rose += 1;
    else if (after.value < baseline.value) g.fell += 1;
    else g.flat += 1;
    if (!g.lastSendAt || at > g.lastSendAt) g.lastSendAt = at;
    groups.set(featureKey, g);
  }

  const beliefNodeIds: string[] = [];
  let supersededCount = 0;
  for (const [featureKey, evidence] of groups) {
    const belief = scorePerformanceBelief(evidence, now);
    const { beliefNodeId, superseded } = await persistCraftBelief(identity, { role: GROWTH_ROLE, featureKey, belief });
    if (superseded) supersededCount += 1;
    beliefNodeIds.push(beliefNodeId);
  }
  return { beliefNodeIds, supersededCount };
}
