// Stage 6a — the NIGHTLY WAKE (the D30 platform-trigger slice). One unattended routine
// per business: radar sensing (4e) + metric ingestion (5d), each BEST-EFFORT and
// independent, under the business's OWN ambient identity (D27.1). The sweep is the
// platform operator: it iterates businesses but never mixes tenants, and one business's
// failure NEVER blocks the next (per-business isolation, summary-reported).
// Budget stays fail-closed INSIDE runRadar (it throws before any model call when the
// gate refuses) — the nightly reports that as `failed` and moves on.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { ingestMetrics, metricTransportFromSafeFetch, type MetricTransport } from "dionysus-mcp/tools/analytics";
import type { Harness } from "./llm/types.js";
import type { HnTransport } from "./tools/hn-source.js";
import { runRadar } from "./run-radar.js";

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
export type NightlyBusinessResult = { businessId: string; radar: SectionResult; metrics: SectionResult };

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** One business's night: radar then metrics, each best-effort — never throws to the caller. */
export async function runNightly(identity: Identity, deps: NightlyDeps): Promise<NightlyBusinessResult> {
  const businessId = identity.businessId;

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

  return { businessId, radar, metrics };
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
        metrics: { status: "failed", reason: failureReason(error) } });
    }
  }
  return results;
}
