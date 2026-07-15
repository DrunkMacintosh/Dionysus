# Hardening Batch (Stage 6m) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every review-deferred minor that survived triage plus the two gaps today's live runs exposed: model calls have no output-token bound, and video-channel actions never get videographer-role attribution (so that employee can never learn). No new features, no new invariants — hardening only.

**Architecture:** three tasks by blast radius — dept production code, one cockpit surface, test-only tidies. Full suites gate each.

**Tech Stack:** no new dependencies, no schema change.

## Global Constraints

- Behavior changes are EXACTLY the six named below — nothing else moves. Existing tests stay green except where a fix's RED test deliberately pins the new behavior.
- **Ops:** PowerShell only (Git Bash broken). dept: `pnpm --filter department test`. cockpit: `$env:DATABASE_URL="file:./.tmp/test.db"; $env:COCKPIT_SESSION_SECRET="test-secret"`. No mcp changes (no dist rebuild unless repo state demands it).
- **Baselines at stage start:** mcp **361**, dept **227**, cockpit **77**.

---

## Task 1: Department production hardening (6 items)

**Files:**
- Create: `packages/department/src/video-channels.ts`
- Modify: `packages/department/src/draft-waypoint.ts`, `src/propose-route.ts`, `src/llm/harness.ts`, `src/llm/types.ts`, `src/run-nightly.ts`, `src/tools/web-search.ts`
- Test: appends to `test/propose-route.test.ts` (or wherever proposeRoute is tested — find it), `test/harness.test.ts`, `test/run-nightly.test.ts`, `test/run-video-gen.test.ts`, `test/tools.test.ts`

**Item 1 — shared video-channel module (pure move, no behavior change).** Create `src/video-channels.ts`:

```typescript
// Stage 6m: shared by draft-waypoint (routing) and propose-route (role clamping).
// Server-derived — the model never picks its own router or its own role.
export const VIDEO_CHANNELS = new Set(["tiktok", "reels", "shorts", "youtube-shorts", "instagram-reels", "video"]);
export const isVideoChannel = (channel: string): boolean => VIDEO_CHANNELS.has(channel.toLowerCase().trim());
```

`draft-waypoint.ts` deletes its local copies and imports from `./video-channels.js`. Also EXPORT its exclusion list so run-nightly can share it (item 4): `export const NON_COPYWRITER_TYPES = ["cro-fix", "outreach-pitch", "seo-audit", "video-post"];` and use it in the existing `notIn`.

**Item 2 — proposeRoute role clamp (6i forward note).** In the action-persist loop (`propose-route.ts:83-87`), server-derive the role:

```typescript
      // 6m: video-channel actions belong to the Videographer — clamp the role
      // server-side so its craft beliefs accrue under the right employee (the
      // model's self-assigned role is advisory, like channel/kind labels).
      const actionChannel = typeof a.features?.["channel"] === "string" ? (a.features["channel"] as string) : a.type;
      const employeeRole = isVideoChannel(actionChannel) ? "videographer" : a.employeeRole;
```

then use `employeeRole` in both the `upsertRouteAction` call and the returned action object. Test (RED first): a strategist output containing a `{channel:"tiktok"}` action → the persisted row's employeeRole is `"videographer"` regardless of the model's label; a non-video action keeps the model's role.

**Item 3 — per-call output bound (live-run gap: unbounded completion).** `types.ts`: AgentDef gains `maxOutputTokens?: number`. `harness.ts`: `const DEFAULT_MAX_OUTPUT_TOKENS = 8192;` — both `runAgent`'s and `completeOnce`'s `chat.completions.create` gain `max_tokens: def.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS` (completeOnce uses the default; it has no def). Rationale comment: a runaway/reasoning-heavy model must not generate unbounded output on our budget; 8192 clears the largest observed real output (3.6k) with 2× headroom. Tests: the harness test's stub client records request params → assert `max_tokens: 8192` present by default and an explicit `maxOutputTokens: 512` honored.

**Item 4 — the no-op drafts night (6e-era nit).** `run-nightly.ts` drafts-section `undrafted` count gains `type: { notIn: NON_COPYWRITER_TYPES }` (imported from draft-waypoint) so an assetless employee-artifact orphan no longer triggers a draftWaypoint call that drafts nothing and reports `"0 draft(s) ready"` instead of `skipped`. Test (RED first): active waypoint whose ONLY proposed-assetless action is a `cro-fix` → drafts section `skipped` ("nothing undrafted on the active waypoint"), zero harness calls with "Action: draft".

**Item 5 — videoGen budget-throw coverage.** `run-video-gen.test.ts`: fixture with an eligible approved storyboard + connected integration + transport, business cap 0 → `runVideoGen` REJECTS with the budget message; transport never called; zero rows.

**Item 6 — Tavily response shape validation (no silent empty).** `web-search.ts`: replace the `as`-cast with a zod schema (`z.object({ results: z.array(z.object({ title: z.string().optional(), url: z.string().optional(), content: z.string().optional() })).optional() })` — but a 200 body that FAILS the schema (e.g. `{"foo":1}` is fine — results optional… make the failure real: `safeParse` failure OR a parsed object that is not an object → throw `Tavily search failed: unrecognized response shape`). Decide precisely: `{"results":[]}` and `{"results":[…]}` are valid (a genuine zero-result search stays `[]`); a 200 whose JSON has NO `results` key → THROW (that is not a search response — silence would fake "nothing found"). Tests: `{"results":[]}` → `[]`; `{"foo":1}` → throws unrecognized-shape.

- [ ] **Step 1: failing tests for items 2, 3, 4, 5, 6** (item 1 is a pure move covered by existing suites) → RED.
- [ ] **Step 2: implement all six → GREEN:** FULL dept suite (expect ~233: 227 + ~6) + `pnpm --filter department build` clean.
- [ ] **Step 3: Commit** — `fix: hardening batch - role clamp, output bound, no-op drafts night, budget coverage, tavily shape`

---

## Task 2: /drafts kind label (cockpit)

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (listProposedDrafts's view gains `kind: asset.kind`)
- Modify: the drafts page/card component (find it — src/app/drafts/…) to render the kind label beside the existing type/channel metadata (plain text, JSX child)
- Test: append to `packages/cockpit/test/review.test.ts`: a storyboard draft's view carries `kind: "storyboard"`

- [ ] **Step 1: failing test → RED. Step 2: implement → GREEN:** FULL cockpit suite (expect ~78) + `pnpm --filter cockpit exec next build` clean.
- [ ] **Step 3: Commit** — `feat: drafts card shows the asset kind - a storyboard is not a post`

---

## Task 3: Test tidies (test-only)

**Files:** `packages/department/test/morning-eval.e2e.test.ts`, `packages/department/test/run-seo.test.ts`, `packages/department/test/tools.test.ts`, `packages/cockpit/test/review.test.ts`

1. morning-eval's `wipe()` gains `prisma.nightlyRun.deleteMany` (consistency with the other eval teardowns).
2. `run-seo.test.ts`: NEW case — the latest seo-audit asset has `contentJson: "not json"` → the dedup fail-opens and a fresh audit drafts (the malformed-auditHash branch, previously untested).
3. `tools.test.ts`: tighten the missing-key assertion from `/TAVILY_API_KEY/` to the full fail-closed sentence.
4. cockpit `review.test.ts`: the pitch newest-first test replaces its 5ms `setTimeout` with explicit distinct `createdAt` writes (deterministic ordering).

- [ ] **Step 1: implement all four; run FULL dept + cockpit suites (expect ~234 dept / ~79 cockpit — report actuals).**
- [ ] **Step 2: Commit** — `test: tidies - eval teardown consistency, fail-open dedup coverage, deterministic ordering, exact fail-closed message`

---

## Self-Review

**Coverage:** every open deferred minor from the ledger triages is either here or explicitly platform-scale (N+1 batching, NightlyRun retention, context-eviction harness work — all stay deferred). **Placeholders:** none. **Type consistency:** `VIDEO_CHANNELS`/`isVideoChannel`/`NON_COPYWRITER_TYPES` shared exports consumed by exactly the named files.

## Execution Handoff

Subagent-Driven — Opus implementer per task, focused review after T1 (the behavior-bearing task), whole-batch suite verification, merge.
