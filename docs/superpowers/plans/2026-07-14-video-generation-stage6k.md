# Video Generation (Stage 6k — two-gate, transport-injectable) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Videographer's generation phase (spec §employees: "concept→storyboard→Kling generation→assembly", two-gate + cost cap): a founder-**approved** storyboard (gate 1) is turned into a generated video overnight — via a connected video Integration + an injectable transport — and the video lands as a **NEW proposed** `video-post` action + asset on `/drafts` (gate 2: normal approval; the founder reviews the actual video before anything is posted). Every generation writes a **cost-ledger row** (D28: `record_cost` for non-LLM costs). The REAL Kling adapter (POST wire format, per-unit pricing) is deliberately deferred to the founder-keyed follow-up — the transport seam is the product boundary, exactly like 5d's `ingestMetrics`.

**Architecture:** `runVideoGen` (dept) mirrors the outreach shape: eligibility FIRST (approved storyboard actions not yet generated — linked via `features.storyboardActionId` on the generated `video-post` action), then the gates (Integration kind `"video"` connected → transport configured → budget fail-closed), then cap `MAX_VIDEOS_PER_NIGHT = 1` oldest-first with the remainder reported, then per-item: decrypt config → transport call → validate the returned URL shape → persist the proposed `video-post` + `video` asset → `recordCost`. TENTH nightly section (`video`, after outreach, before drafts). A tiny additive mcp read (`getConnectedVideoSource`) mirrors `getConnectedAnalytics`.

**Tech Stack:** No new dependencies, no schema change (Integration is generic since 5d). dionysus-mcp (one additive function) + department + cockpit (/connect video form + send-queue exclusion).

## Global Constraints

- **TWO-GATE (never-auto twice):** generation consumes only actions that are `approved` AND whose bound asset kind is `"storyboard"` (gate 1 = the founder's approval); the OUTPUT is a NEW `proposed` action (`type "video-post"`, employeeRole `"videographer"`) + asset (kind `"video"`) — gate 2 is the normal approval. Nothing here posts, publishes, or executes.
- **HONEST rationale:** the video-post rationale says the video was generated and must be REVIEWED before approving — Dionysus never claims the video matches the storyboard (it cannot verify video content).
- **IDEMPOTENT ACROSS NIGHTS:** a storyboard that already has a `video-post` action (matched by `featuresJson` containing `"storyboardActionId":"<id>"` — ANY status) is never re-generated.
- **HONEST degrade, zero side effects:** no eligible storyboards → skip (zero transport calls); no connected `"video"` Integration → skip; no transport configured → skip; undecryptable/malformed config → skip + log (zero calls); transport error or malformed/non-http(s) URL → that item is skipped + logged, stays ungenerated, retries next night. Budget refused → throw (fail-closed, section reports failed).
- **COST LEDGER (D28):** every successful generation writes exactly one `recordCost` row (`model: "video-gen"`, 0/0 tokens, note carrying the video-post actionId) — the event is recorded even though per-unit pricing is unknown (costUsd null is honest).
- **`MAX_VIDEOS_PER_NIGHT = 1`** (metered generation), oldest approved first (`createdAt asc`), remainder reported in the section detail (`, N awaiting (cap)`).
- **Secrets:** the apiKey exists in memory only between `getDecryptedConfig` and the transport call; it is never logged, never persisted, never in a reason string.
- **NOT MCP (whitelist stays 11); D27.1 scoped everything; no schema change; no `console.log` in src; ESM `.js` specifiers.**
- **Ops:** PowerShell only (Git Bash broken). mcp tests: `$env:DATABASE_URL="file:./.tmp/test.db"`. cockpit adds `$env:COCKPIT_SESSION_SECRET="test-secret"`. mcp change → `pnpm --filter dionysus-mcp build` BEFORE dept/cockpit suites.
- **Baselines at stage start:** mcp **357**, dept **205**, cockpit **72**.

**Deferred (documented):** the real Kling transport adapter (POST wire format + per-unit pricing verification + a safeFetch POST mode — arrives with the founder's key); assembly/multi-clip; video verified-send (caption-snippet contract); posting automation (spec: assisted-manual, D19).

---

## Task 1: `getConnectedVideoSource` (dionysus-mcp, additive)

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/integration.ts`
- Test: appends to `packages/dionysus-mcp/test/integration.test.ts` (or the file that tests getConnectedAnalytics — find it and append there)

**Complete implementation** (place beside `getConnectedAnalytics`, mirroring it exactly):

```typescript
/** The connected video-generation source (6k), or null. Mirrors getConnectedAnalytics. */
export async function getConnectedVideoSource(identity: Identity): Promise<ConnectedIntegration | null> {
  const row = await prisma.integration.findFirst({
    where: { businessId: identity.businessId, kind: "video", status: "connected" },
    orderBy: { createdAt: "desc" } });
  return row ? toView(row) : null;
}
```

- [ ] **Step 1: failing tests** (mirror the getConnectedAnalytics cases): connected video row → returned (config-FREE view); none / disconnected → null; an ANALYTICS row does not satisfy a VIDEO lookup (kind isolation); cross-tenant null.
- [ ] **Step 2: RED → implement → GREEN** full mcp suite (expect ~361) + `pnpm --filter dionysus-mcp build` clean.
- [ ] **Step 3: Commit** — `feat: getConnectedVideoSource - the video integration read, kind-isolated`

---

## Task 2: `runVideoGen` + the tenth nightly section + exclusions

**Files:**
- Create: `packages/department/src/run-video-gen.ts`
- Modify: `packages/department/src/run-nightly.ts` (video section between outreach and drafts → TEN sections; `NightlyBusinessResult.video`; `NightlyDeps.videoGenTransport?`; header + JSDoc + sweep fallback updated)
- Modify: `packages/department/src/draft-waypoint.ts` (`notIn` gains `"video-post"`)
- Modify: `packages/cockpit/src/lib/review.ts` (`listSendQueue` kind exclusion gains `"video"`; `SECTION_ORDER` gains `"video"` after `"outreach"`)
- Test: `packages/department/test/run-video-gen.test.ts` (new), appends to `run-nightly.test.ts`, `draft-waypoint.test.ts`, cockpit `review.test.ts`

**Interfaces (produces):**

```typescript
export const MAX_VIDEOS_PER_NIGHT = 1;
export type VideoGenTransport = (input: { endpoint: string; apiKey: string; prompt: string }) =>
  Promise<{ url: string } | { error: string }>;
export type VideoGenDeps = { transport?: VideoGenTransport };
export type VideoGenResult =
  | { status: "ok"; generated: string[]; skippedItems: number; awaiting: number } // generated = new video-post actionIds
  | { status: "skipped"; reason: string };
export async function runVideoGen(identity: Identity, deps: VideoGenDeps): Promise<VideoGenResult>;
```

**Complete `run-video-gen.ts`:**

```typescript
// Stage 6k — the Videographer's generation phase (spec: two-gate + cost cap).
// GATE 1 already happened: only APPROVED storyboards are eligible. This pipeline
// turns each into a generated video via the connected video Integration + the
// injected transport, and lands the result as a NEW PROPOSED video-post action
// + asset — GATE 2 is the founder's normal approval, where they watch the actual
// video before anything is posted. Dionysus never claims the video matches the
// storyboard (it cannot verify video content) — the rationale says so.
//
//   eligibility FIRST (approved storyboard actions with no video-post yet; none →
//     skip, ZERO transport calls) → Integration kind "video" connected → transport
//     configured → checkBudget (fail-closed) → cap MAX_VIDEOS_PER_NIGHT oldest
//     first (remainder reported) → per item: getDecryptedConfig (unreadable →
//     skip+log, zero calls) → transport({endpoint, apiKey, prompt}) (error /
//     malformed / non-http(s) url → skip+log, stays ungenerated, RETRIES next
//     night) → persist proposed video-post + video asset → recordCost (D28: the
//     generation EVENT is ledgered; per-unit pricing unknown → costUsd null).
// The apiKey lives only between decrypt and the transport call — never logged,
// never persisted, never in a reason string. NOT MCP — whitelist stays 11.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { checkBudget, recordCost } from "dionysus-mcp/tools/cost-budget";
import { getConnectedVideoSource, getDecryptedConfig } from "dionysus-mcp/tools/integration";
import { upsertRouteAction } from "dionysus-mcp/tools/plan";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";

export const MAX_VIDEOS_PER_NIGHT = 1;
export type VideoGenTransport = (input: { endpoint: string; apiKey: string; prompt: string }) =>
  Promise<{ url: string } | { error: string }>;
export type VideoGenDeps = { transport?: VideoGenTransport };
export type VideoGenResult =
  | { status: "ok"; generated: string[]; skippedItems: number; awaiting: number }
  | { status: "skipped"; reason: string };

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// The storyboard body ends with "Caption: ..." (draft-waypoint's formatStoryboard).
const captionOf = (body: string): string | null => {
  const m = /\nCaption: (.+)$/s.exec(body);
  return m ? m[1].trim() : null;
};

export async function runVideoGen(identity: Identity, deps: VideoGenDeps): Promise<VideoGenResult> {
  const businessId = identity.businessId;

  // 1. ELIGIBILITY FIRST (cheap DB reads; a night with nothing to generate makes
  // zero integration/budget/transport noise). Approved actions with a bound
  // STORYBOARD asset, minus those already generated (a video-post action whose
  // features carry this storyboardActionId, ANY status — idempotent across nights).
  const approved = await prisma.routeAction.findMany({
    where: { businessId, status: "approved", assetId: { not: null } }, orderBy: { createdAt: "asc" } });
  const eligible: Array<{ actionId: string; waypointId: string; channel: string; title: string; body: string }> = [];
  for (const action of approved) {
    if (!action.assetId) continue;
    const asset = await prisma.asset.findFirst({ where: { id: action.assetId, businessId, kind: "storyboard" } });
    if (!asset) continue;
    const already = await prisma.routeAction.findFirst({
      where: { businessId, type: "video-post", featuresJson: { contains: `"storyboardActionId":"${action.id}"` } } });
    if (already) continue;
    let title = ""; let body = "";
    try {
      const content = JSON.parse(asset.contentJson) as { title?: unknown; body?: unknown };
      title = typeof content.title === "string" ? content.title : "";
      body = typeof content.body === "string" ? content.body : "";
    } catch {
      continue; // malformed storyboard content — never generate from something unreadable
    }
    if (!title || !body) continue;
    eligible.push({ actionId: action.id, waypointId: action.waypointId, channel: asset.channel, title, body });
  }
  if (eligible.length === 0) return { status: "skipped", reason: "no approved storyboards awaiting generation" };

  // 2. GATES: a connected video source, a configured transport, then budget fail-closed.
  const source = await getConnectedVideoSource(identity);
  if (!source) return { status: "skipped", reason: "no video source connected" };
  if (!deps.transport) return { status: "skipped", reason: "no video transport configured" };
  const budget = await checkBudget(identity);
  if (!budget.allowed) throw new Error(`Video generation blocked: budget exhausted or unavailable (${budget.reason ?? "over cap"}).`);

  // 3. CAP: metered generation — the oldest approved storyboard first; the rest
  // honestly wait (reported in the section detail).
  const batch = eligible.slice(0, MAX_VIDEOS_PER_NIGHT);
  const awaiting = eligible.length - batch.length;

  const generated: string[] = [];
  let skippedItems = 0;
  for (const item of batch) {
    // 4a. The config decrypts per item (it is small; a rotated key mid-batch stays honest).
    const config = await getDecryptedConfig(identity, source.integrationId);
    const endpoint = typeof config?.endpoint === "string" ? config.endpoint : "";
    const apiKey = typeof config?.apiKey === "string" ? config.apiKey : "";
    if (!endpoint || !apiKey) {
      skippedItems++;
      console.error(`video-gen: source config unreadable for action ${item.actionId} — skipped (zero calls).`);
      continue;
    }
    // 4b. The prompt is OUR OWN storyboard (trusted, founder-approved) — plain.
    const prompt = `${item.title}\n\n${item.body}`;
    let outcome: { url: string } | { error: string };
    try {
      outcome = await deps.transport({ endpoint, apiKey, prompt });
    } catch (error: unknown) {
      outcome = { error: error instanceof Error ? error.message : "transport error" };
    }
    if ("error" in outcome || !isHttpUrl(outcome.url)) {
      skippedItems++;
      console.error(`video-gen: generation failed for action ${item.actionId} — stays ungenerated, retries next night.`);
      continue;
    }
    // 4c. GATE 2 material: a NEW proposed action + asset. The founder watches the
    // video at the URL before approving; nothing is posted by Dionysus.
    const caption = captionOf(item.body);
    const { actionId } = await upsertRouteAction(identity, {
      waypointId: item.waypointId, employeeRole: "videographer", type: "video-post",
      rationale: `Video generated from the approved storyboard "${item.title}" — REVIEW THE VIDEO before approving; Dionysus cannot verify its content.`,
      features: { channel: item.channel, video: true, storyboardActionId: item.actionId } });
    const { assetId } = await persistAsset(identity, {
      channel: item.channel, kind: "video",
      content: { title: item.title, body: `Video: ${outcome.url}${caption ? `\n\nCaption: ${caption}` : ""}` },
      routeActionId: actionId });
    await setActionAsset(identity, actionId, assetId);
    // 4d. D28: the generation EVENT is ledgered (per-unit pricing unknown → costUsd null).
    await recordCost(identity, { model: "video-gen", inputTokens: 0, outputTokens: 0,
      note: `video generation for video-post ${actionId} (storyboard ${item.actionId})` });
    generated.push(actionId);
  }

  return { status: "ok", generated, skippedItems, awaiting };
}
```

**Nightly section** (after outreach, before drafts — TEN sections; update the header block + one-line JSDoc + the sweep's fallback object with `video`):

```typescript
  // VIDEO — the Videographer's generation phase (6k, two-gate): approved
  // storyboards become generated videos, landing as NEW proposed video-post
  // drafts. Honest skips without a connected source or transport.
  let video: SectionResult;
  try {
    const res = await runVideoGen(identity, deps.videoGenTransport ? { transport: deps.videoGenTransport } : {});
    video = res.status === "ok"
      ? { status: "ok", detail: `${res.generated.length} video(s) generated, ${res.skippedItems} skipped${res.awaiting > 0 ? `, ${res.awaiting} awaiting (cap)` : ""}` }
      : { status: "skipped", reason: res.reason };
  } catch (error: unknown) {
    video = { status: "failed", reason: failureReason(error) };
  }
```

`NightlyDeps` gains `videoGenTransport?: VideoGenTransport` (import the type from `./run-video-gen.js`); `NightlyBusinessResult` gains `video: SectionResult` (between outreach and drafts); the diary write needs NO change (the section map is derived from the result — the 6j hardening pays off immediately).

**Exclusions:** `draft-waypoint.ts` `notIn` gains `"video-post"` (an assetless partial-persist orphan must never be copywriter-drafted); cockpit `listSendQueue` kind exclusion gains `"video"` (the founder downloads and posts by hand; the video verified-send contract is deferred); cockpit `SECTION_ORDER` gains `"video"` after `"outreach"` (the /activity diary renders the tenth section in order).

- [ ] **Step 1: failing tests.** `run-video-gen.test.ts` (fixture: business + route + waypoint + an APPROVED action with a bound storyboard asset — build on the draft-waypoint/outreach fixture conventions; a FakeTransport recording its inputs):
  1. **HAPPY** — one approved storyboard + connected video integration (use the in-process `DIONYSUS_CONFIG_KEY` convention from the 5d tests + `connectIntegration` kind "video" with `{endpoint, apiKey}`) → ONE new action type `"video-post"` `proposed` + `approvedAt` null, employeeRole `"videographer"`, features carry `storyboardActionId`; asset kind `"video"`, body contains the transport's URL AND the storyboard's caption; the transport received the storyboard title in its prompt AND the real apiKey; result `{generated:[id], skippedItems:0, awaiting:0}`; exactly ONE `llmCall` row with model `"video-gen"` and a note containing the video-post actionId.
  2. **GATE: no integration** → skip `"no video source connected"`, transport NEVER called.
  3. **GATE: no transport** → skip `"no video transport configured"`.
  4. **ELIGIBILITY FIRST** — zero approved storyboards (but integration connected) → skip `"no approved storyboards awaiting generation"`, transport never called; a PROPOSED (unapproved) storyboard is NOT eligible (gate 1 is real).
  5. **IDEMPOTENT** — run twice → still exactly ONE video-post (the second run skips with "no approved storyboards awaiting generation").
  6. **CAP** — two approved storyboards (distinct createdAt, INSERTED newest-first so an orderBy-less query fails) → exactly ONE generated (the OLDEST), `awaiting: 1`.
  7. **TRANSPORT ERROR + RETRY** — transport returns `{error}` → zero video-post rows, `skippedItems:1`, no cost row; flip the transport healthy → next run generates (the retry is real).
  8. **URL SHAPE** — transport returns `{url:"javascript:alert(1)"}` → rejected (skippedItems 1, zero rows).
  `run-nightly.test.ts` append: the standard fixture → `res.video.status === "skipped"` (and the diary record includes the `video` key — one assertion on the parsed sectionsJson). `draft-waypoint.test.ts` append: an assetless proposed `video-post` is NOT copywriter-drafted. cockpit `review.test.ts` append: an approved action with asset kind `"video"` is EXCLUDED from `listSendQueue`; a diary row containing a `video` section renders it in order (extend the existing activity test's fixture with a `video` key).
- [ ] **Step 2: RED → (mcp dist from T1) → implement → GREEN:** FULL dept suite + FULL cockpit suite + both builds clean.
- [ ] **Step 3: Commit** — `feat: runVideoGen - approved storyboards become generated videos, two-gate, capped, ledgered`

---

## Task 3: cockpit `/connect` video form

**Files:**
- Modify: `packages/cockpit/src/lib/integration-actions.ts` (or wherever the analytics connect action lives — find it; add `connectVideoSourceAction` following its exact shape: requireSession outside try, session businessId, validate endpoint http/https + apiKey non-empty, `connectIntegration` kind `"video"` provider `"http-json"` metric `"video-generation"`, revalidatePath, friendly catch)
- Modify: `packages/cockpit/src/app/connect/page.tsx` (+ its form component file if the analytics form is separate — a SECOND section "Video generation": endpoint + apiKey [type=password, write-only], the connected/disconnected state via a video-kind read, honest copy: "Generates video drafts from storyboards you approve. Every video is a draft you review before posting. The reference provider is transport-injectable — the real Kling adapter arrives with your API key.")
- Test: appends to the cockpit test file covering the connect action (mirror the analytics connect tests: connect writes an encrypted row kind "video" [config NEVER in the returned view], validation refusals write nothing, session-scoped)

- [ ] **Step 1: failing tests** (3: happy connect kind "video" + encrypted config + config-free view; invalid endpoint refused pre-write; apiKey never surfaces in any read).
- [ ] **Step 2: RED → implement → GREEN:** FULL cockpit suite + `pnpm --filter cockpit exec next build` clean.
- [ ] **Step 3: Commit** — `feat: cockpit /connect video source - encrypted key, write-only, honest two-gate copy`

---

## Task 4: §15 eval gate

**Files:**
- Create: `packages/department/test/videogen-eval.e2e.test.ts`

Invariants (tenants `biz_videogeneval_*`; the full nightly path via `runNightly` with a FakeTransport + the in-process config key; FK-safe afterAll incl. `nightlyRun` AND `llmCall` cleanup before `business.deleteMany`):
- **inv1 TWO-GATE END-TO-END:** a full nightly where a storyboard exists but is only PROPOSED → zero transport calls, zero video-post rows (gate 1 is real); approve it + connect the integration → the NEXT nightly generates: the video-post is `proposed` + `approvedAt` null + asset kind `"video"` (gate 2 is real — nothing auto-approved), and the diary's `video` section is `ok` with the generation count.
- **inv2 NO-INTEGRATION HONESTY:** approved storyboard but NO video integration → zero transport calls, section skipped `"no video source connected"` — Dionysus never generates through an unconfigured source.
- **inv3 COST LEDGER:** after inv1's generation, exactly ONE `llmCall` row with model `"video-gen"` whose note contains the video-post actionId (the D28 event ledger is real).
- **inv4 IDEMPOTENT + CAP:** a second nightly after inv1 generates NOTHING new (the storyboardActionId link holds); with TWO approved storyboards (scrambled createdAt vs insertion order) and a fresh tenant → exactly ONE generated (the oldest), diary detail contains `1 awaiting (cap)`.
- **inv5 SECRET DISCIPLINE:** the FakeTransport records the apiKey it received (proving decryption worked) — AND the apiKey string appears in NO persisted row (assets, actions, nightlyRun sectionsJson, llmCall notes) and in NO section reason.
- **inv6 WHITELIST:** `TOOL_SCHEMAS` length **11**; no `run_video_gen` / `generate_video` names.
- [ ] Gate green standalone (`pnpm --filter department test -- videogen-eval`) → FULL dept suite → Commit — `test: stage-6k eval gate - video generation is two-gate, capped, ledgered, secret-tight, non-MCP`

---

## Self-Review

**Spec coverage:** the Videographer's generation phase with the spec's own two-gate + cost-cap requirements; Kling's real wire adapter deferred to the keyed follow-up (open question 7 notes pricing verification is still pending — building the adapter blind would be fabrication of an API contract). Assembly/multi-clip deferred.

**Placeholders:** none — T1/T2 carry complete code; T3 names exact behaviors against the established 5d connect pattern; T4 is a complete invariant recipe.

**Type consistency:** `VideoGenTransport`/`VideoGenDeps`/`MAX_VIDEOS_PER_NIGHT` (T2) → nightly deps + T4; `getConnectedVideoSource` (T1) → T2; `SECTION_ORDER` + send-queue exclusion are cockpit-local; the diary needs no change (derived section map).

## Execution Handoff

Subagent-Driven — fresh Opus subagent per task, review between tasks, whole-branch review at the end.
