// Stage 6b — the deterministic next-action recommender (spec §16 mechanism 4: explore/exploit).
// NO model call: score = Σ(stanceSign × confidence × roleWeight) per channel — performance
// beliefs (growth-analyst, REAL measured outcomes) weigh 2× craft beliefs per the spec's
// Priming rule — plus an EXPLORE bonus for channels with no evidence yet. The winner becomes
// ONE `proposed` RouteAction (never-auto, D27.2) whose rationale CITES the beliefs it acted
// on (explainable attribution, D16). One standing recommendation at a time.
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { upsertRouteAction } from "./plan.js";
import { GROWTH_ROLE } from "./performance-belief.js";

export const EXPLORE_BONUS = 0.3;
export const PERF_WEIGHT = 2;
export const CRAFT_WEIGHT = 1;
export const DEFAULT_EXPLORE_CHANNELS = ["hackernews"];

export type Recommendation = { actionId: string; channel: string; reason: string };
export type ChannelCandidate = { channel: string; score: number; cited: string[]; hasEvidence: boolean };

function stanceSign(stance: string | null): number {
  return stance === "positive" ? 1 : stance === "negative" ? -1 : 0;
}

/**
 * Deterministic evidence scorer over channel candidates (this business's action-history
 * channels + the default explore set). score = Σ(stanceSign × confidence × roleWeight) per
 * channel — performance beliefs weigh 2× craft; an evidence-free channel gets the EXPLORE
 * bonus. Returns EVERY candidate sorted best-first (score desc, then channel asc — the same
 * order the alphabetical-first-wins loop produced). Scoped read, no writes; the winner is
 * `[0]`. Extracted (DRY) so the Growth Analyst can reuse the same honest scoring.
 */
export async function scoreChannelCandidates(identity: Identity): Promise<ChannelCandidate[]> {
  const businessId = identity.businessId;

  // Candidates: channels seen in this business's history + the default explore set.
  const actions = await prisma.routeAction.findMany({ where: { businessId } });
  const channels = new Set<string>(DEFAULT_EXPLORE_CHANNELS);
  for (const a of actions) {
    try {
      const f = JSON.parse(a.featuresJson) as { channel?: unknown };
      if (typeof f.channel === "string" && f.channel) channels.add(f.channel);
    } catch { /* malformed features contribute no candidate */ }
  }

  // Live (non-superseded) beliefs, scored per channel.
  const beliefs = await prisma.memoryNode.findMany({
    where: { businessId, type: "learning", NOT: { sourceId: { contains: "::superseded::" } } },
    orderBy: { sourceId: "asc" } }); // deterministic cited-body join order in the rationale (channel sum is commutative)
  const candidates: ChannelCandidate[] = [];
  for (const channel of [...channels].sort()) { // alphabetical order → deterministic tie-break (first wins)
    const key = `channel=${channel}`;
    const mine = beliefs.filter((b) => b.sourceId === `copywriter::${key}` || b.sourceId === `${GROWTH_ROLE}::${key}`);
    let score = 0;
    const cited: string[] = [];
    for (const b of mine) {
      const weight = b.role === GROWTH_ROLE ? PERF_WEIGHT : CRAFT_WEIGHT;
      score += stanceSign(b.stance) * b.confidence * weight;
      if (b.stance === "positive") cited.push(b.body);
    }
    if (mine.length === 0) score += EXPLORE_BONUS; // evidence-free → worth exploring
    candidates.push({ channel, score, cited, hasEvidence: mine.length > 0 });
  }
  // best-first: score desc, then channel asc. The array is built in channel-asc order and sort
  // is stable, so among equal scores the alphabetically-first channel still wins — byte-identical
  // to the prior `if (!best || score > best.score)` selection.
  return candidates.sort((a, b) => b.score - a.score || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
}

export async function recommendNextAction(identity: Identity): Promise<Recommendation | null> {
  const businessId = identity.businessId;

  // Attach point: the latest route's ACTIVE waypoint. None → nothing to recommend onto.
  const route = await prisma.route.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" } });
  if (!route) return null;
  const waypoint = await prisma.routeWaypoint.findFirst({
    where: { businessId, routeId: route.id, status: "active" }, orderBy: { order: "asc" } });
  if (!waypoint) return null;

  // ONE standing recommendation at a time — drafted or not. Any `proposed` recommender action
  // suppresses a new one; a fresh suggestion appears only after the founder ACTS on the last one
  // (approve/reject clears `proposed`). Not gating on assetId is what stops a drafted-but-unreviewed
  // recommendation from letting each ignored night pile another proposal onto the founder's queue.
  const standing = await prisma.routeAction.findFirst({
    where: { businessId, status: "proposed", featuresJson: { contains: '"recommender":true' } } });
  if (standing) return null;

  const [best] = await scoreChannelCandidates(identity);
  if (!best) return null;

  // Honest rationale: cite positive evidence when it exists; say "exploring" ONLY when there is
  // genuinely no evidence; when evidence exists but none is positive, say so plainly — never
  // claim "no evidence" while /learned shows a negative belief for the same channel.
  const reason = best.cited.length > 0
    ? `Recommended: post on ${best.channel} — ${best.cited.join(" ")}`
    : best.hasEvidence
      ? `Recommended: post on ${best.channel} — the evidence so far is mixed or negative everywhere; this is the least-discouraged option.`
      : `Recommended: post on ${best.channel} — exploring; no evidence for this channel yet.`;

  // NEVER-AUTO: lands as a `proposed` action in the founder's review pipeline.
  const { actionId } = await upsertRouteAction(identity, {
    waypointId: waypoint.id, employeeRole: "copywriter", type: "post",
    rationale: reason, features: { channel: best.channel, recommender: true } });
  return { actionId, channel: best.channel, reason };
}
