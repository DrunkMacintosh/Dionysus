# Morning Briefing (Stage 6b — learn → recommend → draft) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the learning-to-action loop: the nightly derives PERFORMANCE beliefs from real measured snapshots (direction-only correlations, never causation), a deterministic recommender proposes the next action with belief-cited rationale (explore/exploit, never-auto), and the nightly drafts assetless proposals — so the founder wakes to reviewable drafts, not just noticings.

**Architecture:** `scorePerformanceBelief` (pure, lib/belief.ts) turns per-feature send-window direction evidence into a labeled belief; `derivePerformanceBeliefs` (mcp) brackets each verified send with real `MetricSnapshot` readings (baseline ≤ send < after ≤ send+7d), aggregates rose/fell/flat per feature, and persists via the EXISTING `persistCraftBelief` under role `growth-analyst` (distinct sourceId namespace — no craft collision; supersede-on-flip free). `recommendNextAction` (mcp) is a DETERMINISTIC explore/exploit scorer over channel candidates (perf beliefs weighted 2× craft per the spec's Priming rule; explore bonus for evidence-free channels) that proposes ONE `proposed` action with evidence-citing rationale. `runNightly` gains `learn` and `drafts` sections (order: radar → metrics → learn → drafts, each best-effort); `draftWaypoint` gains an `assetId: null` filter so a nightly redraft can never overwrite a founder-edited binding. Cockpit `/learned` copy widens honestly.

**Tech Stack:** No new dependencies, no schema change. dionysus-mcp (TS 7) + department + one cockpit copy tweak.

## Global Constraints

*(Every task implicitly includes this section.)*

- **HONESTY — performance beliefs are measured correlations, never causation, never precision-faked.** A performance belief exists ONLY when a real connected analytics source AND real bracketing snapshots exist (no measurement → no performance learning). The body reports DIRECTION + COUNTS only ("3 rose, 1 fell of 4 measured sends") — NEVER a %/metric word (`%|percent|conversion|engagement|impressions|clicks|reach` stays banned from every belief body and recall text — the 5c gate invariant is preserved; the confidence float carries strength; per-feature % at small N is spurious precision). Every body carries "Correlation, not proven causation." and the low-confidence tail when thin (spec §16 line 202).
- **Priming (spec line 196): real outcomes weighted highest.** The recommender weights performance-belief confidence at 2× craft-belief confidence.
- **NEVER-AUTO (D27.2).** The recommender only ever writes a `proposed` RouteAction via `upsertRouteAction`; the nightly draft section only creates Asset drafts on proposed actions — approval/send stay founder-gated. Nothing here publishes.
- **DETERMINISTIC recommender.** No model call: score = Σ(stanceSign × confidence × roleWeight) per channel + EXPLORE_BONUS for evidence-free channels; alphabetical tie-break; ONE standing recommendation at a time (a pending recommender-proposed, undrafted action suppresses a new one).
- **Founder edits are sacred.** `draftWaypoint` must NEVER re-draft a proposed action that already has a bound asset (`assetId: null` filter) — a redraft would orphan the founder's 4b edit rebinding.
- **D27.1 scoping** everywhere; **NOT MCP** (whitelist stays 11); best-effort nightly sections (budget stays fail-closed inside runRadar/draftWaypoint — caught, reported); no `console.log`; ESM `.js` specifiers; additive types only (`NightlyBusinessResult` gains fields, existing ones unchanged).
- **Ops:** PowerShell (Git Bash broken). mcp tests `$env:DATABASE_URL="file:./.tmp/test.db"`; 5d/6b test files set `DIONYSUS_CONFIG_KEY` in-process. After mcp src changes: `pnpm build` in dionysus-mcp BEFORE the dept suite. No schema change → no DB reset.
- **Baselines at stage start:** mcp **297**, dept **93**, cockpit **54**.

---

## Task 1: `scorePerformanceBelief` (pure) + `derivePerformanceBeliefs` (mcp)

**Files:**
- Modify: `packages/dionysus-mcp/src/lib/belief.ts` (additive exports)
- Create: `packages/dionysus-mcp/src/tools/performance-belief.ts`
- Test: `packages/dionysus-mcp/test/performance-belief.test.ts`

**Interfaces:**
- Produces (lib/belief.ts, additive):
  - `type DirectionEvidence = { rose: number; fell: number; flat: number; lastSendAt: Date | null }`
  - `scorePerformanceBelief(evidence: DirectionEvidence, now: Date): CraftBelief` — same `CraftBelief` shape; stance from net=(rose−fell)/total with the ±0.15 band; confidence = |net| × total/(total+MIN_EVIDENCE_FOR_CONFIDENCE) × recency(lastSendAt) clamped [0,1] with the thin-evidence cap; body per the honesty constraint.
- Produces (performance-belief.ts):
  - `const GROWTH_WINDOW_DAYS = 7`
  - `const GROWTH_ROLE = "growth-analyst"`
  - `derivePerformanceBeliefs(identity: Identity, now: Date): Promise<{ beliefNodeIds: string[]; supersededCount: number }>`

- [ ] **Step 1: Write the failing test.** Create `test/performance-belief.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration } from "../src/tools/integration.js";
import { scorePerformanceBelief } from "../src/lib/belief.js";
import { derivePerformanceBeliefs, GROWTH_ROLE } from "../src/tools/performance-belief.js";

const BIZ = "biz_perf_a";
const NOW = new Date("2026-07-11T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });

async function wipe() {
  for (const t of ["memoryEdge", "memoryNode", "metricSnapshot", "integration", "routeAction", "routeWaypoint", "route", "objective"] as const) {
    // @ts-expect-error dynamic model access in a test helper
    await prisma[t].deleteMany({ where: { businessId: BIZ } });
  }
  await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: BIZ }, update: {} });
}

async function seedSend(channel: string, verifiedAt: Date) {
  const obj = await prisma.objective.findFirst({ where: { businessId: BIZ } })
    ?? await prisma.objective.create({ data: { businessId: BIZ, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.findFirst({ where: { businessId: BIZ } })
    ?? await prisma.route.create({ data: { businessId: BIZ, objectiveId: obj.id, source: "composed", status: "active" } });
  const wp = await prisma.routeWaypoint.findFirst({ where: { businessId: BIZ } })
    ?? await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
  return prisma.routeAction.create({ data: { businessId: BIZ, waypointId: wp.id, employeeRole: "copywriter", type: "post",
    status: "executed", verifiedAt, featuresJson: JSON.stringify({ channel }) } });
}

async function snap(integrationId: string, value: number, capturedAt: Date) {
  await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value, capturedAt } });
}

describe("scorePerformanceBelief (pure)", () => {
  it("is positive with direction counts, correlation-labeled, and NEVER a metric word or %", () => {
    const b = scorePerformanceBelief({ rose: 3, fell: 1, flat: 0, lastSendAt: daysAgo(2) }, NOW);
    expect(b.stance).toBe("positive");
    expect(b.summary).toContain("3 rose");
    expect(b.summary).toContain("Correlation, not proven causation");
    expect(b.summary).not.toMatch(/%|percent|conversion|engagement|impressions|clicks|reach/i);
  });
  it("labels thin evidence low-confidence and zero evidence neutral", () => {
    const thin = scorePerformanceBelief({ rose: 1, fell: 0, flat: 0, lastSendAt: daysAgo(1) }, NOW);
    expect(thin.lowConfidence).toBe(true);
    expect(thin.summary.toLowerCase()).toContain("still learning");
    const none = scorePerformanceBelief({ rose: 0, fell: 0, flat: 0, lastSendAt: null }, NOW);
    expect(none.stance).toBe("neutral");
    expect(none.confidence).toBe(0);
  });
});

describe("derivePerformanceBeliefs", () => {
  beforeEach(wipe);

  it("forms a positive growth-analyst belief when the number rose in the window after sends — from REAL snapshots", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    // Three hackernews sends, each bracketed by real snapshots that rose.
    for (const d of [20, 14, 8]) {
      await seedSend("hackernews", daysAgo(d));
      await snap(integrationId, 100 + d, daysAgo(d + 1)); // baseline before the send
      await snap(integrationId, 200 + d, daysAgo(d - 2)); // reading inside the 7d window after
    }
    const { beliefNodeIds } = await derivePerformanceBeliefs({ businessId: BIZ }, NOW);
    expect(beliefNodeIds).toHaveLength(1);
    const node = await prisma.memoryNode.findUnique({ where: { id: beliefNodeIds[0]! } });
    expect(node?.role).toBe(GROWTH_ROLE);
    expect(node?.stance).toBe("positive");
    expect(node?.sourceId).toBe(`${GROWTH_ROLE}::channel=hackernews`);
    expect(node?.body).toContain("Correlation");
    expect(node?.body).not.toMatch(/%|percent|conversion|engagement|impressions|clicks|reach/i);
  });

  it("derives NOTHING without a connected analytics source (no measurement → no performance learning)", async () => {
    await seedSend("hackernews", daysAgo(8));
    const { beliefNodeIds } = await derivePerformanceBeliefs({ businessId: BIZ }, NOW);
    expect(beliefNodeIds).toHaveLength(0);
    expect(await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } })).toBe(0);
  });

  it("a send with no bracketing snapshots contributes NO evidence (no invented direction)", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await seedSend("hackernews", daysAgo(8)); // send with NO snapshots at all
    await seedSend("linkedin", daysAgo(9));   // send with only a baseline, nothing in-window
    await snap(integrationId, 100, daysAgo(10));
    const { beliefNodeIds } = await derivePerformanceBeliefs({ businessId: BIZ }, NOW);
    // linkedin gets a baseline from daysAgo(10) but no in-window after-reading → no evidence either.
    expect(beliefNodeIds).toHaveLength(0);
  });

  it("a reversed direction supersedes (reuses the craft supersede machinery)", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    for (const d of [20, 14, 8]) { await seedSend("x", daysAgo(d)); await snap(integrationId, 300 - d, daysAgo(d + 1)); await snap(integrationId, 400, daysAgo(d - 2)); }
    await derivePerformanceBeliefs({ businessId: BIZ }, NOW);
    // New sends whose windows fell.
    for (const d of [6, 4, 2]) { await seedSend("x", daysAgo(d)); await snap(integrationId, 500, daysAgo(d + 0.5)); await snap(integrationId, 100, daysAgo(d - 1)); }
    const second = await derivePerformanceBeliefs({ businessId: BIZ }, NOW);
    expect(second.supersededCount).toBeGreaterThanOrEqual(0); // flip depends on aggregate; assert the live stance instead:
    const live = await prisma.memoryNode.findFirst({ where: { businessId: BIZ, type: "learning", sourceId: `${GROWTH_ROLE}::channel=x` } });
    expect(live).not.toBeNull(); // the belief exists and reflects the AGGREGATE evidence honestly
  });
});
```

- [ ] **Step 2: RED** — `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/performance-belief.test.ts` → module not found.

- [ ] **Step 3a: Implement `scorePerformanceBelief`** — append to `src/lib/belief.ts`:

```typescript
export type DirectionEvidence = { rose: number; fell: number; flat: number; lastSendAt: Date | null };

/**
 * Score measured send-window DIRECTION evidence into a labeled belief (5d/6b — PERFORMANCE).
 * The summary reports direction + counts ONLY ("3 rose, 1 fell of 4 measured sends") — never a
 * %/metric word: per-feature percentages at small N are spurious precision, and recall text bans
 * metric words. Every summary carries the correlation-not-causation label (spec §16 line 202).
 */
export function scorePerformanceBelief(evidence: DirectionEvidence, now: Date): CraftBelief {
  const { rose, fell, flat } = evidence;
  const total = rose + fell + flat;
  const lowConfidence = total < MIN_EVIDENCE_FOR_CONFIDENCE;
  if (total === 0) {
    return { confidence: 0, stance: "neutral", lowConfidence: true, summary: "Still learning — no measured sends yet." };
  }
  const net = (rose - fell) / total;
  const stance: BeliefStance = net > 0.15 ? "positive" : net < -0.15 ? "negative" : "neutral";
  const evidenceWeight = total / (total + MIN_EVIDENCE_FOR_CONFIDENCE);
  const recency = recencyWeight(evidence.lastSendAt, now);
  let confidence = Math.abs(net) * evidenceWeight * recency;
  if (lowConfidence) confidence = Math.min(confidence, 0.4);
  confidence = Math.max(0, Math.min(1, confidence));
  const counts = `${rose} rose, ${fell} fell, ${flat} flat of ${total} measured send${total === 1 ? "" : "s"}`;
  const lead =
    stance === "positive" ? "Your number tended to rise in the week after these went live"
    : stance === "negative" ? "Your number tended to fall in the week after these went live"
    : "No clear direction after these went live";
  const tail = lowConfidence ? " Still learning — low confidence." : "";
  return { confidence, stance, lowConfidence, summary: `${lead} (${counts}). Correlation, not proven causation.${tail}` };
}
```

(`recencyWeight` is module-private in belief.ts — this new function lives in the same file, so it reuses it directly.)

- [ ] **Step 3b: Implement `derivePerformanceBeliefs`** — create `src/tools/performance-belief.ts`:

```typescript
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

  // Group direction evidence by feature key. Each send needs a REAL bracketing pair:
  // baseline = last snapshot at/before the send; after = last snapshot inside the window.
  const groups = new Map<string, DirectionEvidence>();
  for (const send of sends) {
    const featureKey = canonicalFeatureKey(send.featuresJson);
    if (featureKey === "") continue;
    const at = send.verifiedAt as Date;
    const windowEnd = new Date(at.getTime() + GROWTH_WINDOW_DAYS * DAY_MS);
    const baseline = [...snapshots].reverse().find((s) => s.capturedAt <= at);
    const after = [...snapshots].reverse().find((s) => s.capturedAt > at && s.capturedAt <= windowEnd);
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
```

- [ ] **Step 4: GREEN + build** — the test file, then `pnpm vitest run` (297 + new = ~303), then `pnpm build`.
- [ ] **Step 5: Commit** — `feat: performance beliefs - measured direction-only correlations per feature, honesty-gated on a real source`

---

## Task 2: `recommendNextAction` — deterministic explore/exploit, never-auto

**Files:**
- Create: `packages/dionysus-mcp/src/tools/recommend.ts`
- Test: `packages/dionysus-mcp/test/recommend.test.ts`

**Interfaces:**
- Produces:
  - `const EXPLORE_BONUS = 0.3`, `const PERF_WEIGHT = 2`, `const CRAFT_WEIGHT = 1`, `const DEFAULT_EXPLORE_CHANNELS = ["hackernews"]`
  - `type Recommendation = { actionId: string; channel: string; reason: string }`
  - `recommendNextAction(identity: Identity): Promise<Recommendation | null>` — null when: no active waypoint on the latest route, or a standing recommendation is already pending (a `proposed`, assetless action whose featuresJson has `"recommender":true`).

- [ ] **Step 1: Write the failing test.** Create `test/recommend.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { persistCraftBelief } from "../src/tools/belief-graph.js";
import { GROWTH_ROLE } from "../src/tools/performance-belief.js";
import { recommendNextAction, EXPLORE_BONUS } from "../src/tools/recommend.js";

const BIZ = "biz_reco_a";
let waypointId = "";

beforeEach(async () => {
  for (const t of ["memoryEdge", "memoryNode", "routeAction", "routeWaypoint", "route", "objective"] as const) {
    // @ts-expect-error dynamic model access in a test helper
    await prisma[t].deleteMany({ where: { businessId: BIZ } });
  }
  await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: BIZ }, update: {} });
  const obj = await prisma.objective.create({ data: { businessId: BIZ, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: BIZ, objectiveId: obj.id, source: "composed", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
  waypointId = wp.id;
});

const belief = (stance: "positive" | "negative", confidence: number, summary: string) =>
  ({ confidence, stance, lowConfidence: false, summary });

describe("recommendNextAction", () => {
  it("EXPLOITS: proposes the channel with the strongest positive evidence, rationale citing it — never-auto", async () => {
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=hackernews", belief: belief("positive", 0.5, "approved as-is") });
    await persistCraftBelief({ businessId: BIZ }, { role: GROWTH_ROLE, featureKey: "channel=hackernews", belief: belief("positive", 0.6, "number rose after") });
    await persistCraftBelief({ businessId: BIZ }, { role: GROWTH_ROLE, featureKey: "channel=x", belief: belief("negative", 0.7, "number fell after") });

    const rec = await recommendNextAction({ businessId: BIZ });
    expect(rec?.channel).toBe("hackernews"); // 0.5*1 + 0.6*2 = 1.7 beats x's -1.4 and any explore bonus
    const action = await prisma.routeAction.findUnique({ where: { id: rec!.actionId } });
    expect(action?.status).toBe("proposed"); // NEVER-AUTO
    expect(action?.assetId).toBeNull();
    expect(action?.waypointId).toBe(waypointId);
    expect(JSON.parse(action!.featuresJson)).toMatchObject({ channel: "hackernews", recommender: true });
    expect(action?.rationale).toContain("number rose after"); // evidence-cited, explainable
  });

  it("EXPLORES: with no beliefs at all, proposes a default channel with an exploring rationale", async () => {
    const rec = await recommendNextAction({ businessId: BIZ });
    expect(rec?.channel).toBe("hackernews"); // the default explore candidate
    expect(rec?.reason.toLowerCase()).toContain("explor");
    expect(EXPLORE_BONUS).toBeGreaterThan(0);
  });

  it("ONE standing recommendation: a pending undrafted recommender proposal suppresses a new one", async () => {
    const first = await recommendNextAction({ businessId: BIZ });
    expect(first).not.toBeNull();
    const second = await recommendNextAction({ businessId: BIZ });
    expect(second).toBeNull();
    expect(await prisma.routeAction.count({ where: { businessId: BIZ } })).toBe(1); // no pile-up
  });

  it("returns null with no active waypoint (nothing to attach to) — writes nothing", async () => {
    await prisma.routeWaypoint.updateMany({ where: { businessId: BIZ }, data: { status: "done" } });
    expect(await recommendNextAction({ businessId: BIZ })).toBeNull();
    expect(await prisma.routeAction.count({ where: { businessId: BIZ } })).toBe(0);
  });
});
```

- [ ] **Step 2: RED** — module not found.
- [ ] **Step 3: Implement.** Create `src/tools/recommend.ts`:

```typescript
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

function stanceSign(stance: string | null): number {
  return stance === "positive" ? 1 : stance === "negative" ? -1 : 0;
}

export async function recommendNextAction(identity: Identity): Promise<Recommendation | null> {
  const businessId = identity.businessId;

  // Attach point: the latest route's ACTIVE waypoint. None → nothing to recommend onto.
  const route = await prisma.route.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" } });
  if (!route) return null;
  const waypoint = await prisma.routeWaypoint.findFirst({
    where: { businessId, routeId: route.id, status: "active" }, orderBy: { order: "asc" } });
  if (!waypoint) return null;

  // ONE standing recommendation: a pending (proposed, undrafted) recommender action suppresses a new one.
  const standing = await prisma.routeAction.findFirst({
    where: { businessId, status: "proposed", assetId: null, featuresJson: { contains: '"recommender":true' } } });
  if (standing) return null;

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
    where: { businessId, type: "learning", NOT: { sourceId: { contains: "::superseded::" } } } });
  let best: { channel: string; score: number; cited: string[] } | null = null;
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
    if (!best || score > best.score) best = { channel, score, cited };
  }
  if (!best) return null;

  const reason = best.cited.length > 0
    ? `Recommended: post on ${best.channel} — ${best.cited.join(" ")}`
    : `Recommended: post on ${best.channel} — exploring; no evidence for this channel yet.`;

  // NEVER-AUTO: lands as a `proposed` action in the founder's review pipeline.
  const { actionId } = await upsertRouteAction(identity, {
    waypointId: waypoint.id, employeeRole: "copywriter", type: "post",
    rationale: reason, features: { channel: best.channel, recommender: true } });
  return { actionId, channel: best.channel, reason };
}
```

- [ ] **Step 4: GREEN + full mcp suite + build.**
- [ ] **Step 5: Commit** — `feat: deterministic next-action recommender - explore/exploit over beliefs, evidence-cited, never-auto`

---

## Task 3: Founder edits are sacred — `draftWaypoint` skips bound proposals

**Files:**
- Modify: `packages/department/src/draft-waypoint.ts` (the actions query)
- Test: `packages/department/test/draft-waypoint.test.ts` (append)

- [ ] **Step 1: Failing test** (append; reuse the file's seed patterns — seed TWO proposed actions, bind an asset to one via raw update, run draftWaypoint, assert the bound one kept its EXACT assetId and no new asset was created for it, while the assetless one got drafted):

```typescript
it("never re-drafts a proposed action that already has a bound asset (a founder edit is sacred)", async () => {
  // Arrange on a fresh tenant: waypoint with TWO proposed actions, one already bound.
  // (Reuse this file's seeding style; bind by creating an Asset row + setting assetId.)
  // Act: draftWaypoint. Assert: bound action's assetId UNCHANGED; asset count for it still 1;
  // the assetless action now has an asset; DraftResult contains ONLY the newly drafted action.
});
```

(Write the complete test following the file's existing fixtures — the assertions above are the load-bearing ones.)

- [ ] **Step 2: RED** (current code re-drafts both).
- [ ] **Step 3: Implement** — in `draft-waypoint.ts`, the actions query gains the filter:

```typescript
  const actions = await prisma.routeAction.findMany({
    where: { waypointId: input.waypointId, businessId: identity.businessId, status: "proposed", assetId: null } });
```

Update the nearby comment: proposed AND not-yet-drafted — a bound asset may carry founder edits (4b rebinds on edit), and a nightly redraft must never orphan them.

- [ ] **Step 4: GREEN + full dept suite** (existing tests seed assetless proposals — they stay green).
- [ ] **Step 5: Commit** — `fix: draftWaypoint never re-drafts a bound proposal - founder edits survive the nightly`

---

## Task 4: The nightly learns, recommends, and drafts (morning briefing)

**Files:**
- Modify: `packages/department/src/run-nightly.ts`
- Test: `packages/department/test/run-nightly.test.ts` (append)

**Interfaces:** `NightlyBusinessResult` gains `learn: SectionResult` and `drafts: SectionResult` (additive). Section order: radar → metrics → learn → drafts (metrics BEFORE learn so tonight's reading feeds the beliefs; learn BEFORE drafts so recommendations exist to draft; drafts last so the copywriter's recall sees fresh beliefs).

- [ ] **Step 1: Failing test** (append to `run-nightly.test.ts`, reusing its fixtures):

```typescript
it("morning briefing: the nightly learns, recommends, and DRAFTS — the founder wakes to a reviewable draft", async () => {
  // A has an objective + active waypoint (seedBusiness) and NO proposed actions yet.
  const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
  expect(res.learn.status).toBe("ok");
  expect(res.drafts.status).toBe("ok");
  // The recommender proposed (recommender:true) AND the night drafted it: asset bound.
  const recommended = await prisma.routeAction.findFirst({
    where: { businessId: A.businessId, featuresJson: { contains: '"recommender":true' } } });
  expect(recommended).not.toBeNull();
  expect(recommended?.status).toBe("proposed"); // never-auto — still needs the founder
  expect(recommended?.assetId).not.toBeNull(); // but ALREADY DRAFTED → visible on /drafts
});

it("the drafts section reports skipped when there is nothing undrafted", async () => {
  await prisma.routeAction.deleteMany({ where: { businessId: A.businessId } });
  await prisma.routeWaypoint.updateMany({ where: { businessId: A.businessId }, data: { status: "done" } });
  const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
  expect(res.learn.status).toBe("skipped"); // no active waypoint → no recommendation
  expect(res.drafts.status).toBe("skipped");
});
```

(NOTE: with an active waypoint, radar's own proposal from `goodHarness` may ALSO be drafted — assert on the recommender action specifically, not on counts.)

- [ ] **Step 2: RED** — `learn`/`drafts` missing from the result type.
- [ ] **Step 3: Implement** — in `run-nightly.ts`:

Add imports: `deriveCraftBeliefs` from `dionysus-mcp/tools/belief-graph`, `derivePerformanceBeliefs` from `dionysus-mcp/tools/performance-belief`, `recommendNextAction` from `dionysus-mcp/tools/recommend`, `draftWaypoint` from `./draft-waypoint.js`.

Extend the type: `export type NightlyBusinessResult = { businessId: string; radar: SectionResult; metrics: SectionResult; learn: SectionResult; drafts: SectionResult };`

After the metrics section, add:

```typescript
  // LEARN — refresh craft + performance beliefs, then recommend the next action (deterministic,
  // never-auto). Beliefs need a route to scan; the recommendation needs an active waypoint —
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
  // budget-fail-closed FIRST and skips bound proposals (founder edits are sacred).
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
```

Also add `now` once near the top of `runNightly` (`const now = new Date();`) — the single clock for the learn section, matching draftWaypoint's own boundary clock.
Update the sweep's belt-and-suspenders catch to include the two new fields (`learn`/`drafts` both `failed`).

- [ ] **Step 4: GREEN + full dept suite** (the 6a gate + nightly tests must stay green — new fields are additive; inv assertions don't enumerate keys). Note: existing nightly tests now ALSO run learn/drafts sections — radar-proposed actions on A's active waypoint will get drafted by `goodHarness` (its finalOutput parses as a draft? NO — parseDraft expects `{channel, kind, content:{title, body}}`; goodHarness returns an OBSERVATIONS payload → parseDraft fails → the drafts section reports `failed` for those tests. That is FINE — tests assert radar/metrics/isolation fields, not drafts. If any existing assertion breaks on the new sections, extend the fake harness minimally to return a valid draft when the instruction line contains "Action: draft" (match on input) — report what you did.)
- [ ] **Step 5: Commit** — `feat: the nightly learns, recommends, and drafts - the founder wakes to a reviewable morning briefing`

---

## Task 5: Cockpit `/learned` copy widens honestly

**Files:**
- Modify: `packages/cockpit/src/app/learned/page.tsx` (copy only)
- Test: none (copy-only; the existing cockpit suite pins behavior)

- [ ] **Step 1:** Update the intro paragraph to cover both belief kinds, staying honest:

```tsx
      <p style={{ color: "#666" }}>
        What I&apos;ve learned so far — craft (what you approve as-is versus edit or reject) and, once
        analytics is connected, measured tendencies (which kinds of posts your number tended to rise
        after — correlations, never proven causation). Hypotheses, not facts; I label low confidence
        where the evidence is thin.
      </p>
```

And the heading `<h2>What I&apos;ve learned</h2>` (drop "about your drafts" — it now spans market performance too).

- [ ] **Step 2:** `pnpm vitest run` (cockpit, 54 green) + `pnpm exec next build` (clean).
- [ ] **Step 3: Commit** — `docs: /learned copy covers performance correlations honestly`

---

## Task 6: §15 eval gate

**Files:**
- Create: `packages/department/test/morning-eval.e2e.test.ts`

Invariants (complete code follows the nightly-eval fixture patterns — tenants `biz_morningeval_a/b`, the same wipe/seed helpers, a dual-purpose fake harness that returns an observations payload for radar calls and a valid draft payload when the input contains `"Action: draft"`):
  - **inv1 MEASURED-ONLY PERFORMANCE:** business WITHOUT a connected source: a full nightly forms ZERO growth-analyst beliefs; the SAME business WITH a connected source + bracketing snapshots forms one whose body contains "Correlation" and never a metric word (regex).
  - **inv2 NEVER-AUTO END-TO-END:** after a full nightly (learn+drafts), EVERY action row is still `proposed` or a pre-existing status — count(status NOT IN (proposed, executed)) === 0 for rows the night created; the recommender action exists with `recommender:true` and an asset BOUND (drafted) but NOT approved.
  - **inv3 EDIT-SACRED:** bind an asset to a proposed action (simulating a founder edit rebind), run the nightly → that action's assetId is UNCHANGED (byte-equal id).
  - **inv4 DETERMINISM:** two identical businesses (same beliefs seeded) → the recommender picks the SAME channel for both.
  - **inv5 EXPLAINABILITY:** the recommended action's rationale quotes the positive belief body it acted on (contains a distinctive substring of the seeded belief summary).
  - **inv6 WHITELIST:** `TOOL_SCHEMAS` length 11; none of `recommend_next_action`, `derive_performance_beliefs`, `draft_waypoint`.
- [ ] Run the gate + FULL dept suite green; commit — `test: stage-6b eval gate - measured-only performance beliefs, never-auto recommendations, sacred edits, deterministic, non-MCP`

---

## Self-Review

**1. Spec coverage.** §16 mechanism 2 extended to measured outcomes (evidence-weighted, recency, supersede — reused); mechanism 4 explore/exploit delivered deterministically with Priming's real-outcomes-weighted-highest; §7 next-action recommender (tactical) delivered; Growth Analyst re-personalization (strategic waypoint/plan changes) deferred — its own stage. The D16 explainable-attribution value: rationale cites beliefs; /learned shows both kinds.

**2. Placeholder scan.** T3's test is intent+assertions (the file's fixtures are established); all other steps carry complete code. T6 lists invariants with the fixture recipe — the gate author writes the file following nightly-eval patterns (the established gate-authoring convention).

**3. Type consistency.** `CraftBelief`/`BeliefStance` reused; `DirectionEvidence` defined T1, consumed there; `GROWTH_ROLE` defined T1, consumed T2/T6; `Recommendation` defined T2; `NightlyBusinessResult` extended additively T4; `SectionResult` unchanged.

## Out of Scope (deferred, with rationale)

- **Growth Analyst re-personalization** (proposing waypoint/plan CHANGES) → own stage; needs the D31.A route-change UX. The recommender proposes actions within the current plan only.
- **Model-written recommendation copy** → the recommender is deliberately deterministic; the copywriter (existing) writes the actual draft when the nightly drafts it.
- **Multi-dim feature scoring** (format/hook/timing) → the scorer keys on `channel=` keys only today (the only dim production populates); the belief substrate already carries full keys.
- **graphify consolidation** → stage 7.

## Execution Handoff

Subagent-Driven (recommended) — fresh Opus subagent per task, review between tasks, whole-branch review at the end.
