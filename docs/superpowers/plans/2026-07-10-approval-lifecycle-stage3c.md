# Stage 3c — D29 Approval Lifecycle + Plan-Tool Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make approval a server-validated, content-bound act (D29): drafts bind a content hash at link time, the cockpit-path approve signs over it, the execution path refuses tampered content, and no agent-reachable tool can assert a status — plus the plan-tool hardening deferred from stage 3a (status enums, waypoint order uniqueness).

**Architecture:** Everything lands in `dionysus-mcp` (the department is untouched this stage — `draftWaypoint` picks up hash-binding for free via `setActionAsset`). Four pieces: (1) RouteAction lifecycle columns + `@@unique([routeId, order])`; (2) z.enum status schemas + function-layer validation on the stage-3a plan tools; (3) a sha256 content-hash module wired into `setActionAsset`; (4) `approveAction`/`rejectAction`/`startExecution`/`completeExecution` as identity-scoped **server functions that are never registered as MCP tools** (cockpit-path only, per D29 "never agent-asserted").

**Tech Stack:** TypeScript strict, Prisma 6 (pinned), zod v3, `node:crypto`, vitest — existing pnpm workspace. No new dependencies.

## Global Constraints

- **CONCURRENCY CONSTRAINT LIFTED:** the stage-3b "additive-only vs dionysus-mcp" rule is DEAD. The spawned hardening session produced zero commits (worktree `claude/recursing-volhard-210bb5` is clean at `c46f8b4`) and its scope is absorbed into THIS plan (Task 2 + the `@@unique` in Task 1). Stage 3c may freely edit `src/tools/plan.ts`, `src/server.ts`, and the `RouteWaypoint` model. If that session's branch ever gains commits later, it is superseded — discard it.
- **D29 (spec §8/D29, verbatim contract):** "Approval is never in-run... Cockpit approve = a content-bound act signing (principal, ts, contentHash, businessId); the send path refuses content whose hash differs from the approved one... Status transitions are server-validated, never agent-asserted." Allowed transitions: `proposed→approved|rejected` (cockpit), `approved→executing` (execution start), `executing→executed|rejected`. Nothing else.
- **D27.1:** identity ambient; every read/write scoped `findFirst({ id, businessId })`; lifecycle functions take `Identity` first; NO new MCP tool takes businessId; the lifecycle functions are NOT MCP tools at all.
- **Status enums (from the 3a whole-branch finding, ratified):** objective `active|paused|done`; route `proposed|active|done`; waypoint `locked|active|done`; RouteAction `proposed|approved|executing|executed|rejected` (server-set only — `upsert_route_action` keeps forcing `"proposed"`, no status input). Enforce at BOTH the zod TOOL_SCHEMAS boundary and the tool-function layer (direct function callers bypass zod).
- **Hash discipline:** `contentHash` = sha256 hex over the Asset's stored `contentJson` string exactly as persisted (no canonicalization games — the stored string IS the content). Bound when `setActionAsset` links the asset (D29: hash lands at draft time); re-derived + compared at approve AND at execution start; mismatch always throws, never coerces.
- **Testing:** TDD; no test needs an API key or network. Shared test DB (`$env:DATABASE_URL = "file:./.tmp/test.db"`, resolves against the prisma/ schema dir); `pnpm prisma generate` + `pnpm prisma db push` after schema changes. Tenant-scoped cleanup. Baselines: dionysus-mcp 97 tests, department 40 — BOTH suites must stay green (department imports dionysus-mcp's dist; build dionysus-mcp first).
- **Commits:** conventional, no attribution footer. **Shell:** Windows/PowerShell (Git Bash broken); pnpm workspace.

## File Structure

```
packages/dionysus-mcp/
  prisma/schema.prisma          # RouteAction + approvedAt/approvedBy/runId/rejectionCount; RouteWaypoint @@unique([routeId, order])
  src/tools/plan.ts             # status enum constants + function-layer validation (types tightened)
  src/server.ts                 # TOOL_SCHEMAS status fields -> z.enum (create_objective/persist_route/persist_waypoint)
  src/lib/content-hash.ts       # hashContent (sha256 hex)
  src/tools/asset.ts            # setActionAsset also binds contentHash
  src/tools/lifecycle.ts        # approveAction/rejectAction/startExecution/completeExecution/assertContentBound (NOT MCP-registered)
  test/lifecycle.test.ts        # Tasks 1-4 unit tests (grows per task)
  test/plan.test.ts             # Task 2 appends enum-rejection tests (file exists from 3a)
  test/server.test.ts           # Task 2 appends schema-boundary tests
  test/lifecycle-eval.e2e.test.ts  # Task 5 §15 exit gate
```

(Department: zero file changes. Its suite runs as stage verification only.)

---

### Task 1: Lifecycle columns + waypoint order uniqueness

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma` (RouteAction: 4 new columns; RouteWaypoint: add `@@unique([routeId, order])`)
- Test: `packages/dionysus-mcp/test/lifecycle.test.ts` (new file, grows in Tasks 3-4)

**Interfaces:**
- Produces: `RouteAction.approvedAt DateTime?`, `approvedBy String?`, `runId String?`, `rejectionCount Int @default(0)`; `RouteWaypoint @@unique([routeId, order])`. Task 4 writes the new columns. (`revisionOf`/`editDistance`/`digestId` are deliberately NOT added — YAGNI until stage 4 chat-iteration/digest.)

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/lifecycle.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

const BIZ = "biz_lifecycle";

async function cleanTenant(businessId: string) {
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

async function makeChain(businessId: string) {
  const obj = await prisma.objective.create({ data: { businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  return { obj, route, wp, action };
}

describe("lifecycle schema", () => {
  beforeAll(async () => {
    await cleanTenant(BIZ);
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "LC" }, update: {} });
  });

  it("RouteAction carries the D29 lifecycle columns with safe defaults", async () => {
    const { action } = await makeChain(BIZ);
    expect(action.approvedAt).toBeNull();
    expect(action.approvedBy).toBeNull();
    expect(action.runId).toBeNull();
    expect(action.rejectionCount).toBe(0);
  });

  it("rejects a duplicate (routeId, order) waypoint", async () => {
    const { route } = await makeChain(BIZ);
    await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 2, title: "a", goal: "g", status: "locked" } });
    await expect(prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 2, title: "b", goal: "g", status: "locked" } }))
      .rejects.toThrow(/unique/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — from `packages/dionysus-mcp` with `$env:DATABASE_URL = "file:./.tmp/test.db"`: `pnpm vitest run test/lifecycle.test.ts` → FAIL (columns missing / duplicate order accepted).

- [ ] **Step 3: Edit `schema.prisma`**

In `model RouteAction`, after `metricsJson  String?` add:

```prisma
  approvedAt     DateTime?
  approvedBy     String?
  runId          String?
  rejectionCount Int      @default(0)
```

In `model RouteWaypoint`, after `@@index([businessId])` add:

```prisma
  @@unique([routeId, order])
```

- [ ] **Step 4: Generate + push + run**

```powershell
$env:DATABASE_URL = "file:./.tmp/test.db"
node scripts/reset-test-db.mjs   # existing test rows may violate the new unique constraint; reset first
pnpm prisma generate
pnpm prisma db push
pnpm vitest run test/lifecycle.test.ts   # 2 passed
pnpm vitest run                          # FULL suite green (97 + 2)
pnpm build
```

- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: D29 lifecycle columns on RouteAction + unique waypoint order per route"`

---

### Task 2: Status-enum hardening (the absorbed 3a follow-up)

**Files:**
- Modify: `packages/dionysus-mcp/src/tools/plan.ts` (enum constants, tightened input types, function-layer validation)
- Modify: `packages/dionysus-mcp/src/server.ts` (three TOOL_SCHEMAS status fields → z.enum)
- Test: `packages/dionysus-mcp/test/plan.test.ts` (append), `packages/dionysus-mcp/test/server.test.ts` (append)

**Interfaces:**
- Consumes: existing `createObjective`/`persistRoute`/`persistWaypoint` signatures (defaults preserved: objective `"active"`, route `"proposed"`, waypoint `order===1 ? "active" : "locked"` — all inside the enums).
- Produces: exported `const OBJECTIVE_STATUSES = ["active", "paused", "done"] as const;`, `ROUTE_STATUSES = ["proposed", "active", "done"] as const;`, `WAYPOINT_STATUSES = ["locked", "active", "done"] as const;` from `src/tools/plan.ts`. Input types become `status?: (typeof OBJECTIVE_STATUSES)[number]` etc. Task 5's gate consumes the constants. `upsert_route_action` is untouched (already server-sets `"proposed"`, no status input).

- [ ] **Step 1: Write the failing tests**

Append to `test/plan.test.ts`:

```ts
import { OBJECTIVE_STATUSES, ROUTE_STATUSES, WAYPOINT_STATUSES } from "../src/tools/plan.js";

describe("status-enum hardening (function layer)", () => {
  it("createObjective rejects an out-of-enum status", async () => {
    await expect(createObjective({ businessId: TEST_BIZ }, // reuse the file's existing seeded tenant const
      { kind: "k", target: "1", metric: "m", status: "garbage" as never }))
      .rejects.toThrow(/invalid objective status/i);
  });
  it("persistRoute and persistWaypoint reject out-of-enum statuses", async () => {
    // build on rows the existing tests created, or create a fresh objective/route here
    const { objectiveId } = await createObjective({ businessId: TEST_BIZ }, { kind: "k", target: "1", metric: "m" });
    await expect(persistRoute({ businessId: TEST_BIZ }, { objectiveId, source: "case", status: "garbage" as never }))
      .rejects.toThrow(/invalid route status/i);
    const { routeId } = await persistRoute({ businessId: TEST_BIZ }, { objectiveId, source: "case" });
    await expect(persistWaypoint({ businessId: TEST_BIZ }, { routeId, order: 91, title: "t", goal: "g", status: "garbage" as never }))
      .rejects.toThrow(/invalid waypoint status/i);
  });
  it("exports the ratified enums", () => {
    expect(OBJECTIVE_STATUSES).toEqual(["active", "paused", "done"]);
    expect(ROUTE_STATUSES).toEqual(["proposed", "active", "done"]);
    expect(WAYPOINT_STATUSES).toEqual(["locked", "active", "done"]);
  });
});
```

(Adapt the tenant/seed const names to what `test/plan.test.ts` actually uses — read the file first; the assertions above are the contract.)

Append to `test/server.test.ts` (MCP boundary):

```ts
import { z } from "zod";

it("plan-tool status schemas reject garbage at the MCP boundary", () => {
  for (const key of ["create_objective", "persist_route", "persist_waypoint"] as const) {
    const shape = TOOL_SCHEMAS[key] as Record<string, z.ZodTypeAny>;
    expect(shape.status.safeParse("garbage").success).toBe(false);
    expect(shape.status.safeParse(undefined).success).toBe(true); // still optional
  }
  expect((TOOL_SCHEMAS.create_objective as Record<string, z.ZodTypeAny>).status.safeParse("active").success).toBe(true);
  expect((TOOL_SCHEMAS.persist_route as Record<string, z.ZodTypeAny>).status.safeParse("proposed").success).toBe(true);
  expect((TOOL_SCHEMAS.persist_waypoint as Record<string, z.ZodTypeAny>).status.safeParse("locked").success).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

`src/tools/plan.ts` — add at the top (after imports):

```ts
export const OBJECTIVE_STATUSES = ["active", "paused", "done"] as const;
export const ROUTE_STATUSES = ["proposed", "active", "done"] as const;
export const WAYPOINT_STATUSES = ["locked", "active", "done"] as const;

function assertStatus(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`Invalid ${label} status "${value}" (allowed: ${allowed.join(", ")}).`);
  }
}
```

Tighten the input types:

```ts
export type ObjectiveInput = { kind: string; target: string; metric: string; dueDate?: string; status?: (typeof OBJECTIVE_STATUSES)[number] };
export type RouteInput = { objectiveId: string; source: "case" | "composed"; caseRef?: string; status?: (typeof ROUTE_STATUSES)[number] };
export type WaypointInput = { routeId: string; order: number; title: string; goal: string; status?: (typeof WAYPOINT_STATUSES)[number] };
```

In each function body, validate BEFORE any DB access (first line):

```ts
  if (input.status !== undefined) assertStatus(input.status, OBJECTIVE_STATUSES, "objective");   // createObjective
  if (input.status !== undefined) assertStatus(input.status, ROUTE_STATUSES, "route");           // persistRoute
  if (input.status !== undefined) assertStatus(input.status, WAYPOINT_STATUSES, "waypoint");     // persistWaypoint
```

`src/server.ts` — import the constants and change ONLY the three status fields:

```ts
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction,
  OBJECTIVE_STATUSES, ROUTE_STATUSES, WAYPOINT_STATUSES,
  type ObjectiveInput, type RouteInput, type WaypointInput, type RouteActionInput } from "./tools/plan.js";
```

```ts
  create_objective: { ..., status: z.enum(OBJECTIVE_STATUSES).optional() },
  persist_route:    { ..., status: z.enum(ROUTE_STATUSES).optional() },
  persist_waypoint: { ..., status: z.enum(WAYPOINT_STATUSES).optional() },
```

(zod v3.25 accepts `as const` readonly tuples in `z.enum`; if tsc complains, spread into literals `z.enum(["active", "paused", "done"])` and keep the constants for the function layer — the test pins both layers either way.)

- [ ] **Step 4: Run** — appended tests green; FULL mcp suite green; `pnpm build` clean; then build dionysus-mcp and run the FULL department suite (40 expected — `proposeRoute` passes no status, defaults are in-enum; if anything reds here, the department was passing an out-of-enum status and the fix belongs THERE, not in loosening the enum).

- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: status enums enforced at MCP boundary and tool layer for plan tools"`

---

### Task 3: Content hash bound at asset-link time

**Files:**
- Create: `packages/dionysus-mcp/src/lib/content-hash.ts`
- Modify: `packages/dionysus-mcp/src/tools/asset.ts` (`setActionAsset` binds the hash)
- Test: `packages/dionysus-mcp/test/lifecycle.test.ts` (append)

**Interfaces:**
- Produces: `hashContent(contentJson: string): string` (sha256 hex). `setActionAsset` now also sets `RouteAction.contentHash = hashContent(asset.contentJson)` in the same update. Task 4 consumes `hashContent`; the department's `draftWaypoint` picks this up with zero changes (it already calls `setActionAsset`).

- [ ] **Step 1: Write the failing tests** (append to `test/lifecycle.test.ts`):

```ts
import { createHash } from "node:crypto";
import { hashContent } from "../src/lib/content-hash.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";

describe("content hash binding (D29)", () => {
  it("hashContent is sha256 hex over the exact string", () => {
    const s = JSON.stringify({ body: "hello" });
    expect(hashContent(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    expect(hashContent(s)).toHaveLength(64);
  });

  it("setActionAsset binds contentHash to the linked asset's stored contentJson", async () => {
    const { action } = await makeChain(BIZ);
    const { assetId } = await persistAsset({ businessId: BIZ },
      { channel: "x", kind: "post", content: { body: "draft v1" }, routeActionId: action.id });
    await setActionAsset({ businessId: BIZ }, action.id, assetId);
    const bound = await prisma.routeAction.findUnique({ where: { id: action.id } });
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(bound!.contentHash).toBe(hashContent(asset!.contentJson));
    expect(bound!.contentHash).not.toBe("");
  });

  it("a later asset edit does NOT silently move the bound hash (mismatch stays detectable)", async () => {
    const { action } = await makeChain(BIZ);
    const { assetId } = await persistAsset({ businessId: BIZ },
      { channel: "x", kind: "post", content: { body: "original" }, routeActionId: action.id });
    await setActionAsset({ businessId: BIZ }, action.id, assetId);
    await prisma.asset.update({ where: { id: assetId }, data: { contentJson: JSON.stringify({ body: "tampered" }) } });
    const after = await prisma.routeAction.findUnique({ where: { id: action.id } });
    const tampered = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(after!.contentHash).not.toBe(hashContent(tampered!.contentJson));
  });
});
```

- [ ] **Step 2: Run → FAIL (module missing / contentHash still "").**

- [ ] **Step 3: Implement**

`src/lib/content-hash.ts`:

```ts
import { createHash } from "node:crypto";

/** D29 content binding: sha256 hex over the Asset's stored contentJson string, byte-exact. */
export function hashContent(contentJson: string): string {
  return createHash("sha256").update(contentJson, "utf8").digest("hex");
}
```

`src/tools/asset.ts` — in `setActionAsset`, the asset row is already loaded for the scope guard; extend the final update:

```ts
import { hashContent } from "../lib/content-hash.js";
// ...
  await prisma.routeAction.update({ where: { id: routeActionId },
    data: { assetId, contentHash: hashContent(asset.contentJson) } });
```

- [ ] **Step 4: Run** — appended tests green; FULL mcp suite green; build clean; build dionysus-mcp then FULL department suite (40 — `draftWaypoint`'s tests assert assetId, none pin contentHash === "", so nothing reds; its drafts are now hash-bound for free).

- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: bind sha256 content hash to RouteAction when asset is linked"`

---

### Task 4: Server-validated lifecycle transitions (cockpit-path, never MCP)

**Files:**
- Create: `packages/dionysus-mcp/src/tools/lifecycle.ts`
- Test: `packages/dionysus-mcp/test/lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: `hashContent` (Task 3), lifecycle columns (Task 1), `Identity`, `prisma`.
- Produces (all identity-scoped, all throw on invalid transition, NONE registered in server.ts):
  - `assertContentBound(identity, routeActionId): Promise<void>` — loads the action scoped, requires a linked asset (scoped), re-derives `hashContent(asset.contentJson)`, throws on mismatch with stored `contentHash`.
  - `approveAction(identity, { routeActionId, principal }): Promise<void>` — `proposed`→`approved`; requires content-bound; sets `approvedAt` (server clock) + `approvedBy = principal`.
  - `rejectAction(identity, { routeActionId }): Promise<void>` — `proposed|executing`→`rejected`; increments `rejectionCount`.
  - `startExecution(identity, { routeActionId, runId }): Promise<void>` — `approved`→`executing`; REQUIRES content-bound again (the send-path refusal); sets `runId`.
  - `completeExecution(identity, { routeActionId }): Promise<void>` — `executing`→`executed`.
- Stage 4+ consumes these from the cockpit service and the execution runner. `revisionOf` chat-iteration is out of scope (stage 4).

- [ ] **Step 1: Write the failing tests** (append to `test/lifecycle.test.ts`):

```ts
import { approveAction, rejectAction, startExecution, completeExecution, assertContentBound } from "../src/tools/lifecycle.js";

async function boundAction(businessId: string, body: string) {
  const { action } = await makeChain(businessId);
  const { assetId } = await persistAsset({ businessId },
    { channel: "x", kind: "post", content: { body }, routeActionId: action.id });
  await setActionAsset({ businessId }, action.id, assetId);
  return { actionId: action.id, assetId };
}

describe("D29 lifecycle transitions (server-validated)", () => {
  it("happy path: proposed -> approved -> executing -> executed, fields set at each step", async () => {
    const { actionId } = await boundAction(BIZ, "ship it");
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "founder@example.com" });
    let a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved");
    expect(a!.approvedAt).toBeInstanceOf(Date);
    expect(a!.approvedBy).toBe("founder@example.com");
    await startExecution({ businessId: BIZ }, { routeActionId: actionId, runId: "run_1" });
    a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("executing");
    expect(a!.runId).toBe("run_1");
    await completeExecution({ businessId: BIZ }, { routeActionId: actionId });
    a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("executed");
  });

  it("refuses to approve an action with no bound asset", async () => {
    const { action } = await makeChain(BIZ);
    await expect(approveAction({ businessId: BIZ }, { routeActionId: action.id, principal: "p" }))
      .rejects.toThrow(/no bound asset/i);
  });

  it("refuses to approve when the asset was edited after binding (hash mismatch)", async () => {
    const { actionId, assetId } = await boundAction(BIZ, "original");
    await prisma.asset.update({ where: { id: assetId }, data: { contentJson: JSON.stringify({ body: "tampered" }) } });
    await expect(approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" }))
      .rejects.toThrow(/hash mismatch/i);
  });

  it("send path refuses tampered content AFTER approval (the D29 core)", async () => {
    const { actionId, assetId } = await boundAction(BIZ, "approved copy");
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" });
    await prisma.asset.update({ where: { id: assetId }, data: { contentJson: JSON.stringify({ body: "swapped after approval" }) } });
    await expect(startExecution({ businessId: BIZ }, { routeActionId: actionId, runId: "run_x" }))
      .rejects.toThrow(/hash mismatch/i);
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved"); // refusal does not corrupt state
    expect(a!.runId).toBeNull();
  });

  it("rejects invalid transitions with explicit errors", async () => {
    const { actionId } = await boundAction(BIZ, "x");
    await expect(startExecution({ businessId: BIZ }, { routeActionId: actionId, runId: "r" }))
      .rejects.toThrow(/invalid transition/i);           // proposed -> executing skips approval
    await expect(completeExecution({ businessId: BIZ }, { routeActionId: actionId }))
      .rejects.toThrow(/invalid transition/i);           // proposed -> executed
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" });
    await expect(approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" }))
      .rejects.toThrow(/invalid transition/i);           // approve twice
  });

  it("rejectAction works from proposed AND executing, bumps rejectionCount, and is final", async () => {
    const { actionId } = await boundAction(BIZ, "r1");
    await rejectAction({ businessId: BIZ }, { routeActionId: actionId });
    let a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("rejected");
    expect(a!.rejectionCount).toBe(1);
    await expect(rejectAction({ businessId: BIZ }, { routeActionId: actionId }))
      .rejects.toThrow(/invalid transition/i);           // rejected is terminal

    const second = await boundAction(BIZ, "r2");
    await approveAction({ businessId: BIZ }, { routeActionId: second.actionId, principal: "p" });
    await startExecution({ businessId: BIZ }, { routeActionId: second.actionId, runId: "r" });
    await rejectAction({ businessId: BIZ }, { routeActionId: second.actionId }); // executing -> rejected allowed
    a = await prisma.routeAction.findUnique({ where: { id: second.actionId } });
    expect(a!.status).toBe("rejected");
  });

  it("cross-tenant: another business cannot approve or probe the action (fail-closed)", async () => {
    const { actionId } = await boundAction(BIZ, "mine");
    await prisma.business.upsert({ where: { id: "biz_lc_other" }, create: { id: "biz_lc_other", name: "O" }, update: {} });
    await expect(approveAction({ businessId: "biz_lc_other" }, { routeActionId: actionId, principal: "evil" }))
      .rejects.toThrow(/not found|scope/i);
    await expect(assertContentBound({ businessId: "biz_lc_other" }, actionId))
      .rejects.toThrow(/not found|scope/i);
  });
});
```

- [ ] **Step 2: Run → FAIL (module missing).**

- [ ] **Step 3: Implement `src/tools/lifecycle.ts`**

```ts
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { hashContent } from "../lib/content-hash.js";

export type ApproveInput = { routeActionId: string; principal: string };
export type RejectInput = { routeActionId: string };
export type StartExecutionInput = { routeActionId: string; runId: string };
export type CompleteExecutionInput = { routeActionId: string };

type ActionRow = NonNullable<Awaited<ReturnType<typeof prisma.routeAction.findFirst>>>;

async function loadScopedAction(identity: Identity, routeActionId: string): Promise<ActionRow> {
  const action = await prisma.routeAction.findFirst({ where: { id: routeActionId, businessId: identity.businessId } });
  if (!action) throw new Error(`RouteAction ${routeActionId} not found in this business scope.`);
  return action;
}

function assertTransition(action: ActionRow, allowedFrom: readonly string[], to: string): void {
  if (!allowedFrom.includes(action.status)) {
    throw new Error(`Invalid transition: RouteAction ${action.id} is "${action.status}", cannot move to "${to}" (allowed from: ${allowedFrom.join(", ")}).`);
  }
}

async function assertBound(identity: Identity, action: ActionRow): Promise<void> {
  if (!action.assetId) throw new Error(`RouteAction ${action.id} has no bound asset.`);
  const asset = await prisma.asset.findFirst({ where: { id: action.assetId, businessId: identity.businessId } });
  if (!asset) throw new Error(`Asset ${action.assetId} not found in this business scope.`);
  if (hashContent(asset.contentJson) !== action.contentHash) {
    throw new Error(`Content hash mismatch for RouteAction ${action.id}: current asset content differs from the bound content.`);
  }
}

/** Send-path guard (D29): the current linked asset must hash to the bound contentHash. */
export async function assertContentBound(identity: Identity, routeActionId: string): Promise<void> {
  const action = await loadScopedAction(identity, routeActionId);
  await assertBound(identity, action);
}

/** Cockpit-path only. Never registered as an MCP tool (D29: approval is never agent-asserted). */
export async function approveAction(identity: Identity, input: ApproveInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["proposed"], "approved");
  await assertBound(identity, action);
  await prisma.routeAction.update({ where: { id: action.id },
    data: { status: "approved", approvedAt: new Date(), approvedBy: input.principal } });
}

export async function rejectAction(identity: Identity, input: RejectInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["proposed", "executing"], "rejected");
  await prisma.routeAction.update({ where: { id: action.id },
    data: { status: "rejected", rejectionCount: { increment: 1 } } });
}

export async function startExecution(identity: Identity, input: StartExecutionInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["approved"], "executing");
  await assertBound(identity, action); // the send path refuses content whose hash differs from the approved one
  await prisma.routeAction.update({ where: { id: action.id },
    data: { status: "executing", runId: input.runId } });
}

export async function completeExecution(identity: Identity, input: CompleteExecutionInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["executing"], "executed");
  await prisma.routeAction.update({ where: { id: action.id }, data: { status: "executed" } });
}
```

Do NOT import or register any of these in `src/server.ts`.

- [ ] **Step 4: Run** — appended tests green; FULL mcp suite green; build clean.

- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: D29 server-validated lifecycle - content-bound approve, hash-refusing send path"`

---

### Task 5: §15 eval gate — lifecycle invariants under attack

**Files:**
- Test: `packages/dionysus-mcp/test/lifecycle-eval.e2e.test.ts` (new; no production code expected — if an invariant fails, STOP and report, never weaken the gate)

**Interfaces:** consumes the real plan tools (Task 2 hardened), asset tools, lifecycle functions, `TOOL_SCHEMAS`.

- [ ] **Step 1: Write the gate**

```ts
// §15 stage-3c eval gate — D29 lifecycle invariants under attack.
// Attacks: agent-asserted status (via the MCP tool surface), post-approval content swap,
// approval without content, duplicate waypoint order, garbage enum, cross-tenant approval.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { TOOL_SCHEMAS } from "../src/server.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction, startExecution, completeExecution } from "../src/tools/lifecycle.js";

const A = { businessId: "biz_lceval" };

beforeAll(async () => {
  await prisma.asset.deleteMany({ where: { businessId: A.businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId: A.businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: A.businessId } });
  await prisma.route.deleteMany({ where: { businessId: A.businessId } });
  await prisma.objective.deleteMany({ where: { businessId: A.businessId } });
  await prisma.business.upsert({ where: { id: A.businessId }, create: { id: A.businessId, name: "LcEval" }, update: {} });
});

describe("§15 stage-3c eval gate — D29 under attack", () => {
  it("no agent-reachable path can assert a status: the MCP tool surface exposes no approve/reject/execute tool and no status input on upsert_route_action", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    for (const forbidden of ["approve", "reject", "execute", "transition"]) {
      expect(toolNames.some((n) => n.includes(forbidden))).toBe(false);
    }
    expect(Object.keys(TOOL_SCHEMAS.upsert_route_action)).not.toContain("status");
  });

  it("full lifecycle through the REAL tool functions: draft-bind -> approve -> execute -> complete; then the tamper attack is refused end-to-end", async () => {
    // build the chain with the real (hardened) tools, not raw prisma
    const { objectiveId } = await createObjective(A, { kind: "signups", target: "100", metric: "users" });
    const { routeId } = await persistRoute(A, { objectiveId, source: "case" });
    const { waypointId } = await persistWaypoint(A, { routeId, order: 1, title: "Launch", goal: "20 signups" });
    const { actionId } = await upsertRouteAction(A, { waypointId, employeeRole: "copywriter", type: "post", rationale: "launch post" });

    const { assetId } = await persistAsset(A, { channel: "hackernews", kind: "post", content: { title: "Show HN", body: "We built X" }, routeActionId: actionId });
    await setActionAsset(A, actionId, assetId);

    await approveAction(A, { routeActionId: actionId, principal: "founder@example.com" });
    await startExecution(A, { routeActionId: actionId, runId: "run_ok" });
    await completeExecution(A, { routeActionId: actionId });
    const done = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(done!.status).toBe("executed");

    // attack: a second action, approved, then the asset content is swapped before send
    const { actionId: victim } = await upsertRouteAction(A, { waypointId, employeeRole: "copywriter", type: "post" });
    const bound = await persistAsset(A, { channel: "x", kind: "post", content: { body: "the approved words" }, routeActionId: victim });
    await setActionAsset(A, victim, bound.assetId);
    await approveAction(A, { routeActionId: victim, principal: "founder@example.com" });
    await prisma.asset.update({ where: { id: bound.assetId }, data: { contentJson: JSON.stringify({ body: "EVIL swapped copy" }) } });
    await expect(startExecution(A, { routeActionId: victim, runId: "run_evil" })).rejects.toThrow(/hash mismatch/i);
    const blocked = await prisma.routeAction.findUnique({ where: { id: victim } });
    expect(blocked!.status).toBe("approved"); // refused, not corrupted
    expect(blocked!.runId).toBeNull();
  });

  it("approval without content is impossible; duplicate order and garbage enum are rejected by the hardened tools", async () => {
    const { objectiveId } = await createObjective(A, { kind: "k", target: "1", metric: "m" });
    const { routeId } = await persistRoute(A, { objectiveId, source: "composed" });
    const { waypointId } = await persistWaypoint(A, { routeId, order: 1, title: "t", goal: "g" });
    const { actionId } = await upsertRouteAction(A, { waypointId, employeeRole: "copywriter", type: "post" });
    await expect(approveAction(A, { routeActionId: actionId, principal: "p" })).rejects.toThrow(/no bound asset/i);

    await expect(persistWaypoint(A, { routeId, order: 1, title: "dupe", goal: "g" })).rejects.toThrow(/unique/i);
    await expect(persistRoute(A, { objectiveId, source: "case", status: "garbage" as never })).rejects.toThrow(/invalid route status/i);
  });

  it("cross-tenant approval attack fails closed", async () => {
    await prisma.business.upsert({ where: { id: "biz_lceval_ghost" }, create: { id: "biz_lceval_ghost", name: "G" }, update: {} });
    const rows = await prisma.routeAction.findMany({ where: { businessId: A.businessId, status: "approved" } });
    expect(rows.length).toBeGreaterThan(0);
    await expect(approveAction({ businessId: "biz_lceval_ghost" }, { routeActionId: rows[0]!.id, principal: "ghost" }))
      .rejects.toThrow(/not found|scope/i);
  });
});
```

- [ ] **Step 2: Run the gate, then BOTH full suites + BOTH builds** (mcp from `packages/dionysus-mcp`, then `pnpm build` there, then department suite from `packages/department` — expect 40). If an invariant fails, fix the offending module test-first; never weaken the gate.

- [ ] **Step 3: Commit** — `git add -A; git commit -m "test: stage-3c eval gate - content-bound approval survives tamper, no agent status path"`

---

## Out of Scope (deliberate — later stages)

- The signed approval **record** as a separate audit table + step-up auth (H3 magic-link/MFA) — stage 4 cockpit build; at 3c the signing tuple lands as columns (`approvedBy`, `approvedAt`, `contentHash`, businessId scoping).
- `revisionOf` chat-iteration chains, `editDistance`, `digestId`/Digest model (D22) — stage 4.
- The actual execution runner + D30 platform wake ("approval spawns a new execution run") — `startExecution`/`completeExecution` are the primitives it will call.
- The cockpit UI and its service layer (which calls `approveAction`/`rejectAction`).
- Broker/publish paths (`broker.publish`) — stage 5.

## Self-Review Notes

- **Spec coverage:** D29 line-by-line — hash at draft time (T3 via setActionAsset), content-bound approve (T4), send-path refusal on mismatch (T4 startExecution + T5 attack), server-validated transitions `proposed→approved→executing→executed|rejected` (T4), never agent-asserted (T5 TOOL_SCHEMAS scan + upsert_route_action unchanged); 3a deferred hardening — enums both layers (T2), `@@unique([routeId, order])` (T1). §15 gate (T5).
- **Type consistency:** `hashContent` (T3) used in T4; enum constants (T2) asserted in T2 tests and exercised via `persistRoute` garbage in T5; lifecycle input types self-contained; `makeChain`/`boundAction` helpers defined in the test file they're used in.
- **Judgment calls on record:** lifecycle functions are exported functions, not MCP tools (D29's cockpit path — stage 4's service calls them); rejection is terminal (re-draft = new action, matching 3b's provenance model); `approvedAt` uses the server clock (`new Date()` — no signing key yet, H3 lands at stage 4); `reset-test-db.mjs` run in T1 because pre-existing test rows may violate the new unique constraint; department is deliberately untouched — its 40 tests are the cross-package regression net.
