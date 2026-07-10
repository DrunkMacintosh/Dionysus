# Craft-Belief Substrate (Stage 5c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Dionysus an honest, evidence-weighted belief layer — it learns *what drafts this founder accepts as-is* from real founder-acceptance behavior, labels those beliefs honestly (low-confidence when evidence is thin), corrects stale beliefs via `supersedes`, and feeds them back into the copywriter's recall so future drafts reflect learned craft.

**Architecture:** A pure scoring core (`lib/belief.ts`) turns per-feature founder-acceptance evidence into a bounded confidence + a labeled stance. A scoped, idempotent writer (`belief-graph.ts`) persists each belief as a `learning` `MemoryNode` (one live node per `role`+`featureKey`), snapshots + `supersedes` the prior node when the stance flips, and wires `informed-by` edges to the real action nodes it was derived from (no free-floating assertions). A lazy orchestrator (`deriveCraftBeliefs`) scans the route's feature-tagged actions and updates beliefs; it runs best-effort inside `draftWaypoint`'s existing recall block, so `buildAgentContext.learnings` fills with honestly-labeled beliefs and the copywriter exploits proven craft. A thin cockpit surface makes the learning visible (explainable attribution). A §15 eval gate pins the honesty invariants.

**Tech Stack:** TypeScript (dionysus-mcp on TS 7 / department + cockpit on TS ~5.8), Prisma 6 + SQLite (`db push`, no migrations), vitest, Next 15 / React 19 (cockpit). No new dependencies.

## Global Constraints

*(Every task's requirements implicitly include this section. Values are copied verbatim from the spec / prior-stage contracts.)*

- **CRAFT, not performance (the honesty spine).** 5c beliefs are about *what drafts the founder accepts as-is* — derived from real founder-acceptance behavior (`status`, `editDistance`, `rejectionCount`). They are **per-employee craft** learning (spec §10 line 170: "per-employee craft = `learning` nodes tagged with role"). A 5c belief MUST NEVER claim a **performance/market outcome** ("drives conversions", "performs well", "gets engagement") and MUST NEVER contain a fabricated metric/percentage. Measured-outcome (performance) beliefs are **5d** (analytics/D21; the spec weights real outcomes highest and they override craft priors as they arrive — Priming, spec line 196). This is out of scope here.
- **Honest guards (spec §16 line 202), all enforced:** (a) an evidence-count threshold below which a belief is labeled **low-confidence** ("still learning"); (b) recency decay (older evidence weighs less); (c) confidence shown honestly — a 2-observation belief is labeled low-confidence, never dressed as certainty; (d) every belief links to **real nodes** (`informed-by` edges to the action mirror nodes it was derived from) — no free-floating assertions; (e) the copywriter recall renders beliefs as **labeled hypotheses** ("what I've learned so far, still learning where thin"), never as facts.
- **Confidence ∈ [0,1].** `persistMemoryNode` validates `Number.isFinite(confidence) && 0 <= confidence <= 1` and throws otherwise; every belief confidence must satisfy this.
- **Idempotent + lazy-on-view safe.** The live belief for a `(businessId, role, featureKey)` is found-or-created by `sourceId = "${role}::${featureKey}"` (`type:"learning"`, unique via the existing `@@unique([businessId, type, sourceId])`). Re-derivation on **unchanged evidence** updates the live node in place and adds **zero** rows/edges. Only a **stance flip** (positive↔negative) writes a superseded snapshot + a `supersedes` edge.
- **`supersedes` direction (spec §10 line 171):** `new learning → stale belief`. The live node is the `fromId`; the snapshot (stale) is the `toId`. Recall EXCLUDES any node that is the `toId` of a `supersedes` edge (the stale ones).
- **D27.1 ambient identity / scoping.** No new function takes a `businessId` param; identity is ambient. Every read/write is `businessId`-scoped via `findFirst`/`where: { businessId }`. A cross-tenant `routeId` is a not-found throw before any write.
- **Belief nodes are TRUSTED (`tainted: false`).** They are our own server-derived summaries of the founder's own actions, not ingested content. `recordObservation` remains the *only* forced-`tainted:true` writer (spec §6.2 / D27.2) — do not touch it.
- **NOT MCP — whitelist stays 11.** `deriveCraftBeliefs`, `persistCraftBelief`, `scoreCraftBelief`, `buildAgentContext`, and the cockpit reader are all non-MCP. Do NOT register any new tool in `server.ts`. `TOOL_SCHEMAS` stays exactly 11. Exposing `build_agent_context`/`persist_learning`/`persist_memory` as MCP tools is deferred to **6a** (when a platform-hosted agent calls across the tool boundary) — building a tool surface nothing calls now would be YAGNI.
- **Additive only; recall is best-effort.** No existing signature changes incompatibly. `buildAgentContext` keeps its exact `AgentContext` shape (fills `learnings`, extends `text`). `deriveCraftBeliefs` is wired inside `draftWaypoint`'s EXISTING best-effort `try/catch` (budget + waypoint + action loads stay OUTSIDE it) — a belief failure must NEVER break drafting.
- **No `console.log`** in production code (`console.error` on the best-effort catch path only, matching the existing `draftWaypoint` pattern). **No mutation** — immutable updates. Files < 800 lines, functions < 50 lines where practical.
- **`now` is injected**, never `new Date()` inside pure/scored logic (mirrors the cmo-report/mirror pattern) so recency decay is deterministic in tests. `draftWaypoint` supplies `new Date()` at the call boundary (as it already does for `mirrorPlanToGraph`).
- **Ops (verified):** use **PowerShell** (Git Bash broken on this machine). dionysus-mcp tests: `$env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run <file>` (the `pnpm test` script resets the test DB via `reset-test-db.mjs` → `db push`, so `schema.prisma` changes auto-apply; a bare `pnpm vitest run` does NOT reset — run `pnpm test` once after a schema change, or `node prisma/reset-test-db.mjs` first). department imports the BUILT dist of dionysus-mcp → after changing dionysus-mcp src/schema run `pnpm build` in dionysus-mcp before the dept suite. cockpit tests need BOTH `$env:DATABASE_URL="file:./.tmp/test.db"` AND `$env:COCKPIT_SESSION_SECRET="test-secret"`.
- **Baselines at stage start:** mcp **236**, department **80**, cockpit **52**. Every task keeps all three green (the numbers rise as tests are added; never fall).

---

## File Structure

**dionysus-mcp**
- Create: `packages/dionysus-mcp/src/lib/belief.ts` — pure scoring core: `canonicalFeatureKey`, `scoreCraftBelief`, the evidence/stance/threshold constants. No DB, no identity.
- Create: `packages/dionysus-mcp/src/tools/belief-graph.ts` — `persistCraftBelief` (find-or-create live learning node + stance-flip snapshot + `supersedes` edge), `deriveCraftBeliefs` (scoped scan → group by role+featureKey → score → persist → `informed-by` edges), `listCraftBeliefs` (scoped read of live, non-superseded beliefs). Imports the belief core + `persistMemoryEdge`/`isUniqueViolation` helpers.
- Modify: `packages/dionysus-mcp/prisma/schema.prisma` — add `stance String?` to `MemoryNode` (additive, nullable; only `learning` nodes set it).
- Modify: `packages/dionysus-mcp/src/tools/memory-graph.ts` — export `isUniqueViolation` (currently module-private) for reuse; fill `buildAgentContext.learnings` with role-scoped, non-superseded belief nodes ordered by confidence; extend the `text` rendering with a labeled learnings section.
- Test: `packages/dionysus-mcp/test/belief.test.ts` (T1), `packages/dionysus-mcp/test/belief-graph.test.ts` (T2, T3), extend `packages/dionysus-mcp/test/memory-graph.test.ts` (T4), `packages/dionysus-mcp/test/craft-belief-eval.e2e.test.ts` (T6).

**department**
- Modify: `packages/department/src/draft-waypoint.ts` — call `deriveCraftBeliefs` inside the existing best-effort recall block, after `mirrorPlanToGraph` and before `buildAgentContext`.
- Test: extend `packages/department/test/draft-waypoint.test.ts` (T4).

**cockpit**
- Modify: `packages/cockpit/src/lib/review.ts` — add `listCraftBeliefs`-backed scoped reader `getCraftBeliefs`.
- Create: `packages/cockpit/src/app/learned/page.tsx` — a thin "What I've learned" read surface; add a nav link.
- Test: extend `packages/cockpit/test/review.test.ts` (T5).

---

## Task 1: Belief scoring core (pure)

**Files:**
- Create: `packages/dionysus-mcp/src/lib/belief.ts`
- Test: `packages/dionysus-mcp/test/belief.test.ts`

**Interfaces:**
- Produces:
  - `type FeatureEvidence = { acceptedAsIs: number; acceptedWithEdits: number; rejected: number; lastEventAt: Date | null }`
  - `type BeliefStance = "positive" | "negative" | "neutral"`
  - `type CraftBelief = { confidence: number; stance: BeliefStance; lowConfidence: boolean; summary: string }`
  - `canonicalFeatureKey(featuresJson: string): string` — canonical key from the whitelisted feature dims present; `""` when none/unparseable (caller skips a `""` key).
  - `scoreCraftBelief(evidence: FeatureEvidence, now: Date): CraftBelief`
  - `const BELIEF_FEATURE_DIMS = ["channel","format","hook","timing","audience","mode"] as const`
  - `const MIN_EVIDENCE_FOR_CONFIDENCE = 3`
  - `const RECENCY_HALFLIFE_DAYS = 30`

- [ ] **Step 1: Write the failing test**

Create `packages/dionysus-mcp/test/belief.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  canonicalFeatureKey,
  scoreCraftBelief,
  MIN_EVIDENCE_FOR_CONFIDENCE,
  type FeatureEvidence,
} from "../src/lib/belief.js";

const NOW = new Date("2026-07-11T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("canonicalFeatureKey", () => {
  it("keys on the whitelisted dims that are present, sorted for stability", () => {
    // Order of keys in the JSON must not change the canonical key.
    expect(canonicalFeatureKey(`{"channel":"linkedin","format":"long"}`)).toBe(
      canonicalFeatureKey(`{"format":"long","channel":"linkedin"}`),
    );
    expect(canonicalFeatureKey(`{"channel":"linkedin"}`)).toBe("channel=linkedin");
  });

  it("ignores non-whitelisted / non-string dims and degrades to empty on junk", () => {
    // `radar:true` is not a whitelisted craft dim; it must not enter the key.
    expect(canonicalFeatureKey(`{"channel":"hackernews","radar":true}`)).toBe("channel=hackernews");
    expect(canonicalFeatureKey(`{}`)).toBe("");
    expect(canonicalFeatureKey(`not json`)).toBe("");
    expect(canonicalFeatureKey(`{"channel":123}`)).toBe(""); // non-string value dropped → no dims → empty
  });
});

describe("scoreCraftBelief", () => {
  it("is positive and high-confidence when the founder accepts as-is repeatedly", () => {
    const evidence: FeatureEvidence = { acceptedAsIs: 5, acceptedWithEdits: 0, rejected: 0, lastEventAt: daysAgo(1) };
    const b = scoreCraftBelief(evidence, NOW);
    expect(b.stance).toBe("positive");
    expect(b.lowConfidence).toBe(false);
    expect(b.confidence).toBeGreaterThan(0.6);
    expect(b.confidence).toBeLessThanOrEqual(1);
    // Honesty: the summary reports COUNTS, never a fabricated percentage/metric.
    expect(b.summary).toContain("5");
    expect(b.summary).not.toMatch(/%|percent|conversion|engagement/i);
  });

  it("is negative when the founder rejects or heavily edits", () => {
    const evidence: FeatureEvidence = { acceptedAsIs: 0, acceptedWithEdits: 1, rejected: 4, lastEventAt: daysAgo(2) };
    const b = scoreCraftBelief(evidence, NOW);
    expect(b.stance).toBe("negative");
  });

  it("labels a thin-evidence belief low-confidence regardless of direction", () => {
    const evidence: FeatureEvidence = { acceptedAsIs: 1, acceptedWithEdits: 0, rejected: 0, lastEventAt: daysAgo(1) };
    const b = scoreCraftBelief(evidence, NOW);
    expect(b.lowConfidence).toBe(true); // below MIN_EVIDENCE_FOR_CONFIDENCE
    expect(b.confidence).toBeLessThan(0.5);
    expect(b.summary.toLowerCase()).toContain("still learning");
  });

  it("decays confidence when all the evidence is stale", () => {
    const fresh = scoreCraftBelief({ acceptedAsIs: 5, acceptedWithEdits: 0, rejected: 0, lastEventAt: daysAgo(1) }, NOW);
    const stale = scoreCraftBelief({ acceptedAsIs: 5, acceptedWithEdits: 0, rejected: 0, lastEventAt: daysAgo(180) }, NOW);
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  it("returns neutral, low-confidence, zero-confidence when there is no evidence", () => {
    const b = scoreCraftBelief({ acceptedAsIs: 0, acceptedWithEdits: 0, rejected: 0, lastEventAt: null }, NOW);
    expect(b.stance).toBe("neutral");
    expect(b.lowConfidence).toBe(true);
    expect(b.confidence).toBe(0);
  });

  it("keeps MIN_EVIDENCE_FOR_CONFIDENCE at 3", () => {
    expect(MIN_EVIDENCE_FOR_CONFIDENCE).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/belief.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/belief.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/dionysus-mcp/src/lib/belief.ts`:

```typescript
// Stage 5c — the pure CRAFT-belief scoring core. NO DB, NO identity, NO Date.now():
// evidence + an injected `now` in, a bounded confidence + honest labeled stance out.
//
// A 5c belief is about CRAFT — what drafts this founder accepts as-is — derived from
// real founder-acceptance behavior. It is NEVER a performance/market claim and NEVER
// carries a fabricated metric (measured-outcome beliefs are 5d). The summary reports
// raw COUNTS only. Honest guards (spec §16): an evidence-count threshold below which a
// belief is labeled low-confidence, and recency decay so stale evidence weighs less.

/** The whitelisted craft feature dimensions a belief may key on (spec §16 line 189). */
export const BELIEF_FEATURE_DIMS = ["channel", "format", "hook", "timing", "audience", "mode"] as const;

/** Below this many acceptance events, a belief is labeled low-confidence ("still learning"). */
export const MIN_EVIDENCE_FOR_CONFIDENCE = 3;

/** Recency half-life: evidence this many days old contributes half-weight to confidence. */
export const RECENCY_HALFLIFE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type FeatureEvidence = {
  acceptedAsIs: number;       // approved/executing/executed with editDistance null|0
  acceptedWithEdits: number;  // approved/executing/executed with editDistance > 0
  rejected: number;           // status "rejected" OR rejectionCount > 0
  lastEventAt: Date | null;   // most recent acceptance event (recency proxy)
};

export type BeliefStance = "positive" | "negative" | "neutral";

export type CraftBelief = {
  confidence: number;       // 0..1
  stance: BeliefStance;
  lowConfidence: boolean;   // true when evidence < MIN_EVIDENCE_FOR_CONFIDENCE
  summary: string;          // honest, counts-only prose (no fabricated metric)
};

/**
 * Canonical key from the whitelisted craft dims PRESENT (string-valued) in featuresJson,
 * sorted so key order in the JSON is irrelevant. `""` when none present / unparseable —
 * the caller skips an empty key (no belief for un-tagged actions).
 */
export function canonicalFeatureKey(featuresJson: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(featuresJson) as Record<string, unknown>;
  } catch {
    return "";
  }
  if (parsed === null || typeof parsed !== "object") return "";
  const parts: string[] = [];
  for (const dim of BELIEF_FEATURE_DIMS) {
    const value = parsed[dim];
    if (typeof value === "string" && value.length > 0) parts.push(`${dim}=${value}`);
  }
  return parts.sort().join("&");
}

/** Recency weight in (0,1]: 1 for a same-day event, halving every RECENCY_HALFLIFE_DAYS. */
function recencyWeight(lastEventAt: Date | null, now: Date): number {
  if (!lastEventAt) return 0;
  const ageDays = Math.max(0, (now.getTime() - lastEventAt.getTime()) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
}

/**
 * Score a feature's founder-acceptance evidence into a bounded confidence + honest stance.
 * positive = tends to accept as-is; negative = tends to reject / heavily edit; neutral = no
 * signal. Confidence scales with the evidence count (saturating), the accept/reject balance,
 * and recency — and is HARD-CAPPED low while evidence is thin (honest low-confidence label).
 */
export function scoreCraftBelief(evidence: FeatureEvidence, now: Date): CraftBelief {
  const { acceptedAsIs, acceptedWithEdits, rejected } = evidence;
  const total = acceptedAsIs + acceptedWithEdits + rejected;
  const lowConfidence = total < MIN_EVIDENCE_FOR_CONFIDENCE;

  if (total === 0) {
    return { confidence: 0, stance: "neutral", lowConfidence: true, summary: "Still learning — no drafts yet." };
  }

  // Net craft signal in [-1, 1]: as-is fully positive, edited half-positive, rejected fully negative.
  const positive = acceptedAsIs + 0.5 * acceptedWithEdits;
  const net = (positive - rejected) / total;
  const stance: BeliefStance = net > 0.15 ? "positive" : net < -0.15 ? "negative" : "neutral";

  // Evidence weight saturates toward 1 as counts grow; recency scales it down for stale evidence.
  const evidenceWeight = total / (total + MIN_EVIDENCE_FOR_CONFIDENCE); // 0.5 at total==MIN
  const recency = recencyWeight(evidence.lastEventAt, now);
  let confidence = Math.abs(net) * evidenceWeight * recency;
  if (lowConfidence) confidence = Math.min(confidence, 0.4); // honest cap while evidence is thin
  confidence = Math.max(0, Math.min(1, confidence));

  const counts = `${acceptedAsIs} accepted as-is, ${acceptedWithEdits} edited, ${rejected} rejected`;
  const lead =
    stance === "positive" ? "Tends to approve these drafts with little editing"
    : stance === "negative" ? "Tends to reject or heavily edit these drafts"
    : "Mixed signal so far";
  const tail = lowConfidence ? " Still learning — low confidence." : "";
  const summary = `${lead} (${counts}).${tail}`;

  return { confidence, stance, lowConfidence, summary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/belief.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/dionysus-mcp/src/lib/belief.ts packages/dionysus-mcp/test/belief.test.ts
git commit -m "feat: belief scoring core - honest evidence-weighted craft confidence from founder acceptance"
```

---

## Task 2: Belief node writer + supersede (schema + `persistCraftBelief`)

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma` (add `MemoryNode.stance String?`)
- Modify: `packages/dionysus-mcp/src/tools/memory-graph.ts` (export `isUniqueViolation`)
- Create: `packages/dionysus-mcp/src/tools/belief-graph.ts` (`persistCraftBelief`)
- Test: `packages/dionysus-mcp/test/belief-graph.test.ts`

**Interfaces:**
- Consumes: `Identity` from `../identity.js`; `prisma` from `../db.js`; `isUniqueViolation` from `./memory-graph.js`; `CraftBelief`/`BeliefStance` from `../lib/belief.js`.
- Produces:
  - `persistCraftBelief(identity: Identity, input: { role: string; featureKey: string; belief: CraftBelief }): Promise<{ beliefNodeId: string; superseded: boolean }>`
  - The live belief node: `type:"learning"`, `sourceId: "${role}::${featureKey}"`, `role`, `confidence`, `stance`, `tainted:false`, `title: "${role} · ${featureKey}"`, `body: belief.summary`.
  - Stance flip (positive↔negative) → snapshot the prior into a superseded node (`sourceId: "${role}::${featureKey}::superseded::${n}"`) + a `supersedes` edge (live → snapshot).

- [ ] **Step 1: Add the schema field, regenerate, reset the test DB**

Edit `packages/dionysus-mcp/prisma/schema.prisma` — add `stance` to `MemoryNode` (right after `confidence`):

```prisma
model MemoryNode {
  id         String   @id @default(cuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id])
  type       String   // waypoint|action|outcome|learning|market-observation|case|revision
  role       String?
  waypointId String?
  title      String
  body       String
  confidence Float
  stance     String?  // 5c: belief polarity for `learning` nodes ("positive"|"negative"|"neutral"); null for other node types
  sourceUrl  String?
  sourceId   String?
  tainted    Boolean  @default(false)
  createdAt  DateTime @default(now())

  @@unique([businessId, type, sourceId])
  @@index([businessId])
}
```

Then regenerate the client + reset the test DB:

Run: `cd D:\Dionysus\packages\dionysus-mcp; pnpm prisma generate; node prisma/reset-test-db.mjs`
Expected: client regenerated; test DB re-pushed with the new column, no error.

- [ ] **Step 2: Export `isUniqueViolation` for reuse**

Edit `packages/dionysus-mcp/src/tools/memory-graph.ts` line 6 — add `export`:

```typescript
/** True for a Prisma unique-constraint violation (P2002) — the concurrent-writer race we re-find on. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
```

- [ ] **Step 3: Write the failing test**

Create `packages/dionysus-mcp/test/belief-graph.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { persistCraftBelief } from "../src/tools/belief-graph.js";
import type { CraftBelief } from "../src/lib/belief.js";

const BIZ = "biz-belief-a";
const OTHER = "biz-belief-b";

// Business needs only { id, name } (matches the existing e2e gates). Wipe child rows scoped to the
// two tenants (FK order: edges/nodes/actions/waypoints/routes/objectives) then upsert the business.
async function resetBusinesses() {
  for (const id of [BIZ, OTHER]) {
    await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
    await prisma.memoryNode.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
}

const positive: CraftBelief = { confidence: 0.7, stance: "positive", lowConfidence: false, summary: "Tends to approve (5 as-is, 0 rejected)." };
const negative: CraftBelief = { confidence: 0.6, stance: "negative", lowConfidence: false, summary: "Tends to reject (0 as-is, 4 rejected)." };

describe("persistCraftBelief", () => {
  beforeEach(resetBusinesses);

  it("creates one live learning node keyed by role::featureKey, tainted false", async () => {
    const { beliefNodeId, superseded } = await persistCraftBelief(
      { businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    expect(superseded).toBe(false);
    const node = await prisma.memoryNode.findUnique({ where: { id: beliefNodeId } });
    expect(node?.type).toBe("learning");
    expect(node?.role).toBe("copywriter");
    expect(node?.sourceId).toBe("copywriter::channel=linkedin");
    expect(node?.stance).toBe("positive");
    expect(node?.confidence).toBeCloseTo(0.7);
    expect(node?.tainted).toBe(false);
  });

  it("updates the live node in place on corroboration (same stance) — zero new rows", async () => {
    const first = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const stronger: CraftBelief = { ...positive, confidence: 0.85, summary: "Tends to approve (8 as-is, 0 rejected)." };
    const second = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: stronger });

    expect(second.beliefNodeId).toBe(first.beliefNodeId); // same live node
    expect(second.superseded).toBe(false);
    const learningNodes = await prisma.memoryNode.findMany({ where: { businessId: BIZ, type: "learning" } });
    expect(learningNodes).toHaveLength(1); // updated in place, no snapshot
    expect(learningNodes[0]?.confidence).toBeCloseTo(0.85);
    expect(learningNodes[0]?.body).toContain("8 as-is");
  });

  it("snapshots + supersedes when the stance flips positive→negative", async () => {
    const first = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const flipped = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: negative });

    // Live node stays the same id, now negative.
    expect(flipped.beliefNodeId).toBe(first.beliefNodeId);
    expect(flipped.superseded).toBe(true);
    const live = await prisma.memoryNode.findUnique({ where: { id: flipped.beliefNodeId } });
    expect(live?.stance).toBe("negative");

    // A stale snapshot exists and is the toId of a supersedes edge from the live node.
    const snapshot = await prisma.memoryNode.findFirst({ where: { businessId: BIZ, type: "learning", sourceId: "copywriter::channel=linkedin::superseded::0" } });
    expect(snapshot?.stance).toBe("positive"); // the prior belief, preserved
    const edge = await prisma.memoryEdge.findFirst({ where: { businessId: BIZ, kind: "supersedes", fromId: flipped.beliefNodeId, toId: snapshot?.id } });
    expect(edge).not.toBeNull();
  });

  it("scopes to the caller's business — the same key in another tenant is a separate node", async () => {
    const a = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const b = await persistCraftBelief({ businessId: OTHER }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    expect(b.beliefNodeId).not.toBe(a.beliefNodeId);
    const aNodes = await prisma.memoryNode.findMany({ where: { businessId: BIZ, type: "learning" } });
    const bNodes = await prisma.memoryNode.findMany({ where: { businessId: OTHER, type: "learning" } });
    expect(aNodes).toHaveLength(1);
    expect(bNodes).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/belief-graph.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/belief-graph.js'`.

- [ ] **Step 5: Write minimal implementation**

Create `packages/dionysus-mcp/src/tools/belief-graph.ts` (this step adds `persistCraftBelief` only; `deriveCraftBeliefs`/`listCraftBeliefs` land in Task 3):

```typescript
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { isUniqueViolation } from "./memory-graph.js";
import type { CraftBelief } from "../lib/belief.js";

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

  // No live node yet — create it (concurrency: a racing writer may win; re-find on P2002).
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

  // A stance FLIP (positive↔negative) is a contradiction — snapshot the prior + supersedes edge.
  const isFlip =
    (existing.stance === "positive" && belief.stance === "negative") ||
    (existing.stance === "negative" && belief.stance === "positive");

  let superseded = false;
  if (isFlip) {
    // Deterministic snapshot index (no Date needed): count existing snapshots for this belief.
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
    // supersedes: NEW (live) → STALE (snapshot). Edge dedup is inherent (fresh snapshot id).
    await prisma.memoryEdge.create({
      data: { businessId: identity.businessId, fromId: existing.id, toId: snapshot.id, kind: "supersedes" },
    });
    superseded = true;
  }

  // Update the live node in place (immutable Prisma update — new row state, same id).
  await prisma.memoryNode.update({
    where: { id: existing.id },
    data: { body: belief.summary, confidence: belief.confidence, stance: belief.stance, title },
  });
  return { beliefNodeId: existing.id, superseded };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/belief-graph.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add packages/dionysus-mcp/prisma/schema.prisma packages/dionysus-mcp/src/tools/memory-graph.ts packages/dionysus-mcp/src/tools/belief-graph.ts packages/dionysus-mcp/test/belief-graph.test.ts
git commit -m "feat: persistCraftBelief - one live belief node per role+feature, snapshot+supersede on stance flip"
```

---

## Task 3: Belief derivation orchestration (`deriveCraftBeliefs` + `listCraftBeliefs`)

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/belief-graph.ts` (add `deriveCraftBeliefs`, `listCraftBeliefs`)
- Test: extend `packages/dionysus-mcp/test/belief-graph.test.ts`

**Interfaces:**
- Consumes: everything from Task 2 + `canonicalFeatureKey`, `scoreCraftBelief`, `type FeatureEvidence` from `../lib/belief.js`.
- Produces:
  - `deriveCraftBeliefs(identity: Identity, input: { routeId: string }, now: Date): Promise<{ beliefNodeIds: string[]; supersededCount: number }>` — scoped scan of the route's actions across ALL statuses → group by `(employeeRole, canonicalFeatureKey)` (skip empty keys) → aggregate `FeatureEvidence` → `scoreCraftBelief` → `persistCraftBelief` → wire `informed-by` edges from the belief node to each contributing **action mirror node** (found by `type:"action", sourceId=action.id`; skipped if the action was never mirrored). Scoped, idempotent, lazy-safe.
  - `type CraftBeliefView = { title: string; body: string; confidence: number; stance: string; role: string }`
  - `listCraftBeliefs(identity: Identity, opts?: { role?: string; limit?: number }): Promise<CraftBeliefView[]>` — LIVE, non-superseded (`sourceId` NOT containing `"::superseded::"` AND not the `toId` of a `supersedes` edge) belief nodes, optionally role-filtered, ordered by confidence desc.

- [ ] **Step 1: Write the failing test (append to `belief-graph.test.ts`)**

```typescript
import { deriveCraftBeliefs, listCraftBeliefs } from "../src/tools/belief-graph.js";
import { mirrorPlanToGraph } from "../src/tools/memory-graph.js";
import { createObjective, persistRoute, persistWaypoint } from "../src/tools/plan.js";

const NOW = new Date("2026-07-11T00:00:00.000Z");

// Minimal plan seed: one route, one waypoint, N actions with given status/editDistance/features.
// Objective/Route/Waypoint go through the REAL plan-layer tools (correct required-field shapes);
// actions are raw creates so we can set status/editDistance/featuresJson precisely for the evidence.
async function seedRoute(businessId: string, actions: Array<{ role: string; features: object; status: string; editDistance: number | null }>) {
  const id = { businessId };
  const { objectiveId } = await createObjective(id, { kind: "growth", target: "100 signups", metric: "signups" });
  const { routeId } = await persistRoute(id, { objectiveId, source: "composed" });
  const { waypointId } = await persistWaypoint(id, { routeId, order: 1, title: "W1", goal: "ship" });
  for (const a of actions) {
    await prisma.routeAction.create({ data: {
      businessId, waypointId, employeeRole: a.role, type: "post", status: a.status,
      featuresJson: JSON.stringify(a.features), editDistance: a.editDistance } });
  }
  return { routeId, waypointId };
}

describe("deriveCraftBeliefs", () => {
  beforeEach(resetBusinesses);

  it("forms a positive belief when the founder approves a feature's drafts as-is", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "executed", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: null },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, routeId, NOW); // action nodes exist for informed-by wiring
    const { beliefNodeIds } = await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    expect(beliefNodeIds).toHaveLength(1);
    const node = await prisma.memoryNode.findUnique({ where: { id: beliefNodeIds[0]! } });
    expect(node?.stance).toBe("positive");
    // Honesty: informed-by edges wire the belief to REAL action nodes (no free-floating assertion).
    const informedBy = await prisma.memoryEdge.findMany({ where: { businessId: BIZ, fromId: beliefNodeIds[0]!, kind: "informed-by" } });
    expect(informedBy.length).toBeGreaterThanOrEqual(1);
    for (const e of informedBy) {
      const target = await prisma.memoryNode.findUnique({ where: { id: e.toId } });
      expect(target?.type).toBe("action");
    }
  });

  it("flips a belief to negative when the acceptance signal reverses (drives supersede)", async () => {
    const first = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "x" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "x" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "x" }, status: "executed", editDistance: 0 },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, first.routeId, NOW);
    const before = await deriveCraftBeliefs({ businessId: BIZ }, { routeId: first.routeId }, NOW);
    expect((await prisma.memoryNode.findUnique({ where: { id: before.beliefNodeIds[0]! } }))?.stance).toBe("positive");

    // A second route for the SAME feature, now rejected — re-derive against it.
    const second = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "x" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "x" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "x" }, status: "rejected", editDistance: null },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, second.routeId, NOW);
    const after = await deriveCraftBeliefs({ businessId: BIZ }, { routeId: second.routeId }, NOW);
    expect(after.supersededCount).toBe(1);
    expect((await prisma.memoryNode.findUnique({ where: { id: after.beliefNodeIds[0]! } }))?.stance).toBe("negative");
  });

  it("is idempotent on unchanged evidence — a second derive adds zero learning rows", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, routeId, NOW);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const countAfterFirst = await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } });
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const countAfterSecond = await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } });
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("skips actions with no whitelisted feature tags (empty key → no belief)", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { radar: true }, status: "approved", editDistance: 0 },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, routeId, NOW);
    const { beliefNodeIds } = await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    expect(beliefNodeIds).toHaveLength(0);
  });

  it("throws on a cross-tenant routeId before any write", async () => {
    const { routeId } = await seedRoute(OTHER, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await expect(deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW)).rejects.toThrow(/not found/i);
    expect(await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } })).toBe(0);
  });
});

describe("listCraftBeliefs", () => {
  beforeEach(resetBusinesses);

  it("returns live beliefs ordered by confidence, excluding superseded snapshots", async () => {
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: negative }); // flips → snapshot
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=x", belief: { confidence: 0.9, stance: "positive", lowConfidence: false, summary: "strong" } });

    const beliefs = await listCraftBeliefs({ businessId: BIZ });
    // Two LIVE beliefs (linkedin now-negative + x); the positive linkedin snapshot is excluded.
    expect(beliefs).toHaveLength(2);
    expect(beliefs[0]?.confidence).toBeGreaterThanOrEqual(beliefs[1]?.confidence ?? 0);
    expect(beliefs.some((b) => b.title.includes("superseded"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/belief-graph.test.ts`
Expected: FAIL — `deriveCraftBeliefs`/`listCraftBeliefs` are not exported.

- [ ] **Step 3: Write minimal implementation (append to `belief-graph.ts`)**

Add these imports at the top of `belief-graph.ts`:

```typescript
import { canonicalFeatureKey, scoreCraftBelief, type FeatureEvidence } from "../lib/belief.js";
```

Append:

```typescript
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

  // Group evidence + the contributing action ids by (role, featureKey).
  type Group = { evidence: FeatureEvidence; actionIds: string[] };
  const groups = new Map<string, Group>();
  for (const action of actions) {
    const featureKey = canonicalFeatureKey(action.featuresJson);
    if (featureKey === "") continue; // no whitelisted tags → no belief
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

    // Honesty guard: wire `informed-by` edges from the belief to each contributing ACTION mirror
    // node (skip any action not yet mirrored). Deduped inside persistMemoryEdge via its own path —
    // here we create directly and swallow the P2002 dup (idempotent re-derivation).
    for (const actionId of group.actionIds) {
      const actionNode = await prisma.memoryNode.findFirst({ where: { businessId: identity.businessId, type: "action", sourceId: actionId } });
      if (!actionNode) continue;
      const existing = await prisma.memoryEdge.findFirst({ where: { businessId: identity.businessId, fromId: beliefNodeId, toId: actionNode.id, kind: "informed-by" } });
      if (existing) continue;
      try {
        await prisma.memoryEdge.create({ data: { businessId: identity.businessId, fromId: beliefNodeId, toId: actionNode.id, kind: "informed-by" } });
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) throw error; // a racing writer created the same edge — fine
      }
    }
  }

  return { beliefNodeIds, supersededCount };
}

export type CraftBeliefView = { title: string; body: string; confidence: number; stance: string; role: string };

/**
 * The LIVE, non-superseded craft beliefs for the business (optionally role-filtered), ordered by
 * confidence desc. Superseded snapshots are excluded two ways: their sourceId carries the
 * "::superseded::" marker AND they are the `toId` of a `supersedes` edge. Scoped read, no writes.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/belief-graph.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/dionysus-mcp/src/tools/belief-graph.ts packages/dionysus-mcp/test/belief-graph.test.ts
git commit -m "feat: deriveCraftBeliefs - scoped feature-grouped belief derivation with informed-by evidence wiring"
```

---

## Task 4: Honest labeled recall (`buildAgentContext.learnings` + `draftWaypoint` wiring)

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/memory-graph.ts` (`buildAgentContext`: fill `learnings`, extend `text`)
- Modify: `packages/department/src/draft-waypoint.ts` (call `deriveCraftBeliefs` in the best-effort block)
- Test: extend `packages/dionysus-mcp/test/memory-graph.test.ts` + `packages/department/test/draft-waypoint.test.ts`

**Interfaces:**
- Consumes: `listCraftBeliefs` (via a direct query in `buildAgentContext`), `deriveCraftBeliefs` from `dionysus-mcp/tools/belief-graph` (department import).
- Produces: `buildAgentContext` returns role-scoped, non-superseded beliefs in `learnings` (already-typed field) and renders them under a labeled hypotheses heading in `text`.

- [ ] **Step 1: Write the failing test (append to `memory-graph.test.ts`)**

```typescript
describe("buildAgentContext learnings (5c)", () => {
  // Uses the file's existing seed helpers/business constants. Adjust names to match the file.
  it("surfaces role-scoped live beliefs as labeled hypotheses, excludes superseded, and never claims a metric", async () => {
    // Arrange: a mirrored route (so ancestorPath is non-empty) + a live copywriter belief + a superseded one.
    const { routeId, waypointId } = await seedMirroredRoute(BIZ); // existing helper that mirrors a route
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: { confidence: 0.8, stance: "positive", lowConfidence: false, summary: "Tends to approve these drafts with little editing (5 accepted as-is, 0 rejected)." } });
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: { confidence: 0.6, stance: "negative", lowConfidence: false, summary: "Tends to reject these drafts (0 accepted as-is, 4 rejected)." } }); // flips → snapshot
    await persistCraftBelief({ businessId: BIZ }, { role: "strategist", featureKey: "channel=x", belief: { confidence: 0.9, stance: "positive", lowConfidence: false, summary: "strategist craft" } });

    // Act
    const ctx = await buildAgentContext({ businessId: BIZ }, { routeId, waypointId, role: "copywriter" });

    // Assert: only the LIVE copywriter belief surfaces (role-scoped, superseded excluded, other role excluded).
    expect(ctx.learnings).toHaveLength(1);
    expect(ctx.learnings[0]?.body).toContain("reject"); // the live (negative) belief, not the superseded positive
    // The prompt text renders it under a hypotheses heading, labeled — never as a metric.
    expect(ctx.text.toLowerCase()).toContain("learned");
    expect(ctx.text).not.toMatch(/%|percent|conversion|engagement|impressions/i);
  });

  it("keeps learnings empty for a role with no beliefs (forward-compatible, no throw)", async () => {
    const { routeId, waypointId } = await seedMirroredRoute(BIZ);
    const ctx = await buildAgentContext({ businessId: BIZ }, { routeId, waypointId, role: "copywriter" });
    expect(ctx.learnings).toEqual([]);
  });
});
```

*Note to implementer:* reuse the existing `memory-graph.test.ts` seed helpers/business constants; if a `seedMirroredRoute` helper does not exist, add a small local one that creates+mirrors a one-waypoint route (mirror via `mirrorPlanToGraph`). Import `persistCraftBelief` from `../src/tools/belief-graph.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/memory-graph.test.ts`
Expected: FAIL — `learnings` is empty / `text` lacks the "learned" heading.

- [ ] **Step 3: Implement — fill `learnings` + extend `text` in `buildAgentContext`**

In `memory-graph.ts`, replace the learnings block (currently lines ~242-246) with a live/non-superseded query ordered by confidence:

```typescript
  // Learnings = role-scoped LIVE `learning` beliefs (5c). Exclude superseded snapshots (their
  // sourceId carries the "::superseded::" marker). Ordered by confidence desc, capped by maxItems.
  // These are CRAFT hypotheses (what the founder tends to accept), NEVER performance/metric claims.
  const learningNodes = await prisma.memoryNode.findMany({
    where: {
      businessId: identity.businessId, type: "learning",
      NOT: { sourceId: { contains: "::superseded::" } },
      ...(input.role ? { role: input.role } : {}),
    },
    orderBy: { confidence: "desc" }, take: maxItems });
  const learnings = learningNodes.map((n) => ({ title: n.title, body: n.body, confidence: n.confidence }));
```

Then extend the `text` rendering (after the `Done:` loop, before `const text = lines.join("\n")`):

```typescript
  // Labeled craft hypotheses — rendered as "what I've learned so far", NEVER as fact/metric.
  if (learnings.length > 0) {
    lines.push("What I've learned about your drafts so far (still learning where evidence is thin):");
    for (const l of learnings) {
      lines.push(`- ${l.body}`);
    }
  }
```

- [ ] **Step 4: Run the mcp test to verify it passes**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/memory-graph.test.ts`
Expected: PASS. Then rebuild the dist for the department import:
Run: `cd D:\Dionysus\packages\dionysus-mcp; pnpm build`
Expected: `tsc` clean.

- [ ] **Step 5: Write the failing department test (append to `draft-waypoint.test.ts`)**

```typescript
it("derives craft beliefs then recalls them into the prompt — best-effort, never breaks drafting", async () => {
  // Arrange: a business + route + waypoint + a proposed action to draft, PLUS prior accepted
  // history for a feature so a belief forms. (Reuse the file's existing seed helpers.)
  const { identity, waypointId, routeId } = await seedDraftableWaypoint(); // existing/added helper
  await seedAcceptedHistory(identity, routeId, { channel: "linkedin", count: 3 }); // approved as-is ×3
  const harness = new CapturingHarness(); // existing fake that records the prompt it receives

  // Act
  await draftWaypoint(identity, { waypointId }, { harness, models: { brain: "test-model" } });

  // Assert: the belief was derived and recalled into the fenced route-so-far block.
  const beliefs = await prisma.memoryNode.findMany({ where: { businessId: identity.businessId, type: "learning" } });
  expect(beliefs.length).toBeGreaterThanOrEqual(1);
  expect(harness.lastPrompt).toContain("What I've learned");
});
```

*Note to implementer:* mirror the existing best-effort recall test's harness/seed patterns already in `draft-waypoint.test.ts` (it has a capturing harness and route/waypoint seeds from the 5b tests). Keep the belief-derivation assertion tolerant (`>= 1`).

- [ ] **Step 6: Run to verify it fails**

Run: `cd D:\Dionysus\packages\department; pnpm vitest run test/draft-waypoint.test.ts`
Expected: FAIL — no belief nodes / prompt lacks "What I've learned".

- [ ] **Step 7: Wire `deriveCraftBeliefs` into `draftWaypoint`'s best-effort block**

In `draft-waypoint.ts`, add the import:

```typescript
import { mirrorPlanToGraph, buildAgentContext } from "dionysus-mcp/tools/memory-graph";
import { deriveCraftBeliefs } from "dionysus-mcp/tools/belief-graph";
```

Inside the existing best-effort `try` (between `mirrorPlanToGraph` and `buildAgentContext`), add the derive call:

```typescript
  try {
    const now = new Date();
    await mirrorPlanToGraph(identity, wp.routeId, now);
    await deriveCraftBeliefs(identity, { routeId: wp.routeId }, now); // 5c: update craft beliefs before recall
    const routeContext = await buildAgentContext(identity, {
      routeId: wp.routeId, waypointId: input.waypointId, role: "copywriter" });
    if (routeContext.text) routeContextBlock = fence("route-so-far", routeContext.text);
  } catch (error: unknown) {
    console.error(`draftWaypoint: route recall unavailable (${error instanceof Error ? error.message : "unknown"}) — drafting without prior context.`);
  }
```

*(The `now` is reused for both mirror + derive so the recall is internally consistent. Everything stays inside the same best-effort catch — a belief failure degrades to drafting-without-context, exactly like a mirror failure.)*

- [ ] **Step 8: Run department + mcp suites to verify green**

Run: `cd D:\Dionysus\packages\department; pnpm vitest run test/draft-waypoint.test.ts`
Expected: PASS. Then the full dept suite: `pnpm vitest run` (expect all green).

- [ ] **Step 9: Commit**

```bash
git add packages/dionysus-mcp/src/tools/memory-graph.ts packages/dionysus-mcp/test/memory-graph.test.ts packages/department/src/draft-waypoint.ts packages/department/test/draft-waypoint.test.ts
git commit -m "feat: the copywriter recalls learned craft - beliefs surface as labeled hypotheses, derived best-effort before drafting"
```

---

## Task 5: Cockpit "What I've learned" read surface

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (add `getCraftBeliefs`)
- Create: `packages/cockpit/src/app/learned/page.tsx`
- Modify: the cockpit nav (wherever the existing `Timeline`/`Radar` links live) to add a `Learned` link
- Test: extend `packages/cockpit/test/review.test.ts`

**Interfaces:**
- Consumes: `listCraftBeliefs` from `dionysus-mcp/tools/belief-graph`; the existing `requireSession` identity helper.
- Produces: `getCraftBeliefs(): Promise<CraftBeliefView[]>` — session-scoped wrapper; a page that lists each belief's body + a confidence label, honestly. No metric, JSX-escaped.

- [ ] **Step 1: Write the failing test (append to `review.test.ts`)**

```typescript
import { getCraftBeliefs } from "../src/lib/review";

describe("getCraftBeliefs", () => {
  it("returns the session business's live beliefs, scoped", async () => {
    // Arrange: seed a belief for the test session business (reuse the file's session/seed helpers).
    await persistCraftBelief({ businessId: TEST_BUSINESS_ID }, { role: "copywriter", featureKey: "channel=linkedin", belief: { confidence: 0.8, stance: "positive", lowConfidence: false, summary: "Tends to approve (5 accepted as-is, 0 rejected)." } });
    await persistCraftBelief({ businessId: OTHER_BUSINESS_ID }, { role: "copywriter", featureKey: "channel=x", belief: { confidence: 0.9, stance: "positive", lowConfidence: false, summary: "other tenant" } });

    const beliefs = await getCraftBeliefs();
    expect(beliefs.map((b) => b.body)).toContain("Tends to approve (5 accepted as-is, 0 rejected).");
    expect(beliefs.some((b) => b.body === "other tenant")).toBe(false); // scoped out
  });
});
```

*Note to implementer:* reuse `review.test.ts`'s existing session-mock + business constants (`TEST_BUSINESS_ID`, and add an `OTHER_BUSINESS_ID` if not present). Import `persistCraftBelief` from `dionysus-mcp/tools/belief-graph`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd D:\Dionysus\packages\cockpit; $env:DATABASE_URL="file:./.tmp/test.db"; $env:COCKPIT_SESSION_SECRET="test-secret"; pnpm vitest run test/review.test.ts`
Expected: FAIL — `getCraftBeliefs` not exported.

- [ ] **Step 3: Implement `getCraftBeliefs`**

In `review.ts`, add the import and the wrapper (mirroring the existing `listRadarObservations`/`getTimeline` session-scoping pattern):

```typescript
import { listCraftBeliefs, type CraftBeliefView } from "dionysus-mcp/tools/belief-graph";

export async function getCraftBeliefs(): Promise<CraftBeliefView[]> {
  const identity = await requireSession();
  return listCraftBeliefs(identity, { limit: 50 });
}
```

- [ ] **Step 4: Create the page**

Create `packages/cockpit/src/app/learned/page.tsx`:

```tsx
import { getCraftBeliefs } from "../../lib/review";

export const dynamic = "force-dynamic";

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.6) return "confident";
  if (confidence >= 0.3) return "some evidence";
  return "still learning";
}

export default async function LearnedPage() {
  const beliefs = await getCraftBeliefs();
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <h1>What I&apos;ve learned about your drafts</h1>
      <p style={{ color: "#555" }}>
        These are craft observations from how you review drafts — what you approve as-is versus edit or reject.
        They are hypotheses, not performance claims; I show them honestly and label low confidence where evidence is thin.
      </p>
      {beliefs.length === 0 ? (
        <p>Nothing learned yet — I&apos;ll start noticing patterns as you review drafts.</p>
      ) : (
        <ul>
          {beliefs.map((b, i) => (
            <li key={i} style={{ marginBottom: 12 }}>
              <strong>{b.title}</strong> <em>({confidenceLabel(b.confidence)})</em>
              <div>{b.body}</div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

Add a `Learned` nav link next to the existing `Timeline`/`Radar` links (match the existing nav component's markup).

- [ ] **Step 5: Run the cockpit test + build**

Run: `cd D:\Dionysus\packages\cockpit; $env:DATABASE_URL="file:./.tmp/test.db"; $env:COCKPIT_SESSION_SECRET="test-secret"; pnpm vitest run test/review.test.ts`
Expected: PASS. Then: `pnpm exec next build`
Expected: clean build; `/learned` emitted as `ƒ` (dynamic).

- [ ] **Step 6: Commit**

```bash
git add packages/cockpit/src/lib/review.ts packages/cockpit/src/app/learned/page.tsx packages/cockpit/test/review.test.ts packages/cockpit/src/app
git commit -m "feat: cockpit /learned - honest, labeled view of what Dionysus has learned about your drafts"
```

---

## Task 6: §15 eval gate

**Files:**
- Create: `packages/dionysus-mcp/test/craft-belief-eval.e2e.test.ts`

**Interfaces:** consumes everything above through the public function surface (`deriveCraftBeliefs`, `buildAgentContext`, `listCraftBeliefs`, `mirrorPlanToGraph`) + `TOOL_SCHEMAS` for the whitelist pin.

The gate pins the honesty invariants NON-VACUOUSLY (each assertion must fail if the property it guards is broken — prefer mutation-provable contrasts over existence checks).

- [ ] **Step 1: Write the eval gate**

Create `packages/dionysus-mcp/test/craft-belief-eval.e2e.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { deriveCraftBeliefs, listCraftBeliefs } from "../src/tools/belief-graph.js";
import { mirrorPlanToGraph, buildAgentContext } from "../src/tools/memory-graph.js";
import { createObjective, persistRoute, persistWaypoint } from "../src/tools/plan.js";
import { TOOL_SCHEMAS } from "../src/server.js"; // the 11-tool whitelist source used by every prior gate

// Namespaced tenants so this gate never collides with the other e2e suites sharing the test DB.
const BIZ = "biz_crafteval_a";
const GHOST = "biz_crafteval_b";
const NOW = new Date("2026-07-11T00:00:00.000Z");

async function reset() {
  for (const id of [BIZ, GHOST]) {
    await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
    await prisma.memoryNode.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
}

// Objective/Route/Waypoint via the REAL plan tools; actions raw so the acceptance signal is exact.
async function seedRoute(businessId: string, actions: Array<{ role: string; features: object; status: string; editDistance: number | null }>) {
  const id = { businessId };
  const { objectiveId } = await createObjective(id, { kind: "growth", target: "100 signups", metric: "signups" });
  const { routeId } = await persistRoute(id, { objectiveId, source: "composed" });
  const { waypointId } = await persistWaypoint(id, { routeId, order: 1, title: "W1", goal: "ship" });
  for (const a of actions) {
    await prisma.routeAction.create({ data: { businessId, waypointId, employeeRole: a.role, type: "post", status: a.status, featuresJson: JSON.stringify(a.features), editDistance: a.editDistance } });
  }
  await mirrorPlanToGraph(id, routeId, NOW);
  return { routeId, waypointId };
}

describe("craft-belief eval gate (§15)", () => {
  beforeEach(reset);

  it("inv1 — belief polarity tracks the REAL acceptance signal (mutation-provable): accept→positive, reject→negative", async () => {
    const accepted = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "executed", editDistance: 0 },
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId: accepted.routeId }, NOW);
    const posBeliefs = await listCraftBeliefs({ businessId: BIZ }, { role: "copywriter" });
    expect(posBeliefs[0]?.stance).toBe("positive"); // flips to "negative" if the signal were ignored

    // Same feature, now rejected → the belief must flip negative + supersede the positive.
    const rejected = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
    ]);
    const after = await deriveCraftBeliefs({ businessId: BIZ }, { routeId: rejected.routeId }, NOW);
    expect(after.supersededCount).toBe(1);
    expect((await listCraftBeliefs({ businessId: BIZ }, { role: "copywriter" }))[0]?.stance).toBe("negative");
  });

  it("inv2 — thin evidence is labeled low-confidence and carries NO fabricated metric", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 }, // single event → thin
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const beliefs = await listCraftBeliefs({ businessId: BIZ });
    expect(beliefs[0]?.confidence).toBeLessThan(0.5);
    expect(beliefs[0]?.body.toLowerCase()).toContain("still learning");
    // Honesty: the belief body reports counts only — never a percentage / performance metric.
    expect(beliefs[0]?.body).not.toMatch(/%|percent|conversion|engagement|impressions|clicks|reach/i);
  });

  it("inv3 — beliefs link to REAL action nodes via informed-by (no free-floating assertion)", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    const { beliefNodeIds } = await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const edges = await prisma.memoryEdge.findMany({ where: { businessId: BIZ, fromId: beliefNodeIds[0]!, kind: "informed-by" } });
    expect(edges.length).toBeGreaterThanOrEqual(1);
    for (const e of edges) {
      const target = await prisma.memoryNode.findUnique({ where: { id: e.toId } });
      expect(target?.type).toBe("action"); // real evidence, not a phantom
    }
  });

  it("inv4 — recall renders live beliefs as LABELED hypotheses, excludes superseded, never a metric", async () => {
    // Build a positive-then-negative belief (superseded) + read it back through recall.
    const a = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId: a.routeId }, NOW);
    const b = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId: b.routeId }, NOW);

    const ctx = await buildAgentContext({ businessId: BIZ }, { routeId: b.routeId, waypointId: b.waypointId, role: "copywriter" });
    expect(ctx.learnings).toHaveLength(1); // only the live (negative) belief, not the superseded positive
    expect(ctx.learnings[0]?.body.toLowerCase()).toContain("reject");
    expect(ctx.text.toLowerCase()).toContain("learned"); // labeled hypotheses heading
    expect(ctx.text).not.toMatch(/%|percent|conversion|engagement|impressions|clicks|reach/i);
  });

  it("inv5 — businessId-scoped: a ghost tenant with its own belief never leaks into recall", async () => {
    const ghost = await seedRoute(GHOST, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await deriveCraftBeliefs({ businessId: GHOST }, { routeId: ghost.routeId }, NOW);
    // BIZ has its own empty route.
    const mine = await seedRoute(BIZ, []);
    const ctx = await buildAgentContext({ businessId: BIZ }, { routeId: mine.routeId, waypointId: mine.waypointId, role: "copywriter" });
    expect(ctx.learnings).toEqual([]); // ghost's belief is invisible
    expect(await listCraftBeliefs({ businessId: BIZ })).toEqual([]);
    expect((await listCraftBeliefs({ businessId: GHOST })).length).toBeGreaterThan(0); // ghost's belief exists — proves the scope filter is load-bearing
  });

  it("inv6 — the belief layer is NOT MCP: whitelist stays exactly 11, no belief/context tool", () => {
    // Same source + shape as agent-context-eval.e2e.test.ts inv7 (Object.keys(TOOL_SCHEMAS)).
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    expect(toolNames).not.toContain("build_agent_context");
    expect(toolNames).not.toContain("persist_learning");
    expect(toolNames).not.toContain("persist_craft_belief");
    expect(toolNames).not.toContain("derive_craft_beliefs");
  });
});
```

- [ ] **Step 2: Run the gate**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/craft-belief-eval.e2e.test.ts`
Expected: PASS (all 6 invariants).

- [ ] **Step 3: Run the full mcp suite**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run`
Expected: all green (236 baseline + the new belief/gate tests).

- [ ] **Step 4: Commit**

```bash
git add packages/dionysus-mcp/test/craft-belief-eval.e2e.test.ts
git commit -m "test: stage-5c eval gate - craft beliefs are honest, evidence-tracking, supersede-correct, scoped, non-MCP"
```

---

## Self-Review

**1. Spec coverage.** §16 learning-loop mechanisms 1 (feature-tagged attribution) and 2 (evidence-weighted belief layer with confidence, recency decay, supersede) are delivered honestly for the CRAFT signal available pre-measurement; mechanism 3 (market sensing) already exists (radar, 4e); mechanism 4 (explore/exploit decision policy) is deferred with rationale (see Out of Scope). §16 "Honest guards" (evidence threshold, recency decay, low-confidence labeling, links-to-real-nodes, no free-floating assertions) are each pinned by a test. §10 `learning` node + `supersedes`/`informed-by` edges + role tagging: covered. §17 item 5 "the learning loop (feature-tagged attribution, evidence-weighted beliefs)" — covered for craft; "explore/exploit" + "analytics integration (D21)" remain later sub-stages.

**2. Placeholder scan.** No "TBD"/"add error handling"/"similar to Task N". Every code step carries complete code; the two "reuse the existing helper" notes (T4/T5 seed helpers, T6 whitelist source) point at concrete existing patterns in named files, not vague instructions.

**3. Type consistency.** `CraftBelief`/`FeatureEvidence`/`BeliefStance` defined in T1, consumed unchanged in T2/T3. `persistCraftBelief` signature identical across T2 (def) and T3/T4/T5 (calls). `deriveCraftBeliefs(identity, {routeId}, now)` — the `now` third-arg is consistent T3↔T4. `listCraftBeliefs`/`CraftBeliefView` defined T3, consumed T5. `buildAgentContext` keeps its exact `AgentContext` shape (T4 only fills `learnings` + extends `text`).

## Out of Scope (deferred, with rationale)

- **Measured-outcome (performance) beliefs** → **5d** (analytics/D21). 5c beliefs are craft-only (founder acceptance). Per spec Priming (line 196) real outcomes are weighted highest and override craft priors as they arrive — that plug-in is 5d, which also flips the CMO report's `analyticsConnected` to true.
- **Explore/exploit decision policy + next-action recommender + Growth Analyst re-personalization** → its own sub-stage. It NEEDS the belief layer this builds; until then beliefs INFORM the copywriter (labeled recall) but never auto-decide (drafts-only, D20).
- **Exposing `build_agent_context` / `persist_learning` / `persist_memory` as MCP tools** → **6a** (when a platform-hosted agent calls across the tool boundary). Whitelist stays 11 — no tool surface that nothing calls.
- **`graphify` consolidation / clustering** → stage 7 (spec §17). 5c keeps one live node per (role, featureKey); consolidation of many beliefs is later.
- **Prisma-gates-Hermes skill self-improvement** (spec line 198) → N/A on the D34 runtime (no Hermes). The "evidence gates procedural change" principle is honored by the confidence threshold; there is no skill-mutation target to promote into.

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh Opus subagent per task, review between tasks, whole-branch review at the end.
2. **Inline Execution** — execute in this session with checkpoints.
