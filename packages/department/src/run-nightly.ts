// Stage 6a/6b/6c/6e/6f/6g/6h/6k — the NIGHTLY WAKE (the D30 platform-trigger slice). One unattended routine
// per business, TEN best-effort + independent sections in order: PLAN (6f: the bootstrap — a
// founder-stated objective with no route yet gets its FIRST route proposed from the best
// discovered case, so it runs BEFORE the rest can see the new route) → radar sensing (4e) →
// metric ingestion (5d) → LEARN (6b: refresh craft+performance beliefs, then recommend the
// next action — deterministic, never-auto) → STRATEGY (6c: propose a founder-gated route
// revision when the plan measurably stalls) → CRO (6e: on the measured-flat signal, the page
// may be the leak — the Conversion Optimizer audits the founder's OWN landing page for fixes) →
// SEO (6h: the SEO/AEO Strategist runs a fully DETERMINISTIC on-page audit of the founder's own
// page — zero model calls by construction, page-change deduped) →
// OUTREACH (6g: draft the founder's pending pitch requests, each grounded in the target's page —
// founder-targeted only, never invents a target) → VIDEO (6k: the Videographer's generation phase,
// two-gate — a founder-APPROVED storyboard becomes a generated video via a connected video
// Integration + an injected transport, landing as a NEW proposed video-post the founder reviews
// before posting; honest skip without a source or transport) → DRAFTS (6b: draft the undrafted
// proposals so the founder wakes to a reviewable morning briefing). CRO, SEO, OUTREACH and VIDEO run
// BEFORE drafts on purpose: they persist COMPLETE (asset-bound) proposals, so the drafts section's
// assetless-only filter never re-drafts a CRO finding, an SEO audit, an outreach pitch or a video. All under the
// business's OWN ambient identity (D27.1). The sweep is the platform operator: it iterates
// businesses but never mixes tenants, and one business's failure NEVER blocks the next
// (per-business isolation, summary-reported). Budget stays fail-closed INSIDE
// runRadar/draftWaypoint/runCro (they throw before any model call when the gate refuses) — the
// nightly reports that as `failed` and moves on. The night ENDS by writing its VERBATIM activity
// record (6j), best-effort — the diary never fails the night.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { ingestMetrics, metricTransportFromSafeFetch, type MetricTransport } from "dionysus-mcp/tools/analytics";
import { deriveCraftBeliefs } from "dionysus-mcp/tools/belief-graph";
import { derivePerformanceBeliefs } from "dionysus-mcp/tools/performance-belief";
import { recommendNextAction } from "dionysus-mcp/tools/recommend";
import { analyzeRouteForRevision } from "dionysus-mcp/tools/growth-analyst";
import { buildCmoReport } from "dionysus-mcp/tools/cmo-report";
import { recordNightlyRun } from "dionysus-mcp/tools/nightly-run";
import type { SafeFetchOptions } from "dionysus-mcp/lib/ssrf";
import type { Harness } from "./llm/types.js";
import type { HnTransport } from "./tools/hn-source.js";
import { runRadar } from "./run-radar.js";
import { runCro } from "./run-cro.js";
import { runSeo } from "./run-seo.js";
import { runOutreach } from "./run-outreach.js";
import { runVideoGen, type VideoGenTransport } from "./run-video-gen.js";
import { draftWaypoint } from "./draft-waypoint.js";
import { proposeRoute } from "./propose-route.js";

export type NightlyDeps = {
  harness: Harness;
  models: { brain: string };
  hnTransport?: HnTransport;         // test seam; production uses the real HN fetch
  metricTransport?: MetricTransport; // test seam; production defaults to the SSRF-guarded adapter
  croFetchOpts?: SafeFetchOptions;   // test seam; production uses the real SSRF-guarded page fetch
  seoFetchOpts?: SafeFetchOptions;   // test seam; production uses the real SSRF-guarded page fetch (zero-model audit)
  outreachFetchOpts?: SafeFetchOptions; // test seam; production uses the real SSRF-guarded target-page fetch
  videoGenTransport?: VideoGenTransport; // test seam; production defaults to the deferred Kling adapter (absent → the video section skips)
};
export type SectionResult =
  | { status: "ok"; detail: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };
export type NightlyBusinessResult = { businessId: string; plan: SectionResult; radar: SectionResult; metrics: SectionResult; learn: SectionResult; strategy: SectionResult; cro: SectionResult; seo: SectionResult; outreach: SectionResult; video: SectionResult; drafts: SectionResult };

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** One business's night: plan → radar → metrics → learn → strategy → cro → seo → outreach → video → drafts, each best-effort — never throws to the caller. */
export async function runNightly(identity: Identity, deps: NightlyDeps): Promise<NightlyBusinessResult> {
  const businessId = identity.businessId;
  // ONE clock for the whole night — the learn section's boundary time, matching draftWaypoint's
  // own injected `new Date()` so belief recency is measured against a single, consistent instant.
  const now = new Date();

  // PLAN — the bootstrap: a founder-stated objective with NO route yet gets its FIRST route
  // proposed from the best discovered case (proposed, never-auto — the same night's later
  // sections draft waypoint 1, so the morning briefing arrives complete). Runs ONCE: any
  // existing route suppresses (re-planning is the Growth Analyst's job, 6c). Runs FIRST so the
  // same night's radar/learn/strategy/cro/drafts all see the new route.
  let plan: SectionResult;
  try {
    const objective = await prisma.objective.findFirst({
      where: { businessId, status: "active" }, orderBy: { createdAt: "desc" } });
    const existingRoute = await prisma.route.findFirst({ where: { businessId } });
    if (!objective) {
      plan = { status: "skipped", reason: "no objective yet — set one on /setup" };
    } else if (existingRoute) {
      plan = { status: "skipped", reason: "a route already exists (re-planning is the Growth Analyst's job)" };
    } else {
      const topCase = await prisma.case.findFirst({ where: { businessId }, orderBy: { rank: "asc" } });
      if (!topCase) {
        plan = { status: "skipped", reason: "no discovered cases — run discovery first" };
      } else {
        const routePlan = await proposeRoute(identity,
          { objective: { kind: objective.kind, target: objective.target, metric: objective.metric },
            caseId: topCase.id, existingObjectiveId: objective.id },
          { harness: deps.harness, models: deps.models });
        plan = { status: "ok", detail: `route proposed from case "${topCase.name}" — ${routePlan.waypoints.length} waypoint(s)` };
      }
    }
  } catch (error: unknown) {
    plan = { status: "failed", reason: failureReason(error) }; // incl. budget fail-closed throw
  }

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

  // STRATEGY — the Growth Analyst: propose a founder-gated route revision when the plan is
  // measurably not working AND the evidence favors a channel. Deterministic, never-auto.
  // Runs AFTER learn (on tonight's fresh beliefs) and BEFORE drafts (a future revision-driven
  // draft sees it). Reuses the single `now`.
  let strategy: SectionResult;
  try {
    const res = await analyzeRouteForRevision(identity, now);
    strategy = res
      ? { status: "ok", detail: `route revision proposed (${res.revisionId})` }
      : { status: "skipped", reason: "plan working/young, no evidence target, or a revision already standing" };
  } catch (error: unknown) {
    strategy = { status: "failed", reason: failureReason(error) };
  }

  // CRO — the page may be the leak, not the posts. Runs ONLY on the traffic-without-conversion
  // signal (verdict measured-flat), with one-standing + product-URL gating inside runCro itself
  // plus the verdict gate here. Deterministic trigger; the model call is budget-gated in runCro.
  // Runs AFTER strategy and BEFORE drafts: runCro persists COMPLETE (asset-bound) cro-fix
  // proposals, so the drafts section's assetless-only filter never re-drafts them.
  let cro: SectionResult;
  try {
    const report = await buildCmoReport(identity, now); // reuses the single night clock
    if (report.verdict.state !== "measured-flat") {
      cro = { status: "skipped", reason: "no traffic-without-conversion signal" };
    } else {
      const res = await runCro(identity, { harness: deps.harness, models: deps.models, ...(deps.croFetchOpts ? { fetchOpts: deps.croFetchOpts } : {}) });
      cro = res.status === "ok"
        ? { status: "ok", detail: `${res.actionIds.length} finding(s) queued, ${res.dropped} dropped` }
        : { status: "skipped", reason: res.reason };
    }
  } catch (error: unknown) {
    cro = { status: "failed", reason: failureReason(error) }; // incl. the budget fail-closed throw
  }

  // SEO — deterministic on-page audit of the founder's own page (D25). Zero
  // model calls by construction (runSeo takes no harness); no budget gate.
  // Runs AFTER cro and BEFORE outreach/drafts: runSeo persists a COMPLETE (asset-bound)
  // seo-audit proposal, so the drafts section's assetless-only filter never re-drafts it.
  let seo: SectionResult;
  try {
    const res = await runSeo(identity, deps.seoFetchOpts ? { fetchOpts: deps.seoFetchOpts } : {});
    seo = res.status === "ok"
      ? { status: "ok", detail: `audit drafted: ${res.fail} fail, ${res.warn} warn` }
      : { status: "skipped", reason: res.reason };
  } catch (error: unknown) {
    seo = { status: "failed", reason: failureReason(error) };
  }

  // OUTREACH — draft the founder's pending pitch requests, grounded in each target's page.
  // Founder-targeted only: this drafts EXISTING requests; no model call ever invents a target.
  // Runs AFTER cro and BEFORE drafts: runOutreach persists COMPLETE (asset-bound) outreach-pitch
  // proposals, so the drafts section's assetless-only filter never re-drafts one (and draftWaypoint
  // excludes the type outright). Pending-check precedes the budget gate inside runOutreach — a
  // no-request night makes zero model/fetch noise; a budget refusal throws and is reported failed.
  let outreach: SectionResult;
  try {
    const res = await runOutreach(identity, { harness: deps.harness, models: deps.models, ...(deps.outreachFetchOpts ? { fetchOpts: deps.outreachFetchOpts } : {}) });
    outreach = res.status === "ok"
      ? { status: "ok", detail: `${res.drafted.length} pitch(es) drafted, ${res.skipped} skipped, ${res.dropped} dropped (ungrounded)${res.remaining > 0 ? `, ${res.remaining} pending (cap)` : ""}` }
      : { status: "skipped", reason: res.reason };
  } catch (error: unknown) {
    outreach = { status: "failed", reason: failureReason(error) };
  }

  // VIDEO — the Videographer's generation phase (6k, two-gate): approved
  // storyboards become generated videos, landing as NEW proposed video-post
  // drafts. Honest skips without a connected source or transport. Runs AFTER
  // outreach and BEFORE drafts: it persists COMPLETE (asset-bound) video-post
  // proposals, so the drafts section's assetless-only filter never re-drafts one
  // (and draftWaypoint excludes the type outright). The transport is injected
  // (the Kling seam); absent in production until the founder-keyed follow-up, so
  // the section skips honestly. Budget refusal throws inside runVideoGen and is
  // reported failed.
  let video: SectionResult;
  try {
    const res = await runVideoGen(identity, deps.videoGenTransport ? { transport: deps.videoGenTransport } : {});
    video = res.status === "ok"
      ? { status: "ok", detail: `${res.generated.length} video(s) generated, ${res.skippedItems} skipped${res.awaiting > 0 ? `, ${res.awaiting} awaiting (cap)` : ""}` }
      : { status: "skipped", reason: res.reason };
  } catch (error: unknown) {
    video = { status: "failed", reason: failureReason(error) };
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

  const result = { businessId, plan, radar, metrics, learn, strategy, cro, seo, outreach, video, drafts };

  // 6j — the activity diary: persist the night's section results VERBATIM so the
  // founder can see what ran, what was skipped, and why (/activity). BEST-EFFORT:
  // the diary must never fail the night — a record failure is logged and swallowed.
  // The section map is DERIVED from `result` (not re-listed) so a future tenth
  // section can never drift between the diary and the return value.
  const { businessId: _recordedBusinessId, ...sections } = result;
  try {
    await recordNightlyRun(identity, { sections });
  } catch (error: unknown) {
    console.error(`nightly: activity record failed (${failureReason(error)}) — the night's work is unaffected.`);
  }

  return result;
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
        plan: { status: "failed", reason: failureReason(error) },
        radar: { status: "failed", reason: failureReason(error) },
        metrics: { status: "failed", reason: failureReason(error) },
        learn: { status: "failed", reason: failureReason(error) },
        strategy: { status: "failed", reason: failureReason(error) },
        cro: { status: "failed", reason: failureReason(error) },
        seo: { status: "failed", reason: failureReason(error) },
        outreach: { status: "failed", reason: failureReason(error) },
        video: { status: "failed", reason: failureReason(error) },
        drafts: { status: "failed", reason: failureReason(error) } });
    }
  }
  return results;
}
