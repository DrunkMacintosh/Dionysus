// Stage 6a/6b — the NIGHTLY WAKE (the D30 platform-trigger slice). One unattended routine
// per business, FOUR best-effort + independent sections in order: radar sensing (4e) →
// metric ingestion (5d) → LEARN (6b: refresh craft+performance beliefs, then recommend the
// next action — deterministic, never-auto) → DRAFTS (6b: draft the undrafted proposals so the
// founder wakes to a reviewable morning briefing). All under the business's OWN ambient
// identity (D27.1). The sweep is the platform operator: it iterates businesses but never mixes
// tenants, and one business's failure NEVER blocks the next (per-business isolation,
// summary-reported). Budget stays fail-closed INSIDE runRadar/draftWaypoint (they throw before
// any model call when the gate refuses) — the nightly reports that as `failed` and moves on.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { ingestMetrics, metricTransportFromSafeFetch, type MetricTransport } from "dionysus-mcp/tools/analytics";
import { deriveCraftBeliefs } from "dionysus-mcp/tools/belief-graph";
import { derivePerformanceBeliefs } from "dionysus-mcp/tools/performance-belief";
import { recommendNextAction } from "dionysus-mcp/tools/recommend";
import type { Harness } from "./llm/types.js";
import type { HnTransport } from "./tools/hn-source.js";
import { runRadar } from "./run-radar.js";
import { draftWaypoint } from "./draft-waypoint.js";

export type NightlyDeps = {
  harness: Harness;
  models: { brain: string };
  hnTransport?: HnTransport;         // test seam; production uses the real HN fetch
  metricTransport?: MetricTransport; // test seam; production defaults to the SSRF-guarded adapter
};
export type SectionResult =
  | { status: "ok"; detail: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };
export type NightlyBusinessResult = { businessId: string; radar: SectionResult; metrics: SectionResult; learn: SectionResult; drafts: SectionResult };

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** One business's night: radar → metrics → learn → drafts, each best-effort — never throws to the caller. */
export async function runNightly(identity: Identity, deps: NightlyDeps): Promise<NightlyBusinessResult> {
  const businessId = identity.businessId;
  // ONE clock for the whole night — the learn section's boundary time, matching draftWaypoint's
  // own injected `new Date()` so belief recency is measured against a single, consistent instant.
  const now = new Date();

  // RADAR — needs the business (its name is the sensing query) and an objective (the lens).
  // Proposals land on the LATEST route's active waypoint (runRadar's scoped lookup).
  let radar: SectionResult;
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  const objective = await prisma.objective.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" } });
  if (!business || !objective) {
    radar = { status: "skipped", reason: "no objective to sense against" };
  } else {
    const route = await prisma.route.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" } });
    try {
      const res = await runRadar(identity,
        { objective: `${objective.kind}: ${objective.target}`, query: business.name, ...(route ? { routeId: route.id } : {}) },
        { harness: deps.harness, models: deps.models, ...(deps.hnTransport ? { hnTransport: deps.hnTransport } : {}) });
      radar = { status: "ok", detail: `${res.observations.length} observation(s), ${res.proposedActionIds.length} proposal(s)` };
    } catch (error: unknown) {
      radar = { status: "failed", reason: failureReason(error) }; // incl. the budget fail-closed throw
    }
  }

  // METRICS — independent of radar; ingestMetrics itself skips when no source is connected.
  let metrics: SectionResult;
  try {
    const transport = deps.metricTransport ?? metricTransportFromSafeFetch();
    const { snapshotId } = await ingestMetrics(identity, { transport });
    metrics = snapshotId
      ? { status: "ok", detail: `snapshot ${snapshotId}` }
      : { status: "skipped", reason: "no connected source or no reading" };
  } catch (error: unknown) {
    metrics = { status: "failed", reason: failureReason(error) };
  }

  // LEARN — refresh craft + performance beliefs, then recommend the next action (deterministic,
  // never-auto). Runs AFTER metrics so tonight's fresh reading feeds the performance beliefs.
  // Beliefs need a route to scan; the recommendation needs an active waypoint —
  // recommendNextAction itself returns null when there is none.
  let learn: SectionResult;
  try {
    const routeForLearning = await prisma.route.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" } });
    if (!routeForLearning) {
      learn = { status: "skipped", reason: "no route to learn from" };
    } else {
      const craft = await deriveCraftBeliefs(identity, { routeId: routeForLearning.id }, now);
      const perf = await derivePerformanceBeliefs(identity, now);
      const rec = await recommendNextAction(identity);
      learn = rec
        ? { status: "ok", detail: `${craft.beliefNodeIds.length} craft + ${perf.beliefNodeIds.length} perf belief(s); recommended ${rec.channel}` }
        : { status: "skipped", reason: `beliefs refreshed (${craft.beliefNodeIds.length} craft, ${perf.beliefNodeIds.length} perf); no recommendation (no active waypoint or one already standing)` };
    }
  } catch (error: unknown) {
    learn = { status: "failed", reason: failureReason(error) };
  }

  // DRAFTS — the morning briefing: draft any undrafted proposals on the active waypoint so the
  // founder wakes to REVIEWABLE drafts (never-auto: they are still `proposed`). draftWaypoint is
  // budget-fail-closed FIRST and skips bound proposals (founder edits are sacred). Runs LAST so the
  // copywriter's recall sees the beliefs the learn section just refreshed.
  let drafts: SectionResult;
  try {
    const routeForDrafts = await prisma.route.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" } });
    const activeWp = routeForDrafts ? await prisma.routeWaypoint.findFirst({
      where: { businessId, routeId: routeForDrafts.id, status: "active" }, orderBy: { order: "asc" } }) : null;
    const undrafted = activeWp ? await prisma.routeAction.count({
      where: { businessId, waypointId: activeWp.id, status: "proposed", assetId: null } }) : 0;
    if (!activeWp || undrafted === 0) {
      drafts = { status: "skipped", reason: "nothing undrafted on the active waypoint" };
    } else {
      const res = await draftWaypoint(identity, { waypointId: activeWp.id }, { harness: deps.harness, models: deps.models });
      drafts = { status: "ok", detail: `${res.drafts.length} draft(s) ready for review` };
    }
  } catch (error: unknown) {
    drafts = { status: "failed", reason: failureReason(error) }; // incl. budget fail-closed
  }

  return { businessId, radar, metrics, learn, drafts };
}

/** The platform sweep: every business, each under its own identity, failures isolated. */
export async function runNightlySweep(deps: NightlyDeps): Promise<NightlyBusinessResult[]> {
  const businesses = await prisma.business.findMany();
  const results: NightlyBusinessResult[] = [];
  for (const b of businesses) {
    try {
      results.push(await runNightly({ businessId: b.id }, deps));
    } catch (error: unknown) {
      // runNightly is itself best-effort; this is the belt-and-suspenders isolation layer.
      results.push({ businessId: b.id,
        radar: { status: "failed", reason: failureReason(error) },
        metrics: { status: "failed", reason: failureReason(error) },
        learn: { status: "failed", reason: failureReason(error) },
        drafts: { status: "failed", reason: failureReason(error) } });
    }
  }
  return results;
}
