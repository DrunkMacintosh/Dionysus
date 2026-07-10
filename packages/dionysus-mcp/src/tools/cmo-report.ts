import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { gradeObjective, STALL_WEEKS, type ObjectiveStats, type Verdict } from "../lib/cmo-verdict.js";
import { listObservations } from "./memory.js";

// ---------------------------------------------------------------------------
// buildCmoReport — D27.1 identity-scoped weekly assembly wired to the honesty
// grader (§3 / D21 / D31).
//
// NOT MCP-registered (whitelist stays 11): like the review reads, this is a
// cockpit-tier read, never an agent-assertable tool.
//
// The CLOCK enters ONLY through `now`. Every window (this-week, stall-window)
// is derived from `now`, never from wall-clock, so the report is deterministic
// and testable with a fixed clock + backdated rows.
//
// HONESTY (§3 / D21): at 4f `analyticsConnected` is hardcoded false, so the
// grader's measured branch is unreachable and every verdict is an unmeasured
// state that LEADS with the measurement gap. The report never claims the
// objective's metric moved.
// ---------------------------------------------------------------------------

export type CmoReport = {
  weekOf: string; // ISO date (YYYY-MM-DD) of the week start (now - 7d), UTC day
  objective: { kind: string; target: string; metric: string; status: string } | null;
  whatRan: Array<{
    actionId: string;
    channel: string | null;
    title: string | null;
    postedUrl: string | null;
    verifiedAt: Date;
  }>; // verified sends in the last 7d, newest-first
  inFlight: number; // approved + executing
  proposedPending: number; // proposed drafts with a bound asset, awaiting review
  radarNoticed: Array<{ title: string; sourceUrl: string | null; confidence: number }>; // observations in the last 7d
  churnThisWeek: number; // sum of editDistance on actions touched this week (D22)
  verdict: Verdict; // from gradeObjective
  analyticsConnected: boolean; // false at 4f
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// listObservations is newest-first; a week's radar is bounded, but scan a
// generous window so a busy business is never silently truncated inside it.
const RADAR_SCAN_LIMIT = 200;

/** Defensive parse (the 4b parsed-null lesson): only a real object yields a title. */
function parseTitle(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      const title = (parsed as Record<string, unknown>).title;
      if (typeof title === "string") return title;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Post-substitute the objective's metric NAME into the verdict headline IF the
 * grader left an explicit `{metric}` placeholder. The current grader is
 * metric-agnostic ("your number") and emits no placeholder, so this is a
 * pass-through at 4f — it exists so a future (stage-5) headline can be
 * personalised WITHOUT this code ever fabricating a metric MOVE. Immutable:
 * returns a new verdict, never mutates the grader's output.
 */
function applyMetricName(verdict: Verdict, metric: string | null): Verdict {
  if (!metric || !verdict.headline.includes("{metric}")) return verdict;
  return { ...verdict, headline: verdict.headline.replaceAll("{metric}", metric) };
}

export async function buildCmoReport(identity: Identity, now: Date): Promise<CmoReport> {
  const businessId = identity.businessId;
  const weekStart = new Date(now.getTime() - WEEK_MS);
  const recentStart = new Date(now.getTime() - STALL_WEEKS * WEEK_MS);

  // objective = latest by createdAt (scoped).
  const objectiveRow = await prisma.objective.findFirst({
    where: { businessId },
    orderBy: { createdAt: "desc" },
  });

  // weeksActive = whole weeks since the earliest Route.createdAt (0 if no route).
  const earliestRoute = await prisma.route.findFirst({
    where: { businessId },
    orderBy: { createdAt: "asc" },
  });
  const weeksActive = earliestRoute
    ? Math.max(0, Math.floor((now.getTime() - earliestRoute.createdAt.getTime()) / WEEK_MS))
    : 0;

  // Executed sends: counted by verifiedAt across three windows (lifetime / stall / week).
  const executed = await prisma.routeAction.findMany({
    where: { businessId, status: "executed" },
    orderBy: { verifiedAt: "desc" },
  });
  const executedTotal = executed.length;
  const executedRecent = executed.filter((a) => a.verifiedAt !== null && a.verifiedAt >= recentStart).length;
  const executedInWeek = executed.filter((a) => a.verifiedAt !== null && a.verifiedAt >= weekStart);
  const executedThisWeek = executedInWeek.length;

  // whatRan = in-week verified sends (already newest-first) joined to their asset.
  const assetIds = executedInWeek
    .map((a) => a.assetId)
    .filter((id): id is string => id !== null);
  const assets = assetIds.length
    ? await prisma.asset.findMany({ where: { businessId, id: { in: assetIds } } })
    : [];
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const whatRan = executedInWeek.map((a) => {
    const asset = a.assetId ? assetById.get(a.assetId) : undefined;
    return {
      actionId: a.id,
      channel: asset ? asset.channel : null,
      title: asset ? parseTitle(asset.contentJson) : null,
      postedUrl: a.postedUrl ?? null,
      verifiedAt: a.verifiedAt as Date, // in-week filter guarantees non-null
    };
  });

  const inFlight = await prisma.routeAction.count({
    where: { businessId, status: { in: ["approved", "executing"] } },
  });
  const proposedPending = await prisma.routeAction.count({
    where: { businessId, status: "proposed", assetId: { not: null } },
  });

  // radarNoticed = market-observation MemoryNodes created in the last 7d.
  const observations = await listObservations(identity, RADAR_SCAN_LIMIT);
  const radarNoticed = observations
    .filter((o) => o.createdAt >= weekStart)
    .map((o) => ({ title: o.title, sourceUrl: o.sourceUrl, confidence: o.confidence }));

  // churnThisWeek = sum of editDistance over actions created in the last 7d (D22).
  const churn = await prisma.routeAction.aggregate({
    where: { businessId, createdAt: { gte: weekStart } },
    _sum: { editDistance: true },
  });
  const churnThisWeek = churn._sum.editDistance ?? 0;

  // §3 honesty seam: analytics is stage 5. Hardcoded false here.
  // TODO stage-5: analyticsConnected = (count(Integration where kind=analytics) > 0).
  const analyticsConnected = false;

  const stats: ObjectiveStats = {
    weeksActive,
    executedTotal,
    executedRecent,
    executedThisWeek,
    inFlight,
    proposedPending,
    analyticsConnected,
    // metricDeltaPct stays undefined at 4f — no connected source to measure a delta.
  };
  const verdict = applyMetricName(gradeObjective(stats), objectiveRow?.metric ?? null);

  return {
    weekOf: weekStart.toISOString().slice(0, 10),
    objective: objectiveRow
      ? {
          kind: objectiveRow.kind,
          target: objectiveRow.target,
          metric: objectiveRow.metric,
          status: objectiveRow.status,
        }
      : null,
    whatRan,
    inFlight,
    proposedPending,
    radarNoticed,
    churnThisWeek,
    verdict,
    analyticsConnected,
  };
}
