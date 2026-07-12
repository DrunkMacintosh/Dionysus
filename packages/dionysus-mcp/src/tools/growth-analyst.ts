// Stage 6c — the Growth Analyst's strategic layer (deterministic, no model call).
// Proposes a founder-gated route revision ONLY when the plan is measurably not working
// (verdict stalled / measured-flat) AND the evidence favors a channel (positive cited
// beliefs). NEVER-AUTO: it writes a `proposed` RouteRevision; decideRouteRevision applies.
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { buildCmoReport } from "./cmo-report.js";
import { scoreChannelCandidates } from "./recommend.js";
import { proposeRouteRevision } from "./route-revision.js";

export async function analyzeRouteForRevision(identity: Identity, now: Date): Promise<{ revisionId: string } | null> {
  const report = await buildCmoReport(identity, now);
  if (report.verdict.state !== "stalled" && report.verdict.state !== "measured-flat") return null;

  const route = await prisma.route.findFirst({ where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  if (!route) return null;
  const nextLocked = await prisma.routeWaypoint.findFirst({
    where: { businessId: identity.businessId, routeId: route.id, status: "locked" }, orderBy: { order: "asc" } });
  if (!nextLocked) return null;

  const [best] = await scoreChannelCandidates(identity);
  if (!best || best.cited.length === 0) return null; // never steer without positive evidence

  const verdictPhrase = report.verdict.state === "stalled"
    ? "The plan has stalled — nothing has gone live in weeks."
    : "Work is shipping but the number has not moved.";
  return proposeRouteRevision(identity, {
    routeId: route.id, waypointId: nextLocked.id,
    proposedGoal: `Lead with ${best.channel} — ${nextLocked.goal}`,
    rationale: `${verdictPhrase} The evidence favors ${best.channel}: ${best.cited.join(" ")}`,
  });
}
