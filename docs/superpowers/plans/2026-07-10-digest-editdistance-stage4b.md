# Stage 4b — D22 Digest + Edit-Distance + Cockpit Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make founder attention a measured, budgeted resource (D22): approvals consolidate into a daily Digest, the founder can edit drafts in the cockpit before approving, and every edit's Levenshtein distance is instrumented on the RouteAction as the leading churn indicator — plus the 4a debt: approve/reject/edit results become visible in the UI (useActionState) and the server-action layer gets direct tests.

**Architecture:** Everything data-side lands in `dionysus-mcp` as identity-scoped server functions that are **never MCP-registered** (the 3c tool-whitelist gate enforces this automatically): a pure `levenshtein`, `editDraftContent` (new Asset revision + rebind while proposed — the 3c bind-guard makes an edit racing an approval lose cleanly), and a `Digest` service (idempotent daily batch). The cockpit refactors its actions into vitest-testable cores + thin `"use server"` wrappers, and the drafts page becomes the daily-review view with a client `DraftCard` (edit textarea, approve/reject, visible results).

**Tech Stack:** unchanged — Prisma 6, TypeScript strict, vitest; Next 15/React 19 (cockpit, TS ~5.8); no new dependencies (Levenshtein is ~20 lines, no library).

## Global Constraints

- **D22 (spec, verbatim intent):** "approvals consolidate into a **daily digest** … **draft edit-distance is instrumented as the leading churn indicator**". Digest model per §10: `Digest { id, businessId, date, reviewedAt?, itemCount }`. `editDistance` and `digestId` land on RouteAction (the §10 fields deferred from 3c-Task-1's YAGNI cut — now they're used, they're added).
- **Digest semantics (ratified judgment):** `digestId` = the digest an action was FIRST batched into (never moves — itemCounts stay truthful). `buildDailyDigest` is idempotent per (businessId, date) via `@@unique` and attaches only not-yet-batched reviewable drafts. The daily-review page shows ALL currently-proposed drafts regardless of first-batch day (nothing is ever hidden by a stale digestId); the Digest row records the day's batch + `reviewedAt`. Digest is built lazily on page view (no cron until D30 — recorded).
- **Edit semantics (ratified):** editing is a drafting-phase act — allowed ONLY while `proposed` (the existing `setActionAsset` guard enforces the rebind; `editDraftContent` pre-checks for a friendly error). An edit = new Asset revision (provenance history preserved) + rebind (contentHash rebound) + `editDistance += levenshtein(oldBody, newBody)` (cumulative across edits). A zero-distance edit is a no-op (no new asset). Body-only editing at 4b (no title editing in the UI — YAGNI).
- **D29 preserved:** approve/reject/edit all flow through dionysus-mcp server functions; NO new MCP tool (the 3c whitelist gate goes RED if anyone registers one — that gate is the tripwire, do not touch it); the edited content is what approval binds (hash follows the rebind).
- **D27.1:** identity from the verified session only; every new read/write scoped `businessId`; digest/edit functions take `Identity` first.
- **4a debt closed here (plan-recorded obligations):** server actions get direct tests via extracted CORES (`(session, args) => ActionResult` — no request scope needed); the drafts page surfaces ActionResult messages via `useActionState` client components. (The GET-redeem CSRF mitigation stays scheduled for 4d — NOT this stage.)
- **Testing:** TDD; shared test DB (`$env:DATABASE_URL = "file:./.tmp/test.db"`); cockpit tests also need `$env:COCKPIT_SESSION_SECRET`; dionysus-mcp BUILT before cockpit/department runs. Baselines: mcp 122, dept 40, cockpit 20 — all stay green. Tenant-scoped cleanup.
- **Commits:** conventional, no attribution footer. **Shell:** Windows/PowerShell (Git Bash broken); pnpm workspace.

## File Structure

```
packages/dionysus-mcp/
  prisma/schema.prisma            # + Digest model; + RouteAction.digestId?/editDistance?
  src/lib/edit-distance.ts        # levenshtein (pure)
  src/tools/draft-edit.ts         # editDraftContent (identity-scoped, NOT MCP-registered)
  src/tools/digest.ts             # utcDayKey/buildDailyDigest/markDigestReviewed (NOT MCP-registered)
  test/edit-distance.test.ts
  test/draft-edit.test.ts
  test/digest.test.ts
packages/cockpit/
  src/lib/review-actions.ts       # approveDraftCore/rejectDraftCore/editDraftCore/markReviewedCore
  src/app/actions.ts              # thin "use server" wrappers (useActionState signatures)
  src/app/drafts/draft-card.tsx   # "use client": edit textarea + approve/reject + visible results
  src/app/drafts/page.tsx         # daily-review view: digest header + DraftCard list
  src/lib/review.ts               # DraftCard type + editDistance/digest fields
  test/review-actions.test.ts
  test/digest-eval.e2e.test.ts    # Task 7 §15 gate
```

---

### Task 1: `Digest` model + RouteAction `digestId`/`editDistance` (additive)

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma`
- Test: `packages/dionysus-mcp/test/digest.test.ts` (schema portion; grows in Task 4)

**Interfaces:**
- Produces: `Digest { id cuid, businessId (+relation +@@index), date String, reviewedAt DateTime?, itemCount Int @default(0), createdAt, @@unique([businessId, date]) }`; RouteAction + `digestId String?` + `editDistance Int?`. Tasks 3/4 write them.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/digest.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

const BIZ = "biz_digest";

describe("Digest schema", () => {
  beforeAll(async () => {
    await prisma.digest.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "DG" }, update: {} });
  });

  it("persists a digest keyed uniquely by (businessId, date)", async () => {
    const d = await prisma.digest.create({ data: { businessId: BIZ, date: "2026-07-10" } });
    expect(d.reviewedAt).toBeNull();
    expect(d.itemCount).toBe(0);
    await expect(prisma.digest.create({ data: { businessId: BIZ, date: "2026-07-10" } }))
      .rejects.toThrow(/unique/i);
  });

  it("RouteAction carries digestId and editDistance defaults", async () => {
    const obj = await prisma.objective.create({ data: { businessId: BIZ, kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: BIZ, objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
    const action = await prisma.routeAction.create({ data: { businessId: BIZ, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
    expect(action.digestId).toBeNull();
    expect(action.editDistance).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** (from `packages/dionysus-mcp`, `$env:DATABASE_URL = "file:./.tmp/test.db"`).

- [ ] **Step 3: Edit `schema.prisma`** — add to RouteAction (after `rejectionCount`):

```prisma
  digestId       String?
  editDistance   Int?
```

Append the model + `Business.digests Digest[]` back-relation:

```prisma
model Digest {
  id         String    @id @default(cuid())
  businessId String
  business   Business  @relation(fields: [businessId], references: [id])
  date       String
  reviewedAt DateTime?
  itemCount  Int       @default(0)
  createdAt  DateTime  @default(now())

  @@unique([businessId, date])
  @@index([businessId])
}
```

- [ ] **Step 4: Generate + push + run** — `pnpm prisma generate; pnpm prisma db push; pnpm vitest run test/digest.test.ts` (2 passed); FULL mcp suite (124); `pnpm build`.
- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: Digest model + RouteAction digestId/editDistance (D22)"`

---

### Task 2: `levenshtein` (pure)

**Files:**
- Create: `packages/dionysus-mcp/src/lib/edit-distance.ts`
- Test: `packages/dionysus-mcp/test/edit-distance.test.ts`

**Interfaces:**
- Produces: `levenshtein(a: string, b: string): number`. Task 3 consumes.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { levenshtein } from "../src/lib/edit-distance.js";

describe("levenshtein", () => {
  it("identity is 0; empty-vs-string is the string length", () => {
    expect(levenshtein("draft", "draft")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
  it("known distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
    expect(levenshtein("Show HN: We built X", "Show HN: We built Y")).toBe(1);
  });
  it("symmetric on a sample", () => {
    expect(levenshtein("abcdef", "azced")).toBe(levenshtein("azced", "abcdef"));
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement** (two-row DP, O(min memory)):

```ts
/** D22: Levenshtein edit distance — the founder-churn leading indicator. Pure, no deps. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  let curr: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
```

- [ ] **Step 4: Run → green; full suite; build. Step 5: Commit** — `feat: pure levenshtein for D22 edit-distance instrumentation`

---

### Task 3: `editDraftContent` — the drafting-phase edit

**Files:**
- Create: `packages/dionysus-mcp/src/tools/draft-edit.ts`
- Test: `packages/dionysus-mcp/test/draft-edit.test.ts`

**Interfaces:**
- Consumes: `prisma`, `Identity`, `levenshtein` (Task 2), `persistAsset`/`setActionAsset` (3b/3c — the rebind path with the proposed-only bind guard and hash rebinding).
- Produces: `editDraftContent(identity, { routeActionId, newBody }): Promise<{ assetId: string; editDistance: number; totalEditDistance: number }>` — NOT MCP-registered. Proposed-only (friendly pre-check + the bind-guard as backstop); zero-distance no-op returns the current assetId with no new row; cumulative `editDistance` on the action.

- [ ] **Step 1: Failing tests**

`packages/dionysus-mcp/test/draft-edit.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction } from "../src/tools/lifecycle.js";
import { editDraftContent } from "../src/tools/draft-edit.js";
import { hashContent } from "../src/lib/content-hash.js";
import { levenshtein } from "../src/lib/edit-distance.js";

const BIZ = "biz_edit";

async function freshBoundAction(businessId: string, body: string) {
  const obj = await prisma.objective.create({ data: { businessId, kind: "k", target: "1", metric: "m", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId }, { channel: "x", kind: "post", content: { title: "T", body }, routeActionId: action.id });
  await setActionAsset({ businessId }, action.id, assetId);
  return { actionId: action.id, assetId };
}

describe("editDraftContent (D22)", () => {
  beforeAll(async () => {
    for (const model of [prisma.asset, prisma.routeAction, prisma.routeWaypoint, prisma.route, prisma.objective] as const) {
      await (model as { deleteMany: (a: object) => Promise<unknown> }).deleteMany({ where: { businessId: BIZ } });
    }
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "ED" }, update: {} });
    await prisma.business.upsert({ where: { id: "biz_edit_other" }, create: { id: "biz_edit_other", name: "EO" }, update: {} });
  });

  it("edit rebinds a NEW asset revision, rebinds the hash, records the distance, preserves the title", async () => {
    const { actionId, assetId: original } = await freshBoundAction(BIZ, "hello world");
    const res = await editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "hello brave world" });
    expect(res.assetId).not.toBe(original);
    expect(res.editDistance).toBe(levenshtein("hello world", "hello brave world"));
    const action = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(action!.assetId).toBe(res.assetId);
    expect(action!.editDistance).toBe(res.editDistance);
    const asset = await prisma.asset.findUnique({ where: { id: res.assetId } });
    const content = JSON.parse(asset!.contentJson) as { title?: string; body?: string };
    expect(content.body).toBe("hello brave world");
    expect(content.title).toBe("T"); // title preserved
    expect(action!.contentHash).toBe(hashContent(asset!.contentJson)); // hash follows the edit
    const history = await prisma.asset.findMany({ where: { routeActionId: actionId } });
    expect(history).toHaveLength(2); // provenance history preserved
  });

  it("edits accumulate; a zero-distance edit is a no-op (no new asset)", async () => {
    const { actionId } = await freshBoundAction(BIZ, "aaaa");
    const first = await editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "aaab" });
    const second = await editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "aabb" });
    expect(second.totalEditDistance).toBe(first.editDistance + second.editDistance);
    const before = await prisma.asset.count({ where: { routeActionId: actionId } });
    const noop = await editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "aabb" });
    expect(noop.editDistance).toBe(0);
    expect(await prisma.asset.count({ where: { routeActionId: actionId } })).toBe(before);
  });

  it("editing a non-proposed action is refused; the approved binding never moves", async () => {
    const { actionId, assetId } = await freshBoundAction(BIZ, "final copy");
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" });
    await expect(editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "sneaky rewrite" }))
      .rejects.toThrow(/not in "proposed" status/i);
    const action = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(action!.assetId).toBe(assetId);
  });

  it("cross-tenant edit fails closed", async () => {
    const { actionId } = await freshBoundAction(BIZ, "mine");
    await expect(editDraftContent({ businessId: "biz_edit_other" }, { routeActionId: actionId, newBody: "theirs" }))
      .rejects.toThrow(/not found|scope/i);
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement `src/tools/draft-edit.ts`**

```ts
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { levenshtein } from "../lib/edit-distance.js";
import { persistAsset, setActionAsset } from "./asset.js";

export type EditDraftInput = { routeActionId: string; newBody: string };
export type EditDraftResult = { assetId: string; editDistance: number; totalEditDistance: number };

/**
 * D22: a founder edit during review. Drafting-phase only (proposed) — the setActionAsset
 * bind-guard is the write-layer backstop; this pre-check just gives the friendly error.
 * Cumulative editDistance is the churn leading indicator.
 */
export async function editDraftContent(identity: Identity, input: EditDraftInput): Promise<EditDraftResult> {
  const action = await prisma.routeAction.findFirst({ where: { id: input.routeActionId, businessId: identity.businessId } });
  if (!action) throw new Error(`RouteAction ${input.routeActionId} not found in this business scope.`);
  if (action.status !== "proposed") {
    throw new Error(`Cannot edit: RouteAction ${input.routeActionId} is not in "proposed" status (editing is a drafting-phase act).`);
  }
  if (!action.assetId) throw new Error(`RouteAction ${input.routeActionId} has no bound asset to edit.`);
  const asset = await prisma.asset.findFirst({ where: { id: action.assetId, businessId: identity.businessId } });
  if (!asset) throw new Error(`Asset ${action.assetId} not found in this business scope.`);

  let content: Record<string, unknown>;
  try {
    content = JSON.parse(asset.contentJson) as Record<string, unknown>;
  } catch {
    content = {};
  }
  const oldBody = typeof content.body === "string" ? content.body : "";
  const distance = levenshtein(oldBody, input.newBody);
  if (distance === 0) {
    return { assetId: asset.id, editDistance: 0, totalEditDistance: action.editDistance ?? 0 };
  }

  const { assetId } = await persistAsset(identity, {
    channel: asset.channel, kind: asset.kind,
    content: { ...content, body: input.newBody }, routeActionId: action.id });
  await setActionAsset(identity, action.id, assetId); // proposed-only guard + hash rebind live here
  const totalEditDistance = (action.editDistance ?? 0) + distance;
  await prisma.routeAction.updateMany({
    where: { id: action.id, businessId: identity.businessId },
    data: { editDistance: totalEditDistance } });
  return { assetId, editDistance: distance, totalEditDistance };
}
```

Do NOT register anything in server.ts (the 3c whitelist gate enforces this).

- [ ] **Step 4: Run → green; FULL mcp suite; build; department suite (40) after building mcp. Step 5: Commit** — `feat: editDraftContent - drafting-phase edit with cumulative edit-distance (D22)`

---

### Task 4: Digest service

**Files:**
- Create: `packages/dionysus-mcp/src/tools/digest.ts`
- Test: `packages/dionysus-mcp/test/digest.test.ts` (append)

**Interfaces:**
- Produces (NOT MCP-registered): `utcDayKey(now?: Date): string` ("YYYY-MM-DD" UTC); `buildDailyDigest(identity, date?: string): Promise<{ digestId: string; itemCount: number }>` (idempotent upsert; attaches only `status:"proposed", assetId != null, digestId: null` actions; itemCount = actions ever batched into THIS digest); `markDigestReviewed(identity, digestId): Promise<void>` (scoped guarded updateMany — once only).

- [ ] **Step 1: Failing tests** (append to `test/digest.test.ts`):

```ts
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { buildDailyDigest, markDigestReviewed, utcDayKey } from "../src/tools/digest.js";

async function reviewableAction(businessId: string, wpId: string) {
  const action = await prisma.routeAction.create({ data: { businessId, waypointId: wpId, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId }, { channel: "x", kind: "post", content: { body: "b" }, routeActionId: action.id });
  await setActionAsset({ businessId }, action.id, assetId);
  return action.id;
}

describe("daily digest (D22)", () => {
  let wpId = "";
  beforeAll(async () => {
    await prisma.asset.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.routeAction.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.route.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.objective.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.digest.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.business.upsert({ where: { id: "biz_digest2" }, create: { id: "biz_digest2", name: "D2" }, update: {} });
    const obj = await prisma.objective.create({ data: { businessId: "biz_digest2", kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: "biz_digest2", objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: "biz_digest2", routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
    wpId = wp.id;
  });

  it("utcDayKey is YYYY-MM-DD", () => {
    expect(utcDayKey(new Date("2026-07-10T23:59:59Z"))).toBe("2026-07-10");
  });

  it("builds idempotently: same digest twice, items batched once, count truthful", async () => {
    const a1 = await reviewableAction("biz_digest2", wpId);
    const a2 = await reviewableAction("biz_digest2", wpId);
    const first = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-10");
    const second = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-10");
    expect(second.digestId).toBe(first.digestId);
    expect(second.itemCount).toBe(2);
    const rows = await prisma.routeAction.findMany({ where: { id: { in: [a1, a2] } } });
    expect(rows.every((r) => r.digestId === first.digestId)).toBe(true);
    // an action already batched does NOT move to a later digest
    const tomorrow = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-11");
    const after = await prisma.routeAction.findUnique({ where: { id: a1 } });
    expect(after!.digestId).toBe(first.digestId);
    expect(tomorrow.itemCount).toBe(0);
  });

  it("a new draft joins TODAY's digest, not yesterday's", async () => {
    const a3 = await reviewableAction("biz_digest2", wpId);
    const today = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-11");
    const row = await prisma.routeAction.findUnique({ where: { id: a3 } });
    expect(row!.digestId).toBe(today.digestId);
    expect(today.itemCount).toBe(1);
  });

  it("markDigestReviewed stamps once, scoped, and refuses a second stamp", async () => {
    const { digestId } = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-12");
    await markDigestReviewed({ businessId: "biz_digest2" }, digestId);
    const d = await prisma.digest.findUnique({ where: { id: digestId } });
    expect(d!.reviewedAt).toBeInstanceOf(Date);
    await expect(markDigestReviewed({ businessId: "biz_digest2" }, digestId)).rejects.toThrow(/not found|already/i);
    await expect(markDigestReviewed({ businessId: "biz_digest" }, digestId)).rejects.toThrow(/not found|already/i); // cross-tenant
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement `src/tools/digest.ts`**

```ts
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** D22: idempotent daily batch. digestId = the digest an action was FIRST batched into (never moves). */
export async function buildDailyDigest(identity: Identity, date: string = utcDayKey()): Promise<{ digestId: string; itemCount: number }> {
  const digest = await prisma.digest.upsert({
    where: { businessId_date: { businessId: identity.businessId, date } },
    create: { businessId: identity.businessId, date },
    update: {},
  });
  await prisma.routeAction.updateMany({
    where: { businessId: identity.businessId, status: "proposed", assetId: { not: null }, digestId: null },
    data: { digestId: digest.id },
  });
  const itemCount = await prisma.routeAction.count({
    where: { businessId: identity.businessId, digestId: digest.id } });
  await prisma.digest.updateMany({
    where: { id: digest.id, businessId: identity.businessId }, data: { itemCount } });
  return { digestId: digest.id, itemCount };
}

export async function markDigestReviewed(identity: Identity, digestId: string): Promise<void> {
  const { count } = await prisma.digest.updateMany({
    where: { id: digestId, businessId: identity.businessId, reviewedAt: null },
    data: { reviewedAt: new Date() },
  });
  if (count === 0) throw new Error(`Digest ${digestId} not found in this business scope or already reviewed.`);
}
```

- [ ] **Step 4: Run → green; FULL mcp suite; build; department (40). Step 5: Commit** — `feat: idempotent daily digest with first-batch semantics + reviewed stamp (D22)`

---

### Task 5: Cockpit action cores + thin wrappers + direct tests (4a debt)

**Files:**
- Create: `packages/cockpit/src/lib/review-actions.ts`
- Modify: `packages/cockpit/src/app/actions.ts` (thin wrappers with useActionState signatures)
- Test: `packages/cockpit/test/review-actions.test.ts`

**Interfaces:**
- Produces: `type ActionResult = { ok: boolean; message: string }` (moves here; actions.ts re-exports); cores taking `CockpitSession = Pick<SessionPayload, "businessId" | "email">`:
  - `approveDraftCore(session, routeActionId): Promise<ActionResult>`
  - `rejectDraftCore(session, routeActionId): Promise<ActionResult>`
  - `editDraftCore(session, routeActionId, newBody): Promise<ActionResult>` (rejects empty/whitespace-only newBody with a friendly message BEFORE touching the DB; success message includes the distance, e.g. `Saved (edit distance 7).`)
  - `markReviewedCore(session, digestId): Promise<ActionResult>`
- `actions.ts` wrappers become `(prev: ActionResult | null, formData: FormData) => Promise<ActionResult>` for useActionState: read `routeActionId`/`newBody`/`digestId` from formData, `requireSession()`, delegate to core, `revalidatePath("/drafts")` + `revalidatePath("/")` on success.

- [ ] **Step 1: Failing tests**

`packages/cockpit/test/review-actions.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { approveDraftCore, rejectDraftCore, editDraftCore, markReviewedCore } from "../src/lib/review-actions";
import { buildDailyDigest } from "dionysus-mcp/tools/digest";

const S = { businessId: "biz_ck_actions", email: "f@example.com" };

async function freshDraft(body: string) {
  const obj = await prisma.objective.create({ data: { businessId: S.businessId, kind: "k", target: "1", metric: "m", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: S.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: S.businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId: S.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId: S.businessId }, { channel: "x", kind: "post", content: { body }, routeActionId: action.id });
  await setActionAsset({ businessId: S.businessId }, action.id, assetId);
  return action.id;
}

beforeAll(async () => {
  await prisma.digest.deleteMany({ where: { businessId: S.businessId } });
  await prisma.asset.deleteMany({ where: { businessId: S.businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId: S.businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: S.businessId } });
  await prisma.route.deleteMany({ where: { businessId: S.businessId } });
  await prisma.objective.deleteMany({ where: { businessId: S.businessId } });
  await prisma.business.upsert({ where: { id: S.businessId }, create: { id: S.businessId, name: "CKA" }, update: {} });
});

describe("cockpit action cores (direct tests — 4a debt)", () => {
  it("approve: ok=true, approvedBy = session email; approving again returns ok=false with a message (no throw)", async () => {
    const id = await freshDraft("approve me");
    const res = await approveDraftCore(S, id);
    expect(res.ok).toBe(true);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.approvedBy).toBe(S.email);
    const again = await approveDraftCore(S, id);
    expect(again.ok).toBe(false);
    expect(again.message.length).toBeGreaterThan(0);
  });

  it("reject: ok=true and status lands rejected", async () => {
    const id = await freshDraft("reject me");
    const res = await rejectDraftCore(S, id);
    expect(res.ok).toBe(true);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.status).toBe("rejected");
  });

  it("edit: ok=true with the distance in the message; empty body refused without DB writes", async () => {
    const id = await freshDraft("original body");
    const res = await editDraftCore(S, id, "original bodyy");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/1/);
    const before = await prisma.asset.count({ where: { businessId: S.businessId } });
    const bad = await editDraftCore(S, id, "   ");
    expect(bad.ok).toBe(false);
    expect(await prisma.asset.count({ where: { businessId: S.businessId } })).toBe(before);
  });

  it("markReviewed: ok=true once, ok=false the second time; wrong tenant ok=false", async () => {
    const { digestId } = await buildDailyDigest({ businessId: S.businessId }, "2026-07-13");
    expect((await markReviewedCore(S, digestId)).ok).toBe(true);
    expect((await markReviewedCore(S, digestId)).ok).toBe(false);
    expect((await markReviewedCore({ businessId: "biz_ck_ghost", email: "g@x.com" }, digestId)).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement**

`src/lib/review-actions.ts`:

```ts
import { approveAction, rejectAction } from "dionysus-mcp/tools/lifecycle";
import { editDraftContent } from "dionysus-mcp/tools/draft-edit";
import { markDigestReviewed } from "dionysus-mcp/tools/digest";
import type { SessionPayload } from "./session";

export type ActionResult = { ok: boolean; message: string };
export type CockpitSession = Pick<SessionPayload, "businessId" | "email">;

function friendly(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export async function approveDraftCore(session: CockpitSession, routeActionId: string): Promise<ActionResult> {
  try {
    const { approveAction } = await import("dionysus-mcp/tools/lifecycle");
    await approveAction({ businessId: session.businessId }, { routeActionId, principal: session.email });
    return { ok: true, message: "Approved." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}
```

(Use plain top-level imports, not the dynamic import shown above — write it as:)

```ts
export async function approveDraftCore(session: CockpitSession, routeActionId: string): Promise<ActionResult> {
  try {
    await approveAction({ businessId: session.businessId }, { routeActionId, principal: session.email });
    return { ok: true, message: "Approved." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}

export async function rejectDraftCore(session: CockpitSession, routeActionId: string): Promise<ActionResult> {
  try {
    await rejectAction({ businessId: session.businessId }, { routeActionId });
    return { ok: true, message: "Rejected." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}

export async function editDraftCore(session: CockpitSession, routeActionId: string, newBody: string): Promise<ActionResult> {
  if (!newBody.trim()) return { ok: false, message: "The draft body cannot be empty." };
  try {
    const res = await editDraftContent({ businessId: session.businessId }, { routeActionId, newBody });
    return { ok: true, message: res.editDistance === 0 ? "No changes." : `Saved (edit distance ${res.editDistance}, total ${res.totalEditDistance}).` };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}

export async function markReviewedCore(session: CockpitSession, digestId: string): Promise<ActionResult> {
  try {
    await markDigestReviewed({ businessId: session.businessId }, digestId);
    return { ok: true, message: "Digest marked as reviewed." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}
```

`src/app/actions.ts` (full replacement — thin wrappers):

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "../lib/auth";
import {
  approveDraftCore, rejectDraftCore, editDraftCore, markReviewedCore,
  type ActionResult,
} from "../lib/review-actions";

export type { ActionResult } from "../lib/review-actions";

function refresh(result: ActionResult): ActionResult {
  if (result.ok) {
    revalidatePath("/drafts");
    revalidatePath("/");
  }
  return result;
}

export async function approveDraft(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return refresh(await approveDraftCore(session, String(formData.get("routeActionId") ?? "")));
}

export async function rejectDraft(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return refresh(await rejectDraftCore(session, String(formData.get("routeActionId") ?? "")));
}

export async function editDraft(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return refresh(await editDraftCore(session, String(formData.get("routeActionId") ?? ""), String(formData.get("newBody") ?? "")));
}

export async function markReviewed(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return refresh(await markReviewedCore(session, String(formData.get("digestId") ?? "")));
}
```

NOTE: this changes actions.ts's signatures — the drafts page still uses the OLD inline closures until Task 6 replaces it. To keep the build green within THIS task, update `src/app/drafts/page.tsx`'s two inline forms minimally to hidden-input forms:

```tsx
          <form action={approveDraft.bind(null, null)} style={{ display: "inline" }}>
            <input type="hidden" name="routeActionId" value={d.actionId} />
            <button type="submit">Approve</button>
          </form>{" "}
          <form action={rejectDraft.bind(null, null)} style={{ display: "inline" }}>
            <input type="hidden" name="routeActionId" value={d.actionId} />
            <button type="submit">Reject</button>
          </form>
```

(Task 6 replaces this page wholesale with the client DraftCard.)

- [ ] **Step 4: Run → green (cockpit 24 expected); `next build` clean. Step 5: Commit** — `feat: testable action cores + useActionState-shaped wrappers (closes 4a server-action debt)`

---

### Task 6: Daily-review UI — DraftCard client component + digest header

**Files:**
- Create: `packages/cockpit/src/app/drafts/draft-card.tsx`
- Modify: `packages/cockpit/src/app/drafts/page.tsx` (digest-driven), `packages/cockpit/src/lib/review.ts` (DraftCard type + editDistance)

**Interfaces:**
- `review.ts`: `DraftCard` gains `editDistance: number | null`; new `getDigestHeader(identity): Promise<{ digestId: string; date: string; itemCount: number; reviewedAt: Date | null; openCount: number }>` — calls `buildDailyDigest` (lazy build on view, ratified) then reads the digest row; `openCount` = currently-proposed-with-asset count (what the page lists).
- `draft-card.tsx` (`"use client"`): renders one draft; `useActionState(approveDraft, null)` / `useActionState(rejectDraft, null)` / `useActionState(editDraft, null)`; a textarea (defaultValue = body, name="newBody") + hidden routeActionId in each form; shows each action's `state.message` with red/green styling by `state.ok`; shows `Edit distance so far: N` when editDistance != null.
- `drafts/page.tsx` (server): requireSession → getDigestHeader → listProposedDrafts → header (date, itemCount, reviewedAt or a mark-reviewed form via `useActionState`-shaped `markReviewed` — a plain form with hidden digestId is fine server-side) + `<DraftCard>` list.

- [ ] **Step 1: Implement `review.ts` additions**

In `listProposedDrafts`, add `editDistance: action.editDistance` to the pushed card (extend the `DraftCard` type accordingly). Append:

```ts
import { buildDailyDigest } from "dionysus-mcp/tools/digest";

export type DigestHeader = { digestId: string; date: string; itemCount: number; reviewedAt: Date | null; openCount: number };

export async function getDigestHeader(identity: Identity): Promise<DigestHeader> {
  const { digestId } = await buildDailyDigest(identity);
  const digest = await prisma.digest.findFirst({ where: { id: digestId, businessId: identity.businessId } });
  const openCount = await prisma.routeAction.count({
    where: { businessId: identity.businessId, status: "proposed", assetId: { not: null } } });
  return { digestId, date: digest!.date, itemCount: digest!.itemCount, reviewedAt: digest!.reviewedAt, openCount };
}
```

- [ ] **Step 2: Add a service test** (append to `test/review.test.ts`):

```ts
import { getDigestHeader } from "../src/lib/review";

it("digest header builds today's digest lazily and counts open drafts", async () => {
  const header = await getDigestHeader(A);
  expect(header.digestId).toBeTruthy();
  expect(header.openCount).toBeGreaterThanOrEqual(1); // the bound draft from the fixture
  expect(header.reviewedAt).toBeNull();
});
```

Run → FAIL (getDigestHeader missing) → implement Step 1 → green.

- [ ] **Step 3: Implement `draft-card.tsx`**

```tsx
"use client";

import { useActionState } from "react";
import { approveDraft, rejectDraft, editDraft, type ActionResult } from "../actions";

export type DraftCardProps = {
  actionId: string; employeeRole: string; type: string;
  channel: string | null; title: string | null; body: string | null;
  waypointTitle: string; rationale: string | null; editDistance: number | null;
};

function Result({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p style={{ color: state.ok ? "#0a7d33" : "#b00020", margin: "4px 0" }}>{state.message}</p>;
}

export function DraftCard(d: DraftCardProps) {
  const [approveState, approveFormAction] = useActionState(approveDraft, null);
  const [rejectState, rejectFormAction] = useActionState(rejectDraft, null);
  const [editState, editFormAction] = useActionState(editDraft, null);
  return (
    <article style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <p style={{ color: "#666", margin: 0 }}>
        {d.waypointTitle} · {d.employeeRole} · {d.type} · {d.channel}
        {d.editDistance != null ? ` · edit distance so far: ${d.editDistance}` : ""}
      </p>
      {d.title ? <h3>{d.title}</h3> : null}
      <form action={editFormAction}>
        <input type="hidden" name="routeActionId" value={d.actionId} />
        <textarea name="newBody" defaultValue={d.body ?? ""} rows={6} style={{ width: "100%", fontFamily: "inherit" }} />
        <button type="submit">Save edit</button>
      </form>
      <Result state={editState} />
      {d.rationale ? <p style={{ color: "#666" }}>Why: {d.rationale}</p> : null}
      <form action={approveFormAction} style={{ display: "inline" }}>
        <input type="hidden" name="routeActionId" value={d.actionId} />
        <button type="submit">Approve</button>
      </form>{" "}
      <form action={rejectFormAction} style={{ display: "inline" }}>
        <input type="hidden" name="routeActionId" value={d.actionId} />
        <button type="submit">Reject</button>
      </form>
      <Result state={approveState ?? rejectState} />
    </article>
  );
}
```

- [ ] **Step 4: Rewrite `drafts/page.tsx`**

```tsx
import { requireSession } from "../../lib/auth";
import { listProposedDrafts, getDigestHeader } from "../../lib/review";
import { markReviewed } from "../actions";
import { DraftCard } from "./draft-card";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const header = await getDigestHeader(identity);
  const drafts = await listProposedDrafts(identity);
  return (
    <main>
      <h2>Daily review — {header.date}</h2>
      <p style={{ color: "#666" }}>
        {header.itemCount} item(s) batched today · {header.openCount} open now ·{" "}
        {header.reviewedAt ? `reviewed ${header.reviewedAt.toISOString()}` : "not yet reviewed"}
      </p>
      {!header.reviewedAt ? (
        <form action={markReviewed.bind(null, null)}>
          <input type="hidden" name="digestId" value={header.digestId} />
          <button type="submit">Mark today reviewed</button>
        </form>
      ) : null}
      {drafts.length === 0 ? <p>No drafts waiting for review.</p> : drafts.map((d) => <DraftCard key={d.actionId} {...d} />)}
    </main>
  );
}
```

- [ ] **Step 5: Run** — cockpit suite green (25 expected); `pnpm exec next build` clean (drafts page dynamic; the client component compiles).
- [ ] **Step 6: Commit** — `feat: daily-review page - digest header, inline draft editing, visible action results`

---

### Task 7: §15 eval gate — D22 under attack

**Files:**
- Test: `packages/cockpit/test/digest-eval.e2e.test.ts` (test-only; STOP and report if an invariant fails)

**Interfaces:** consumes the full stack (digest + edit + lifecycle + cores).

- [ ] **Step 1: Write the gate** — invariants to pin (write the fixtures in the established style: fresh tenant `biz_dg_eval` + ghost tenant, tenant-scoped cleanup, chains built via real tool functions):

```ts
// §15 stage-4b eval gate — D22 digest + edit-distance under attack.
// Attacks: double-build (no re-batch), edit-after-approve (binding must not move),
// edited-content approval (hash must follow the LAST edit), cross-tenant digest/edit,
// stale-digest reviewedAt double-stamp.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { startExecution } from "dionysus-mcp/tools/lifecycle";
import { buildDailyDigest, markDigestReviewed } from "dionysus-mcp/tools/digest";
import { hashContent } from "dionysus-mcp/lib/content-hash";
import { approveDraftCore, editDraftCore, markReviewedCore } from "../src/lib/review-actions";

const S = { businessId: "biz_dg_eval", email: "founder@example.com" };
const GHOST = { businessId: "biz_dg_eval_ghost", email: "ghost@example.com" };
let wpId = "";

async function freshDraft(body: string) {
  const action = await prisma.routeAction.create({ data: { businessId: S.businessId, waypointId: wpId, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId: S.businessId }, { channel: "x", kind: "post", content: { body }, routeActionId: action.id });
  await setActionAsset({ businessId: S.businessId }, action.id, assetId);
  return action.id;
}

beforeAll(async () => {
  for (const id of [S.businessId, GHOST.businessId]) {
    await prisma.digest.deleteMany({ where: { businessId: id } });
    await prisma.asset.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  const obj = await prisma.objective.create({ data: { businessId: S.businessId, kind: "k", target: "1", metric: "m", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: S.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: S.businessId, routeId: route.id, order: 1, title: "Launch", goal: "g", status: "active" } });
  wpId = wp.id;
});

describe("§15 stage-4b eval gate — D22 under attack", () => {
  it("the founder's edit is what gets approved and executed: hash follows the LAST edit; the pre-edit asset cannot sneak through", async () => {
    const id = await freshDraft("the robot's first draft");
    const edit = await editDraftCore(S, id, "the founder's rewrite");
    expect(edit.ok).toBe(true);
    const approve = await approveDraftCore(S, id);
    expect(approve.ok).toBe(true);
    const action = await prisma.routeAction.findUnique({ where: { id } });
    const bound = await prisma.asset.findUnique({ where: { id: action!.assetId! } });
    expect((JSON.parse(bound!.contentJson) as { body: string }).body).toBe("the founder's rewrite");
    expect(action!.contentHash).toBe(hashContent(bound!.contentJson));
    // the ORIGINAL asset still exists (provenance) but is NOT what executes
    const history = await prisma.asset.findMany({ where: { routeActionId: id } });
    expect(history).toHaveLength(2);
    await startExecution({ businessId: S.businessId }, { routeActionId: id, runId: "run_edited" });
    const executing = await prisma.routeAction.findUnique({ where: { id } });
    expect(executing!.status).toBe("executing");
  });

  it("edit-after-approve is refused through the cockpit core; the approved binding and editDistance are untouched", async () => {
    const id = await freshDraft("approved words");
    await approveDraftCore(S, id);
    const before = await prisma.routeAction.findUnique({ where: { id } });
    const res = await editDraftCore(S, id, "sneaky post-approval rewrite");
    expect(res.ok).toBe(false);
    const after = await prisma.routeAction.findUnique({ where: { id } });
    expect(after!.assetId).toBe(before!.assetId);
    expect(after!.editDistance).toBe(before!.editDistance);
  });

  it("digest cannot double-batch: two builds same day = one digest, one membership; ghost tenant sees nothing", async () => {
    const id = await freshDraft("batch me");
    const first = await buildDailyDigest(S, "2026-07-20");
    const second = await buildDailyDigest(S, "2026-07-20");
    expect(second.digestId).toBe(first.digestId);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.digestId).toBe(first.digestId);
    const ghostBuild = await buildDailyDigest(GHOST, "2026-07-20");
    expect(ghostBuild.itemCount).toBe(0); // A's drafts never leak into GHOST's digest
    expect(ghostBuild.digestId).not.toBe(first.digestId);
    await expect(markDigestReviewed(GHOST, first.digestId)).rejects.toThrow(/not found|already/i);
  });

  it("cumulative edit distance survives the full review flow (the D22 churn metric is real)", async () => {
    const id = await freshDraft("v1");
    await editDraftCore(S, id, "v22");
    await editDraftCore(S, id, "v333");
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.editDistance).toBeGreaterThanOrEqual(2); // two real edits accumulated
    const digest = await buildDailyDigest(S, "2026-07-21");
    expect((await markReviewedCore(S, digest.digestId)).ok).toBe(true);
    expect((await markReviewedCore(S, digest.digestId)).ok).toBe(false); // single stamp
  });
});
```

Self-check each assertion for vacuity before committing (the project has caught FIVE vacuous gate assertions; two were plan-authored): the edit-approve test must verify the hash against the DB-read contentJson (not against a variable the test controls); the ghost-digest test must run AFTER tenant-A drafts exist unbatched-for-that-date (they don't — they were batched to A's digest; the load-bearing leak check is `ghostBuild.itemCount === 0` given A HAS proposed drafts — confirm at least one A draft is still proposed and unbatched when the ghost builds, otherwise ADD one first so the assertion can actually catch an unscoped updateMany).

IMPORTANT fixture note: in test 3, A's draft `batch me` is batched into A's 2026-07-20 digest BEFORE the ghost builds — so at ghost-build time there are no unbatched A drafts and `ghostBuild.itemCount === 0` would hold even if buildDailyDigest ignored businessId. FIX THE GATE as you write it: create ONE MORE unbatched proposed draft for A immediately before the ghost build, then assert `ghostBuild.itemCount === 0` AND that the new A draft's digestId is still null (the ghost build must not have claimed it). This is the non-vacuous form.

- [ ] **Step 2: Run the gate, then the whole workspace** — cockpit suite (29 expected); `next build`; FULL mcp suite (expected 124 + Task 2/3/4 additions — report actual); mcp build; department (40) + build. The 3c whitelist gate MUST still pass (proves no new MCP tool leaked in).
- [ ] **Step 3: Commit** — `test: stage-4b eval gate - edited content is what executes, digests never double-batch or cross tenants`

---

## Out of Scope (deliberate)

- Cron-scheduled digest building + notifications (D30 platform layer; digest is lazily built on view at 4b — recorded).
- Interrupts for time-sensitive/high-stakes items (needs TrustPolicy — stage 6a).
- Chat-bar iteration / `revisionOf` agent redrafts (D29 "new short run" — needs harness runs from the cockpit; later 4x/5 work).
- Title editing in the UI (body-only at 4b).
- GET-redeem CSRF mitigation (scheduled for 4d — before email delivery).
- The ≤10-15 min/day review-time measurement (needs client timing instrumentation; CMO-report stage 4f).

## Self-Review Notes

- **Spec coverage:** D22 digest model + daily batch (T1/T4), edit-distance instrumented on RouteAction (T1/T2/T3), cockpit edit-before-approve with visible feedback (T5/T6), 4a debt closed — action cores tested directly + useActionState wiring (T5/T6), §15 gate (T7). §10 Digest field set matches the spec line.
- **Type consistency:** `ActionResult` defined once in review-actions.ts, re-exported by actions.ts, consumed by draft-card.tsx; `EditDraftInput/Result` (T3) consumed by T5; `DigestHeader` (T6) self-contained; cores take `CockpitSession = Pick<SessionPayload, ...>`.
- **Judgment calls on record:** digestId never moves (first-batch semantics — truthful itemCounts; the page lists ALL open drafts so nothing hides); lazy digest build on page view (no cron until D30); zero-distance edits are no-ops; editDistance update is a separate write from the rebind (single-founder actor at 4b; an edit racing an approval loses cleanly at the bind guard — the orphan revision asset is harmless provenance); body-only edit distance; `markReviewed` uses a guarded updateMany (single stamp).
