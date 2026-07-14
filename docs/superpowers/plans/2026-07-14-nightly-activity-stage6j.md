# Nightly Activity Panel (Stage 6j — liveness made visible) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The spec's stage-7 "live-activity panel", honestly scoped: every `runNightly` persists a per-night, per-business **activity record** — the NINE section results verbatim, including skips and failures — and the cockpit gains `/activity` ("While you slept"): the founder sees exactly what Dionysus did, didn't do, and why. This is the D31 liveness USP + §16 outcome-accountability made visible: the account of work, not just the work's outputs.

**Architecture:** A new `NightlyRun` row (businessId, ranAt, sectionsJson) written **best-effort** at the end of `runNightly` — the diary must never fail the night. The write lives in dionysus-mcp (`recordNightlyRun`, non-MCP like every persist); the read lives in cockpit's review.ts (`listNightlyActivity`, defensive parse). The record is the RETURNED result verbatim — no summarizing, no ok-washing. The sweep's belt-and-suspenders catch does NOT write a record (runNightly never throws by design; if it ever did, that night honestly has no diary — documented, not silently papered over with untestable defensive code).

**Tech Stack:** No new dependencies. FIRST schema change since 5d: one additive model. dionysus-mcp + department + cockpit.

## Global Constraints

- **VERBATIM RECORD (the honesty core):** `sectionsJson` is `JSON.stringify` of the exact section map `runNightly` returns — a failed section records `failed` with its real reason; a skipped section records its real skip reason. Nothing is renamed, summarized, or softened anywhere between `runNightly` and the founder's screen.
- **THE DIARY NEVER FAILS THE NIGHT:** the record write is wrapped in its own try/catch (console.error, continue) — a recording failure must not change `runNightly`'s return value or any section's outcome.
- **Write-layer validation:** `recordNightlyRun` rejects an empty section map or any section whose `status` is not `"ok" | "skipped" | "failed"` (never store a malformed diary).
- **NOT MCP:** `record_nightly_run` is NOT registered; `TOOL_SCHEMAS` stays **11**.
- **D27.1:** businessId only from identity (write) / session (read); cross-tenant impossible on both paths.
- **Schema change is ADDITIVE:** one new model + the `Business` back-relation field; no existing column touched. After the schema/mcp change: `pnpm --filter dionysus-mcp build` BEFORE dept/cockpit suites (both import the built dist; test DBs re-`db push` via their pretest reset scripts).
- **No `console.log` in src; ESM `.js` specifiers; cockpit page follows the /pitch page conventions (server component, session identity, JSX text children only).**
- **Ops:** PowerShell only (Git Bash broken). mcp tests: `$env:DATABASE_URL="file:./.tmp/test.db"`. cockpit: that plus `$env:COCKPIT_SESSION_SECRET="test-secret"`.
- **Baselines at stage start:** mcp **352**, dept **198**, cockpit **69**.

**Deferred (documented):** retention/pruning of old NightlyRun rows (tiny rows; revisit at platform scale); a sweep-catch fallback record (untestable defensive code for a by-design-unreachable path); surfacing the record on `/` (progress home) — `/activity` is the dedicated surface first.

---

## Task 1: `NightlyRun` model + `recordNightlyRun` (dionysus-mcp)

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma` (new model + `Business` back-relation `nightlyRuns NightlyRun[]`)
- Create: `packages/dionysus-mcp/src/tools/nightly-run.ts`
- Test: `packages/dionysus-mcp/test/nightly-run.test.ts`

**Schema (mirror the sibling models' style):**

```prisma
model NightlyRun {
  id           String   @id @default(cuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id])
  sectionsJson String   // JSON.stringify of the night's section map — VERBATIM, incl. skips/failures
  ranAt        DateTime @default(now())

  @@index([businessId, ranAt])
}
```

**Interfaces (produces):**

```typescript
export type RecordedSection = { status: "ok"; detail: string } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };
export async function recordNightlyRun(
  identity: Identity,
  input: { sections: Record<string, RecordedSection> },
): Promise<{ runId: string }>;
```

**Complete implementation:**

```typescript
// Stage 6j — the nightly's activity record: the account of what ran, what was
// skipped, and what failed, VERBATIM (§16 accountability; D31 liveness). This is
// a diary write, not a lifecycle tool: it can create rows only, is scoped to the
// ambient identity (D27.1), and is NOT MCP-registered (whitelist stays 11).
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export type RecordedSection =
  | { status: "ok"; detail: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

const VALID_STATUS = new Set(["ok", "skipped", "failed"]);

export async function recordNightlyRun(
  identity: Identity,
  input: { sections: Record<string, RecordedSection> },
): Promise<{ runId: string }> {
  const keys = Object.keys(input.sections);
  if (keys.length === 0) throw new Error("recordNightlyRun: an empty section map is not a night.");
  for (const key of keys) {
    const s = input.sections[key] as { status?: unknown };
    if (typeof s?.status !== "string" || !VALID_STATUS.has(s.status)) {
      throw new Error(`recordNightlyRun: section "${key}" has no valid status — a malformed diary is worse than none.`);
    }
  }
  const row = await prisma.nightlyRun.create({
    data: { businessId: identity.businessId, sectionsJson: JSON.stringify(input.sections) } });
  return { runId: row.id };
}
```

- [ ] **Step 1: failing tests** (`nightly-run.test.ts`, the mcp two-tenant test conventions): (1) records a valid map and round-trips VERBATIM (`JSON.parse(row.sectionsJson)` deep-equals the input, incl. a `failed` section's exact reason); (2) empty map → throws; (3) a section with status `"exploded"` → throws, zero rows; (4) scoped: tenant A's record carries A's businessId; (5) nonexistent businessId → rejects (FK) — the caller's catch is what keeps the night alive (T2).
- [ ] **Step 2: RED → implement (schema + tool) → GREEN:** `$env:DATABASE_URL="file:./.tmp/test.db"; pnpm --filter dionysus-mcp test` (pretest reset re-pushes the schema; expect ~357) + `pnpm --filter dionysus-mcp build` clean.
- [ ] **Step 3: Commit** — `feat: NightlyRun record - the nightly's verbatim diary, additive schema`

---

## Task 2: `runNightly` writes the diary (department)

**Files:**
- Modify: `packages/department/src/run-nightly.ts`
- Test: appends to `packages/department/test/run-nightly.test.ts`

**Modification** — in `runNightly`, replace the final `return` with (and add `recordNightlyRun` to the dionysus-mcp imports; `failureReason` already exists):

```typescript
  const result = { businessId, plan, radar, metrics, learn, strategy, cro, seo, outreach, drafts };

  // 6j — the activity diary: persist the night's section results VERBATIM so the
  // founder can see what ran, what was skipped, and why (/activity). BEST-EFFORT:
  // the diary must never fail the night — a record failure is logged and swallowed.
  try {
    await recordNightlyRun(identity, { sections: { plan, radar, metrics, learn, strategy, cro, seo, outreach, drafts } });
  } catch (error: unknown) {
    console.error(`nightly: activity record failed (${failureReason(error)}) — the night's work is unaffected.`);
  }

  return result;
```

Also update the file's header comment (one line: the night ends by writing its verbatim activity record, best-effort). The sweep is UNTOUCHED (its catch synthesizes a return value for isolation; if runNightly ever threw, that night honestly has no diary — see the plan's Architecture note).

- [ ] **Step 1: failing tests** (`run-nightly.test.ts` appends, existing fixture conventions): (1) after a `runNightly` on the standard fixture, exactly ONE `nightlyRun` row exists for the business and `JSON.parse(sectionsJson)` deep-equals the RETURNED result's section map (drop `businessId` from the comparison object); (2) `runNightly` with an identity whose businessId does not exist RESOLVES (no throw — every section degrades, the record write FK-fails into the catch) and zero `nightlyRun` rows exist.
- [ ] **Step 2: RED → (mcp dist already built in T1; rebuild if needed) → implement → GREEN:** FULL dept suite (expect ~200) + dept tsc clean.
- [ ] **Step 3: Commit** — `feat: the nightly writes its diary - verbatim section record, best-effort, never fails the night`

---

## Task 3: `/activity` — "While you slept" (cockpit)

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (add `listNightlyActivity`)
- Create: `packages/cockpit/src/app/activity/page.tsx`
- Modify: `packages/cockpit/src/app/layout.tsx` (nav "Activity" after "Timeline"; match the existing nav construct)
- Test: appends to `packages/cockpit/test/review.test.ts`

**`listNightlyActivity`** (review.ts conventions — identity parameter, defensive parse, malformed rows SKIPPED):

```typescript
// 6j: the activity read — the founder's "while you slept" view. Renders the
// diary VERBATIM (a failed section shows its real reason). Malformed rows are
// skipped (defensive; only our own writer produces them). Newest night first.
const SECTION_ORDER = ["plan", "radar", "metrics", "learn", "strategy", "cro", "seo", "outreach", "drafts"];

export type ActivitySection = { section: string; status: "ok" | "skipped" | "failed"; text: string };
export type ActivityRun = { runId: string; ranAt: Date; sections: ActivitySection[] };

export async function listNightlyActivity(identity: { businessId: string }, limit = 14): Promise<ActivityRun[]> {
  const rows = await prisma.nightlyRun.findMany({
    where: { businessId: identity.businessId }, orderBy: { ranAt: "desc" }, take: limit });
  const runs: ActivityRun[] = [];
  for (const row of rows) {
    let parsed: Record<string, { status?: unknown; detail?: unknown; reason?: unknown }>;
    try {
      parsed = JSON.parse(row.sectionsJson) as typeof parsed;
      if (typeof parsed !== "object" || parsed === null) continue;
    } catch {
      continue;
    }
    const keys = [...SECTION_ORDER.filter((k) => k in parsed), ...Object.keys(parsed).filter((k) => !SECTION_ORDER.includes(k))];
    const sections: ActivitySection[] = [];
    for (const key of keys) {
      const s = parsed[key];
      if (typeof s?.status !== "string" || !["ok", "skipped", "failed"].includes(s.status)) continue;
      const text = typeof s.detail === "string" ? s.detail : typeof s.reason === "string" ? s.reason : "";
      sections.push({ section: key, status: s.status as "ok" | "skipped" | "failed", text });
    }
    if (sections.length > 0) runs.push({ runId: row.id, ranAt: row.ranAt, sections });
  }
  return runs;
}
```

**`/activity` page** (the /pitch page conventions: server component, `requireSession`, session businessId, all text as JSX children):
- Heading "While you slept", subline "Every night's work, verbatim — including what was skipped and what failed, and why."
- One block per run (ranAt formatted), one line per section: `{section} — {status}: {text}` (status uppercase for failed, e.g. rendered as plain text `FAILED`; no color library — text is enough).
- Empty state: "No nights recorded yet — the first nightly run writes its diary here."

- [ ] **Step 1: failing tests** (`review.test.ts` appends, its fixture conventions): (1) two recorded nights (insert `nightlyRun` rows directly with distinct `ranAt`) → newest first, sections in SECTION_ORDER, a `failed` section's real reason surfaces in `text`; (2) a malformed `sectionsJson` row is skipped while a valid sibling renders; (3) cross-tenant: tenant B's rows never appear for tenant A.
- [ ] **Step 2: RED → implement → GREEN:** FULL cockpit suite (expect ~72) + `pnpm --filter cockpit exec next build` (expect `/activity` ƒ).
- [ ] **Step 3: Commit** — `feat: cockpit /activity - while you slept, the nightly diary verbatim`

---

## Task 4: §15 eval gate

**Files:**
- Create: `packages/department/test/activity-eval.e2e.test.ts`

Invariants (tenants `biz_activityeval_*`; standard nightly fixtures):
- **inv1 HONEST RECORD (the core):** a FULL nightly on a business where at least one section genuinely FAILS (budget cap 0 → the drafts/radar budget throw) and others skip/succeed → the persisted record deep-equals the RETURNED section map VERBATIM (the failed section's stored reason is the real failure reason; no ok-washing anywhere).
- **inv2 THE DIARY NEVER FAILS THE NIGHT:** `runNightly` with a vanished businessId RESOLVES with every section degraded and writes NO record (the FK failure lands in the catch — proven by the resolution + zero rows).
- **inv3 CROSS-TENANT:** two businesses run the same night → each record carries only its own businessId; tenant A's record count is exactly 1.
- **inv4 APPEND-ONLY ACCUMULATION:** the same business run twice → two records, distinguishable, newest-first by `ranAt` (the diary accumulates history; nothing upserts/overwrites).
- **inv5 WHITELIST:** `TOOL_SCHEMAS` length **11**; no `record_nightly_run` name.
- [ ] Gate green standalone (`pnpm --filter department test -- activity-eval`) → FULL dept suite → Commit — `test: stage-6j eval gate - the nightly diary is verbatim, best-effort, tenant-scoped, non-MCP`

---

## Self-Review

**Spec coverage:** the stage-7 "live-activity panel" delivered as the honest slice the current system can support (per-night section records + a founder surface); real-time/streaming activity is platform-layer future work. §16: the diary shows failures verbatim — accountability includes the nights nothing worked.

**Placeholders:** none — T1/T2/T3 carry complete code; T4 is a complete invariant recipe.

**Type consistency:** `RecordedSection` (T1) matches dept's `SectionResult` shape structurally (dept does not import the type — the section map is passed as literals, so no cross-package type dependency is added); `ActivityRun`/`ActivitySection` (T3) are cockpit-local.

## Execution Handoff

Subagent-Driven — fresh Opus subagent per task, review between tasks, whole-branch review at the end.
