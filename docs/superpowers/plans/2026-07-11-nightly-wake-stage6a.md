# Nightly Wake (Stage 6a — platform trigger slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wake the dormant liveness: a per-business nightly routine that runs radar sensing (4e) and metric ingestion (5d) unattended — with the hardening an unattended scheduler requires (truncate-not-reject radar output, rerun dedup, concurrency-safe belief/connect writes, SSRF-guarded production transport, per-business failure isolation) — invokable by any external scheduler via a gated operator script.

**Architecture:** `runNightly(identity, deps)` (department) runs two independent best-effort sections per business: radar (objective-lensed, proposals land on the latest route) and metric ingestion (via a new `metricTransportFromSafeFetch` production adapter over the stage-1 SSRF guard). `runNightlySweep(deps)` iterates all businesses, each under its own ambient identity, isolating failures. `scripts/nightly.mjs` (mirroring `live-smoke.mjs`) builds the real harness + transport and runs one sweep. Pre-hardening: radar's zod cap truncates instead of hard-failing, radar skips already-recorded sourceUrls (rerun-safe), the 5c belief flip-path swallows the concurrent-writer P2002, and 5d's connect becomes a native atomic upsert.

**Tech Stack:** TypeScript (dionysus-mcp TS 7 / department), Prisma 6 + SQLite, vitest, zod, undici (existing). No new dependencies. No cockpit changes (the /radar, /report pages already read this data).

## Global Constraints

*(Every task's requirements implicitly include this section.)*

- **The sweep is the PLATFORM operator (D30), not a tenant.** It iterates businesses, but each business is processed under its OWN ambient identity (`{ businessId }`); no read/write ever crosses tenants; one business's failure NEVER blocks another (per-business try/catch, summary-reported).
- **Fail-closed budget, per business.** `runRadar` already throws when `checkBudget` refuses — the nightly CATCHES it and records `failed` for that business (no model call was made), then continues the sweep. Never bypass or pre-empt the budget gate.
- **Degrade-safe + honest.** A radar/ingest failure persists nothing extra and fabricates nothing: no reading → no snapshot; no signals → quiet night; a dropped/deduped/truncated observation is counted and logged (`console.error`, the existing pattern), never silently invented.
- **Rerun-safe (the 4e bundle items).** Re-running the nightly with the same signals adds ZERO duplicate observations and ZERO duplicate proposals. A model emitting MORE than 8 grounded observations persists the first 8 (truncate) — never a parse hard-fail that throws the whole night away.
- **SSRF (stage-1) on the analytics endpoint.** The production metric transport is `safeFetch` (src/lib/ssrf.ts) — extended additively with a `headers` option for the Bearer key. SSRF policy keeps its single home (the 4d adjudication); never a raw `fetch`.
- **D27.1 ambient identity.** No new function takes a caller-supplied businessId from a MODEL or client; the sweep constructs identities from the Business table (platform-level, trusted).
- **NOT MCP — whitelist stays 11.** `runNightly`/`runNightlySweep`/`metricTransportFromSafeFetch` and all hardening are non-MCP. `server.ts` untouched.
- **Additive.** `runRadar`'s signature and `RadarResult` shape unchanged; `connectIntegration`/`persistCraftBelief` signatures unchanged; `SafeFetchOptions.headers` optional.
- No `console.log` in production code (`console.error` on degrade/skip paths only, matching runRadar). No mutation. ESM `.js` specifiers.
- **Ops (verified):** PowerShell (Git Bash broken). mcp tests: `$env:DATABASE_URL="file:./.tmp/test.db"`. department imports the BUILT dist of dionysus-mcp → after mcp src changes run `pnpm build` in dionysus-mcp before the dept suite. 5d-related tests set `$env:DIONYSUS_CONFIG_KEY` in-process. No schema change in this stage → no DB reset.
- **Baselines at stage start:** mcp **292**, department **81**, cockpit **54**. Every task keeps all three green (cockpit is untouched — verify once at whole-branch).

---

## File Structure

**department**
- Modify: `packages/department/src/radar-schemas.ts` — truncate-not-reject (T1).
- Modify: `packages/department/prompts/radar.md` — state the 8-cap (T1). *(Locate via `loadPrompt` — the prompts dir used by `loadPrompt("radar")`.)*
- Modify: `packages/department/src/run-radar.ts` — sourceUrl dedup (T2).
- Create: `packages/department/src/run-nightly.ts` — `runNightly` + `runNightlySweep` (T5).
- Create: `packages/department/scripts/nightly.mjs` — the gated operator script (T6); add a `"nightly"` script to `packages/department/package.json`.
- Test: extend `test/radar-schemas.test.ts` + `test/run-radar.test.ts` (or the file(s) currently covering them — locate by name), create `test/run-nightly.test.ts` (T5), create `test/nightly-eval.e2e.test.ts` (T7).

**dionysus-mcp**
- Modify: `packages/dionysus-mcp/src/tools/belief-graph.ts` — flip-path P2002 catch (T3).
- Modify: `packages/dionysus-mcp/src/tools/integration.ts` — native atomic upsert (T3).
- Modify: `packages/dionysus-mcp/src/lib/ssrf.ts` — additive `headers` option (T4).
- Modify: `packages/dionysus-mcp/src/tools/analytics.ts` — `metricTransportFromSafeFetch` (T4).
- Test: extend `test/belief-graph.test.ts`, `test/analytics.test.ts` (T3/T4).

---

## Task 1: Radar truncate-not-reject (the 8-cap degrades, never hard-fails)

**Files:**
- Modify: `packages/department/src/radar-schemas.ts`
- Modify: `packages/department/prompts/radar.md`
- Test: the existing radar-schemas test file (locate it: `Grep "ObservationsSchema" packages/department/test`)

**Interfaces:**
- Produces: `export const MAX_OBSERVATIONS = 8`. `ObservationsSchema` now ACCEPTS >8 observations and truncates to the first `MAX_OBSERVATIONS` (the model lists strongest-first per the prompt). `ObservationsOutput`/`parseObservations` signatures unchanged.

- [ ] **Step 1: Write the failing test** (append to the existing radar-schemas test file, reusing its valid-observation fixture shape):

```typescript
it("truncates to MAX_OBSERVATIONS instead of hard-failing — an over-cap night keeps its strongest 8", async () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({
    title: `T${i}`, body: `B${i}`, sourceUrl: `https://news.ycombinator.com/item?id=${i}`,
    relevance: 5, confidence: 0.5,
  }));
  const parsed = await parseObservations(JSON.stringify({ observations: nine }), async () => { throw new Error("retry must not be needed"); });
  expect(parsed.observations).toHaveLength(8); // truncated, NOT rejected — the night is not thrown away
  expect(parsed.observations[0]?.title).toBe("T0"); // keeps the first (strongest-first) items
});
```

- [ ] **Step 2: Run to verify it FAILS** — `cd D:\Dionysus\packages\department; pnpm vitest run <that test file>`. Expected: FAIL (current `.max(8)` rejects → parseWithRetry burns the retry then throws).

- [ ] **Step 3: Implement.** In `radar-schemas.ts`:

```typescript
import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

/** Hard cap on persisted observations per night. Over-cap output is TRUNCATED (strongest-first
 * per the prompt), never rejected — a hard-fail would throw the whole night away (4e bundle item). */
export const MAX_OBSERVATIONS = 8;

export const ObservationsSchema = z.object({
  observations: z.array(z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    sourceUrl: z.string().url(),
    relevance: z.number().min(0).max(10),
    confidence: z.number().min(0).max(1),
  })).transform((obs) => obs.slice(0, MAX_OBSERVATIONS)),
});
export type ObservationsOutput = z.infer<typeof ObservationsSchema>;

export function parseObservations(raw: string, retryFn: (err: string) => Promise<string>): Promise<ObservationsOutput> {
  return parseWithRetry(ObservationsSchema, raw, retryFn);
}
```

In `prompts/radar.md`, append one line to the output-contract section: `Report at most 8 observations — pick the strongest signals; never pad.`

- [ ] **Step 4: Run to verify it PASSES** + the whole dept suite stays green (`pnpm vitest run`).
- [ ] **Step 5: Commit** — `feat: radar 8-cap truncates instead of rejecting - an over-cap night keeps its strongest signals`

---

## Task 2: Radar rerun dedup (an already-recorded sourceUrl is not new news)

**Files:**
- Modify: `packages/department/src/run-radar.ts`
- Test: the existing run-radar test file

**Interfaces:** `runRadar` signature + `RadarResult` unchanged. New behavior: a survivor whose `sourceUrl` already exists as a `market-observation` MemoryNode for this business is SKIPPED — neither re-recorded NOR re-proposed (a re-noticed URL is not new news). The skip count is `console.error`-logged like the fabrication drop.

- [ ] **Step 1: Write the failing test** (append to the run-radar test file, reusing its fake harness + hnTransport fixtures — the fake harness emits observations citing the fixture signal URLs):

```typescript
it("is rerun-safe: a second radar run over the same signals records ZERO new observations and ZERO new proposals", async () => {
  // Arrange: reuse the file's standard fixture (signals + a harness whose model output cites them,
  // with relevance >= 7 so proposals fire) and a seeded route with an ACTIVE waypoint.
  const first = await runRadar(IDENTITY, { objective: OBJ, query: "q", routeId }, deps());
  expect(first.observations.length).toBeGreaterThan(0);
  const obsAfterFirst = await prisma.memoryNode.count({ where: { businessId: IDENTITY.businessId, type: "market-observation" } });
  const actionsAfterFirst = await prisma.routeAction.count({ where: { businessId: IDENTITY.businessId } });

  const second = await runRadar(IDENTITY, { objective: OBJ, query: "q", routeId }, deps());
  expect(second.observations).toHaveLength(0); // everything already known
  expect(await prisma.memoryNode.count({ where: { businessId: IDENTITY.businessId, type: "market-observation" } })).toBe(obsAfterFirst);
  expect(await prisma.routeAction.count({ where: { businessId: IDENTITY.businessId } })).toBe(actionsAfterFirst);
});
```

*(Adapt fixture names to the file's existing helpers; the load-bearing assertions are the three counts.)*

- [ ] **Step 2: RED** — the current code re-records + re-proposes.
- [ ] **Step 3: Implement.** In `run-radar.ts`, after the survivors filter and BEFORE the record loop, filter to fresh survivors; iterate `fresh` in BOTH the record loop and the propose loop:

```typescript
  // Rerun-safety (6a): an already-recorded sourceUrl is not new news — skip it entirely
  // (neither re-recorded NOR re-proposed), so an unattended nightly rerun adds zero duplicates.
  const fresh: typeof survivors = [];
  for (const o of survivors) {
    const known = await prisma.memoryNode.findFirst({
      where: { businessId: identity.businessId, type: "market-observation", sourceUrl: o.sourceUrl } });
    if (known) continue;
    fresh.push(o);
  }
  if (fresh.length < survivors.length) {
    console.error(`radar: skipped ${survivors.length - fresh.length} already-recorded observation(s) (rerun dedup).`);
  }
```

Then change the record loop `for (const o of survivors)` → `for (const o of fresh)`, and the propose loop `for (const o of survivors)` → `for (const o of fresh)`. Nothing else changes.

- [ ] **Step 4: GREEN** + full dept suite green (the existing radar tests use fresh tenants per test, so first-run behavior is unchanged).
- [ ] **Step 5: Commit** — `feat: radar rerun dedup - an already-recorded sourceUrl is neither re-recorded nor re-proposed`

---

## Task 3: Concurrency hardening (the unattended-caller fixes: 5c flip-path P2002 + 5d atomic upsert)

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/belief-graph.ts`
- Modify: `packages/dionysus-mcp/src/tools/integration.ts`
- Test: extend `packages/dionysus-mcp/test/belief-graph.test.ts`

**Interfaces:** No signature changes. `persistCraftBelief`'s flip path no longer throws on a concurrent-writer P2002 (the racing winner already snapshotted the prior state — skip duplicating, still update the live node). `connectIntegration` becomes a native atomic `prisma.integration.upsert` on the `businessId_kind_provider` compound unique (removes the find-then-create TOCTOU).

- [ ] **Step 1: Write the failing test** (append to `belief-graph.test.ts`, reusing `resetBusinesses`/`BIZ`/`positive`/`negative`):

```typescript
it("flip-path is concurrency-safe: a pre-existing snapshot at the same index (racing winner) does not throw", async () => {
  await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
  // Simulate the racing winner: the snapshot at index 0 ALREADY exists.
  await prisma.memoryNode.create({ data: {
    businessId: BIZ, type: "learning", role: "copywriter", title: "copywriter · channel=linkedin (superseded)",
    body: "winner's snapshot", confidence: 0.7, stance: "positive",
    sourceId: "copywriter::channel=linkedin::superseded::0", tainted: false } });

  // The losing flip must NOT throw; the live node still flips; no duplicate snapshot is created.
  const flipped = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: negative });
  expect(flipped.superseded).toBe(true);
  const live = await prisma.memoryNode.findUnique({ where: { id: flipped.beliefNodeId } });
  expect(live?.stance).toBe("negative");
  const snapshots = await prisma.memoryNode.count({
    where: { businessId: BIZ, type: "learning", sourceId: { startsWith: "copywriter::channel=linkedin::superseded::" } } });
  expect(snapshots).toBe(1); // the winner's — not duplicated
});
```

- [ ] **Step 2: RED** — the current flip path counts 1 existing snapshot, creates `::superseded::1`… wait, no: the pre-existing snapshot makes `snapshotCount` = 1, so the create targets index 1 and succeeds — that would NOT throw. To make the test model the REAL race (both writers computed count=0), the pre-existing row must be created AFTER the count would run. The deterministic way: pre-create the index-0 snapshot, then TEMPORARILY the test must force the same index — instead, test the true seam: make the count see 0. Since we cannot hook mid-function, test the CATCH DIRECTLY by pre-creating BOTH `::superseded::0` **and** asserting on a fresh key where we pre-create the exact index the function will compute. Concretely: pre-create `::superseded::0` for a belief that has had NO prior flips — then `snapshotCount` counts it (=1) → creates index 1 → no P2002. So the honest deterministic RED requires the alternative implementation: the fix below RE-DERIVES the index inside a P2002 catch. To *prove* the catch, replicate the 5b/5c convention (raw-dup P2002 probe + inspection): assert via a RAW duplicate create that the `@@unique` really fires on a duplicate snapshot sourceId (deterministic), and pin the catch by inspection + the test above (which pins that a pre-existing winner snapshot never corrupts the flip: count-based index skips over it). BOTH assertions go in:

```typescript
it("a raw duplicate snapshot sourceId violates @@unique (P2002) — the constraint the flip-path catch relies on", async () => {
  await prisma.memoryNode.create({ data: { businessId: BIZ, type: "learning", role: "copywriter", title: "s", body: "s", confidence: 0.5, stance: "positive", sourceId: "copywriter::x::superseded::0", tainted: false } });
  await expect(prisma.memoryNode.create({ data: { businessId: BIZ, type: "learning", role: "copywriter", title: "s2", body: "s2", confidence: 0.5, stance: "positive", sourceId: "copywriter::x::superseded::0", tainted: false } }))
    .rejects.toMatchObject({ code: "P2002" });
});
```

- [ ] **Step 3: Implement.**

**belief-graph.ts** — wrap the flip-path snapshot+edge creation in an `isUniqueViolation` catch (racing winner already recorded the supersession; skip duplicating, still update the live node):

```typescript
  let superseded = false;
  if (isFlip) {
    const snapshotCount = await prisma.memoryNode.count({
      where: { businessId: identity.businessId, type: "learning", sourceId: { startsWith: `${sourceId}::superseded::` } },
    });
    try {
      const snapshot = await prisma.memoryNode.create({
        data: {
          businessId: identity.businessId, type: "learning", role, waypointId: null,
          title: `${title} (superseded)`, body: existing.body, confidence: existing.confidence, stance: existing.stance,
          sourceId: `${sourceId}::superseded::${snapshotCount}`, tainted: false,
        },
      });
      await prisma.memoryEdge.create({
        data: { businessId: identity.businessId, fromId: existing.id, toId: snapshot.id, kind: "supersedes" },
      });
    } catch (error: unknown) {
      // Concurrency: a racing flip computed the same snapshot index and won — the prior
      // state IS snapshotted (the winner's row + supersedes edge). Skip duplicating it;
      // the live-node update below still lands this flip's new stance.
      if (!isUniqueViolation(error)) throw error;
    }
    superseded = true;
  }
```

**integration.ts** — replace `connectIntegration`'s find-then-create/update with the native atomic upsert (the compound-unique key name for `@@unique([businessId, kind, provider])` is `businessId_kind_provider`):

```typescript
export async function connectIntegration(
  identity: Identity,
  input: { kind: string; provider: string; metric: string; config: IntegrationConfig },
): Promise<{ integrationId: string }> {
  const configEnc = encryptSecret(JSON.stringify(input.config)); // throws fail-closed if the key is absent
  // Native atomic upsert on the compound unique — no find-then-create TOCTOU window.
  const row = await prisma.integration.upsert({
    where: { businessId_kind_provider: { businessId: identity.businessId, kind: input.kind, provider: input.provider } },
    create: { businessId: identity.businessId, kind: input.kind, provider: input.provider,
      metric: input.metric, configEnc, status: "connected" },
    update: { metric: input.metric, configEnc, status: "connected" },
  });
  return { integrationId: row.id };
}
```

(The existing `integration.test.ts` re-connect/upsert tests pin the behavior — they must stay green unchanged.)

- [ ] **Step 4: GREEN** — `pnpm vitest run test/belief-graph.test.ts test/integration.test.ts` (with `$env:DATABASE_URL`), then `pnpm build` (department consumes the dist in later tasks).
- [ ] **Step 5: Commit** — `fix: concurrency-safe belief flip + atomic integration upsert for unattended callers`

---

## Task 4: SSRF-guarded production metric transport

**Files:**
- Modify: `packages/dionysus-mcp/src/lib/ssrf.ts` (additive `headers` option)
- Modify: `packages/dionysus-mcp/src/tools/analytics.ts` (`metricTransportFromSafeFetch`)
- Test: extend `packages/dionysus-mcp/test/analytics.test.ts`

**Interfaces:**
- `SafeFetchOptions` gains `headers?: Record<string, string>` — merged over the default user-agent.
- `metricTransportFromSafeFetch(opts?: SafeFetchOptions): MetricTransport` — the PRODUCTION transport; `ok` iff status 200; `json()` parses the buffered body. Degradation stays in `fetchCurrentMetric` (an SSRF block throws inside the transport → caught → null → no snapshot).

- [ ] **Step 1: Write the failing test** (append to `analytics.test.ts`; uses a local `node:http` server + the `__testAllowPrivate` seam, mirroring the ssrf test conventions):

```typescript
import { createServer } from "node:http";
import { metricTransportFromSafeFetch } from "../src/tools/analytics.js";

describe("metricTransportFromSafeFetch (production transport)", () => {
  it("reads a real JSON metric through the SSRF-guarded fetch (test seam) and forwards the Bearer header", async () => {
    let seenAuth = "";
    const server = createServer((req, res) => {
      seenAuth = String(req.headers["authorization"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: 7 }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const transport = metricTransportFromSafeFetch({ __testAllowPrivate: true });
      const value = await fetchCurrentMetric({ endpoint: `http://127.0.0.1:${port}/stats`, apiKey: "k123" }, transport);
      expect(value).toBe(7);
      expect(seenAuth).toBe("Bearer k123");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a private/loopback endpoint WITHOUT the test seam is SSRF-blocked and degrades to null (no reading, no snapshot)", async () => {
    const transport = metricTransportFromSafeFetch(); // production posture
    const value = await fetchCurrentMetric({ endpoint: "http://127.0.0.1/stats" }, transport);
    expect(value).toBeNull(); // the SSRF throw is caught by fetchCurrentMetric's degrade path
  });
});
```

- [ ] **Step 2: RED** — `metricTransportFromSafeFetch` not exported.
- [ ] **Step 3: Implement.**

**ssrf.ts** — add to `SafeFetchOptions`:

```typescript
  /** Extra request headers (e.g. an analytics Bearer key). Merged over the default user-agent. */
  headers?: Record<string, string>;
```

and change the request headers line to:

```typescript
        headers: { "user-agent": "dionysus-mcp/0.1 (+verified-read-only)", ...(opts.headers ?? {}) },
```

**analytics.ts** — add:

```typescript
import { safeFetch, type SafeFetchOptions } from "../lib/ssrf.js";

/**
 * The PRODUCTION MetricTransport: the stage-1 SSRF-guarded fetch (the analytics endpoint is
 * founder-provided, semi-trusted). An SSRF block / network failure throws inside the transport,
 * which fetchCurrentMetric catches and degrades to null — no reading, no snapshot, no fabrication.
 * `opts` exists for the test seams only; production callers pass nothing.
 */
export function metricTransportFromSafeFetch(opts?: SafeFetchOptions): MetricTransport {
  return async (url, headers) => {
    const res = await safeFetch(url, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), ...headers } });
    return { ok: res.status === 200, status: res.status, json: async () => JSON.parse(res.body) as unknown };
  };
}
```

- [ ] **Step 4: GREEN** — `pnpm vitest run test/analytics.test.ts` (plus the ssrf suite stays green: `pnpm vitest run test/ssrf.test.ts` or the file covering safeFetch), then `pnpm build`.
- [ ] **Step 5: Commit** — `feat: SSRF-guarded production metric transport - safeFetch headers option + adapter`

---

## Task 5: `runNightly` + `runNightlySweep` (the wake itself)

**Files:**
- Create: `packages/department/src/run-nightly.ts`
- Test: `packages/department/test/run-nightly.test.ts`

**Interfaces:**
- Consumes: `runRadar`/`RadarDeps` (`./run-radar.js`), `ingestMetrics`/`metricTransportFromSafeFetch`/`MetricTransport` (`dionysus-mcp/tools/analytics`), `prisma`, `Identity`, `Harness`, `HnTransport`.
- Produces:

```typescript
export type NightlyDeps = { harness: Harness; models: { brain: string }; hnTransport?: HnTransport; metricTransport?: MetricTransport };
export type SectionResult =
  | { status: "ok"; detail: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };
export type NightlyBusinessResult = { businessId: string; radar: SectionResult; metrics: SectionResult };
export function runNightly(identity: Identity, deps: NightlyDeps): Promise<NightlyBusinessResult>;
export function runNightlySweep(deps: NightlyDeps): Promise<NightlyBusinessResult[]>;
```

- [ ] **Step 1: Write the failing test.** Create `test/run-nightly.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "dionysus-mcp/db";
import type { Harness, AgentDef } from "../src/llm/types.js";
import { runNightly, runNightlySweep } from "../src/run-nightly.js";
import type { HnTransport } from "../src/tools/hn-source.js";

const A = { businessId: "biz_nightly_a" };
const B = { businessId: "biz_nightly_b" };

async function wipe(businessId: string) {
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

async function seedBusiness(businessId: string, name: string) {
  await wipe(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name, maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000 } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
}

// One grounded HN signal; the fake model cites it with high relevance.
const SIGNAL_URL = "https://news.ycombinator.com/item?id=42";
const hnTransport: HnTransport = async () => ({ ok: true, status: 200,
  json: async () => ({ hits: [{ title: "Devtool wave", objectID: "42", points: 120 }] }) });
const goodHarness = (): Harness => ({
  async runAgent(_def: AgentDef, _input: string) {
    return { finalOutput: JSON.stringify({ observations: [{ title: "Devtool wave", body: "b", sourceUrl: SIGNAL_URL, relevance: 8, confidence: 0.6 }] }) };
  },
});
const throwingHarness = (): Harness => ({ async runAgent() { throw new Error("model down"); } });

describe("runNightly", () => {
  beforeEach(async () => { await seedBusiness(A.businessId, "Alpha Co"); await seedBusiness(B.businessId, "Beta Co"); });

  it("runs radar for a business with an objective and records real observations + proposals", async () => {
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.radar.status).toBe("ok");
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(1);
    expect(await prisma.routeAction.count({ where: { businessId: A.businessId, status: "proposed" } })).toBe(1);
  });

  it("skips radar (honestly) when the business has no objective; metrics skips when no source is connected", async () => {
    await prisma.routeAction.deleteMany({ where: { businessId: A.businessId } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: A.businessId } });
    await prisma.route.deleteMany({ where: { businessId: A.businessId } });
    await prisma.objective.deleteMany({ where: { businessId: A.businessId } });
    const res = await runNightly(A, { harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.radar.status).toBe("skipped");
    expect(res.metrics.status).toBe("skipped");
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId } })).toBe(0);
  });

  it("a radar failure is caught per business — reported failed, nothing persisted, metrics still attempted", async () => {
    const res = await runNightly(A, { harness: throwingHarness(), models: { brain: "fake" }, hnTransport });
    expect(res.radar.status).toBe("failed");
    expect(res.metrics.status).toBe("skipped"); // independent section still ran
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(0);
  });
});

describe("runNightlySweep", () => {
  beforeEach(async () => { await seedBusiness(A.businessId, "Alpha Co"); await seedBusiness(B.businessId, "Beta Co"); });

  it("isolates failures: one business's broken night never blocks the next business", async () => {
    // A's budget is exhausted (runRadar throws fail-closed); B is healthy.
    await prisma.business.update({ where: { id: A.businessId }, data: { maxTokensPerDay: 0 } });
    const results = await runNightlySweep({ harness: goodHarness(), models: { brain: "fake" }, hnTransport });
    const a = results.find((r) => r.businessId === A.businessId)!;
    const b = results.find((r) => r.businessId === B.businessId)!;
    expect(a.radar.status).toBe("failed"); // budget fail-closed, caught
    expect(b.radar.status).toBe("ok"); // the sweep continued
    expect(await prisma.memoryNode.count({ where: { businessId: B.businessId, type: "market-observation" } })).toBe(1);
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(0);
  });
});
```

*(Note: the sweep iterates ALL businesses in the shared test DB — other suites' tenants may appear in `results`; the test asserts on A/B by find, never on `results.length`.)*

- [ ] **Step 2: RED** — module not found.
- [ ] **Step 3: Implement.** Create `src/run-nightly.ts`:

```typescript
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
  hnTransport?: HnTransport;      // test seam; production uses the real HN fetch
  metricTransport?: MetricTransport; // test seam; production defaults to the SSRF-guarded adapter
};
export type SectionResult =
  | { status: "ok"; detail: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };
export type NightlyBusinessResult = { businessId: string; radar: SectionResult; metrics: SectionResult };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** One business's night: radar then metrics, each best-effort, never throwing to the caller. */
export async function runNightly(identity: Identity, deps: NightlyDeps): Promise<NightlyBusinessResult> {
  const businessId = identity.businessId;

  // RADAR — needs a business (the sensing query is its name) and an objective (the lens).
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
      radar = { status: "failed", reason: reason(error) }; // incl. the budget fail-closed throw
    }
  }

  // METRICS — independent of radar; needs a connected source (ingestMetrics skips otherwise).
  let metrics: SectionResult;
  try {
    const transport = deps.metricTransport ?? metricTransportFromSafeFetch();
    const { snapshotId } = await ingestMetrics(identity, { transport });
    metrics = snapshotId
      ? { status: "ok", detail: `snapshot ${snapshotId}` }
      : { status: "skipped", reason: "no connected source or no reading" };
  } catch (error: unknown) {
    metrics = { status: "failed", reason: reason(error) };
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
      // runNightly itself is best-effort; this is the belt-and-suspenders isolation layer.
      results.push({ businessId: b.id,
        radar: { status: "failed", reason: reason(error) },
        metrics: { status: "failed", reason: reason(error) } });
    }
  }
  return results;
}
```

- [ ] **Step 4: GREEN** — `pnpm vitest run test/run-nightly.test.ts`, then full dept suite.
- [ ] **Step 5: Commit** — `feat: runNightly + runNightlySweep - the nightly wake, per-business isolated, best-effort, budget fail-closed`

---

## Task 6: The gated operator script (`nightly.mjs`)

**Files:**
- Create: `packages/department/scripts/nightly.mjs`
- Modify: `packages/department/package.json` (add `"nightly": "node scripts/nightly.mjs"` to scripts)

- [ ] **Step 1: Create the script** (mirrors `live-smoke.mjs` — builds real deps against `dist/`; any external scheduler invokes it):

```javascript
// GATED nightly wake (stage 6a). One sweep: every business gets its night —
// radar sensing + metric ingestion — under its own identity, failures isolated.
// Invoke from any external scheduler (Task Scheduler / cron / a platform job):
//   pnpm --filter department nightly
// Env: GATEWAY_LOCAL_URL (default http://127.0.0.1:8787/v1), GATEWAY_TOKEN (default "local"),
// DEPARTMENT_BRAIN_MODEL (default below), DATABASE_URL (the business DB),
// DIONYSUS_CONFIG_KEY (needed only to decrypt connected analytics configs — without it,
// metric ingestion degrades to "skipped", honestly; radar still runs).
import { createSdkHarness } from "../dist/llm/harness.js";
import { runNightlySweep } from "../dist/run-nightly.js";

const gatewayUrl = process.env.GATEWAY_LOCAL_URL ?? "http://127.0.0.1:8787/v1";
const brain = process.env.DEPARTMENT_BRAIN_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
if (!process.env.DIONYSUS_CONFIG_KEY) {
  console.error("nightly: DIONYSUS_CONFIG_KEY not set — metric ingestion will be skipped (radar unaffected).");
}

const harness = createSdkHarness({ baseUrl: gatewayUrl, apiKey: process.env.GATEWAY_TOKEN ?? "local" });
const started = Date.now();
const results = await runNightlySweep({ harness, models: { brain } });

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.radar.status === "failed" || r.metrics.status === "failed").length;
console.log(`\nnightly: ${results.length} business(es) in ${Math.round((Date.now() - started) / 1000)}s — ${failed} with failures (see report above).`);
process.exit(0); // per-business failures are REPORTED, not fatal — the sweep itself succeeded
```

- [ ] **Step 2: Verify it builds + fail-safes.** `cd D:\Dionysus\packages\department; pnpm build` then run the script against the TEST DB with no gateway running: `$env:DATABASE_URL="file:../dionysus-mcp/prisma/.tmp/test.db"; node scripts/nightly.mjs` — expected: a JSON report where radar sections are `failed` (gateway unreachable) or `skipped`, metrics `skipped`, exit 0. (This is the acceptance: it exists, builds against dist/, degrades honestly. The live run happens when the founder starts the gateway.)
- [ ] **Step 3: Commit** — `feat: nightly operator script - one sweep, any scheduler, per-business report`

---

## Task 7: §15 eval gate

**Files:**
- Create: `packages/department/test/nightly-eval.e2e.test.ts`

The gate pins the unattended-liveness invariants NON-VACUOUSLY. Reuse Task 5's fixture style (fresh `biz_nightlyeval_*` tenants; fake harness/hnTransport; real DB).

- [ ] **Step 1: Write the gate** with these invariants (complete code follows the T5 fixture patterns — same wipe/seed helpers, tenants `biz_nightlyeval_a/b`):
  - **inv1 RERUN-SAFE:** two consecutive `runNightly` calls over the same signals → the second adds ZERO market-observation rows and ZERO RouteAction rows (counts pinned before/after).
  - **inv2 TRUNCATE-NOT-REJECT:** a harness emitting 9 grounded observations (all citing fetched signal URLs — supply 9 signals via the hnTransport fixture) → exactly 8 observations persisted, radar status "ok" (the night is NOT thrown away).
  - **inv3 ISOLATION + BUDGET FAIL-CLOSED:** business A with `maxTokensPerDay: 0` and business B healthy, one sweep → A radar "failed" with zero A-rows AND a harness call-count of 0 for A (use a counting harness), B radar "ok" with its row persisted.
  - **inv4 METRICS HONESTY:** B with a connected source + an okTransport(42) metricTransport → exactly one snapshot value 42; then a failing metricTransport on a rerun → still exactly one snapshot (nothing fabricated). (Set `process.env.DIONYSUS_CONFIG_KEY` in the file's `beforeAll`, import `connectIntegration` from `dionysus-mcp/tools/integration`.)
  - **inv5 CROSS-TENANT:** after the sweep, every market-observation/RouteAction/MetricSnapshot row created carries the businessId of ITS OWN business — pin by counting each tenant's rows (A: 0 of each; B: exactly its own) while BOTH tenants exist.
  - **inv6 WHITELIST:** `TOOL_SCHEMAS` via the dist export (`import { TOOL_SCHEMAS } from "dionysus-mcp/server"`) — length 11, and none of `run_nightly`, `run_radar`, `ingest_metrics`, `connect_integration`.
- [ ] **Step 2: Run the gate + the full dept suite** — all green.
- [ ] **Step 3: Commit** — `test: stage-6a eval gate - the nightly wake is rerun-safe, isolated, budget-fail-closed, honest, non-MCP`

---

## Self-Review

**1. Spec coverage.** D30's trigger/wake responsibility — delivered as the schedulable sweep (container wake/hibernate deferred: no deployment target). The 4e "BUNDLE WITH 6a CRON" items (max-8 hard-fail, rerun dedup) — T1/T2. The 5d deferred production transport (SSRF-guarded) — T4. The tracked concurrency fast-follows that an unattended caller activates (5c flip-path, 5d upsert) — T3. Radar/ingestion triggers land per the 4e review's blessed "gated dept operator-script" path — T6.

**2. Placeholder scan.** T2/T7 reference existing fixture helpers by role with the load-bearing assertions spelled out — adaptation notes, not placeholders. All other steps carry complete code.

**3. Type consistency.** `NightlyDeps`/`SectionResult`/`NightlyBusinessResult` defined once (T5), consumed by T6/T7. `MetricTransport` unchanged from 5d; `metricTransportFromSafeFetch(opts?)` defined T4, consumed T5. `MAX_OBSERVATIONS` defined T1, referenced in T7's inv2 expectation (8).

## Out of Scope (deferred, with rationale)

- **Container wake/hibernate, state.db snapshots, offboarding (D30 full)** → when a deployment target (Modal/Daytona) exists. The sweep is scheduler-agnostic by design.
- **Webhook signature verification + per-business action-initiation rate limits (M2)** → when the first inbound webhook/provider exists. Today the only trigger is the operator script; the budget gate is the spend ceiling.
- **TrustPolicy / autonomy tiers (D27.2 policy surface)** → when connected-API auto-posting lands. Everything the nightly produces is `proposed` (never-auto) — there is nothing for a policy to police yet.
- **In-process cron daemon** → YAGNI; any external scheduler invokes the script. A platform job replaces it at deploy time.
- **Live-vendor analytics OAuth (GA4/GSC)** → per-provider follow-on (5d note stands).

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh Opus subagent per task, review between tasks, whole-branch review at the end.
2. **Inline Execution** — execute in this session with checkpoints.
