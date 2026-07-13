# Dogfood Bootstrap (Stage 6d — run the built system for real) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the built system runnable end-to-end by the founder on this machine (D31: dogfood launch = case #1): a fail-closed preflight doctor, idempotent business provisioning, and an EXECUTED runbook covering gateway + cockpit + the scheduled nightly — everything verifiable without external accounts (hosting/analytics/OAuth stay a founder decision, documented as next steps).

**Architecture:** `src/lib/preflight.ts` (mcp) is a pure, injectable check core (per-service required/warn checks; secret VALUES never surfaced) with a thin `scripts/preflight.mjs` CLI. `src/tools/provision.ts` is a validated idempotent Business upsert (platform-operator level, like the sweep) with a thin `scripts/provision-business.mjs` CLI. `docs/DEPLOY.md` is the Windows-first runbook — and its core loop is EXECUTED against a scratch DB as this stage's acceptance.

**Tech Stack:** No new dependencies, no schema change. dionysus-mcp only (+ the root doc).

## Global Constraints

- **Fail-closed vs warn, honestly.** A check is `ok:false` ONLY when the service genuinely refuses to work (gateway without `GATEWAY_UPSTREAM_URL`; cockpit without `COCKPIT_SESSION_SECRET`; anything without `DATABASE_URL`/a reachable DB). Degradable configs (missing `DIONYSUS_CONFIG_KEY` → metrics skip honestly; missing `COCKPIT_BASE_URL` → localhost default; missing `GATEWAY_TOKEN` → unauthenticated local gateway) are WARN (`ok:true`, detail prefixed `WARN:`). No check ever lies about severity.
- **Secrets never surface.** Preflight output reports presence/validity ONLY (e.g. "set (32 bytes)"), never a value or prefix. Provisioning prints no secrets.
- **Idempotent provisioning.** `provisionBusiness` upserts by id — re-running updates name/url/ownerEmail/maxTokensPerDay, never duplicates, never destroys child rows. Input validated (id slug `[a-z0-9_-]{3,40}`, email shape, positive token cap).
- **NOT MCP** (whitelist stays 11); scripts are operator-level (like the sweep/issue-login-link — trusted platform code, no ambient identity needed). CLIs import from `../dist/`.
- No `console.log` in src (the CLIs print — they are operator output, the live-smoke/nightly convention). ESM `.js` specifiers. PowerShell ops (Git Bash broken).
- **Baselines at stage start:** mcp **330**, dept **105**, cockpit **56**.

---

## Task 1: The preflight doctor

**Files:**
- Create: `packages/dionysus-mcp/src/lib/preflight.ts`
- Create: `packages/dionysus-mcp/scripts/preflight.mjs`
- Modify: `packages/dionysus-mcp/package.json` (add `"preflight": "node scripts/preflight.mjs"`)
- Test: `packages/dionysus-mcp/test/preflight.test.ts`

**Interfaces (produces):**

```typescript
export type PreflightService = "gateway" | "cockpit" | "nightly" | "all";
export type CheckResult = { service: string; name: string; ok: boolean; detail: string };
export type PreflightReport = { ok: boolean; checks: CheckResult[] };
export function runPreflight(opts: {
  service?: PreflightService;                       // default "all"
  env?: Record<string, string | undefined>;         // default process.env
  dbProbe?: () => Promise<void>;                    // default: prisma.$queryRaw`SELECT 1` (throw = unreachable)
}): Promise<PreflightReport>;
```

Checks (exact semantics):
- **common** (every service): `DATABASE_URL` set (FAIL if missing); DB reachable via the probe (FAIL, detail carries the error message class only).
- **gateway**: `GATEWAY_UPSTREAM_URL` set (FAIL — the config refuses to boot without it); `GATEWAY_PORT` unset or a positive integer (FAIL when set-but-invalid); `GATEWAY_UPSTREAM_KEY` set (WARN when missing: "upstream may reject unauthenticated calls"); `GATEWAY_TOKEN` set (WARN when missing: "gateway accepts unauthenticated local callers").
- **cockpit**: `COCKPIT_SESSION_SECRET` set AND ≥ 16 chars (FAIL — sessions are unusable/weak otherwise; detail reports length class only, e.g. "set (ok length)" / "set but shorter than 16 chars"); `COCKPIT_BASE_URL` set (WARN when missing: "magic links will print localhost").
- **nightly**: `DIONYSUS_CONFIG_KEY` decodes from base64 to EXACTLY 32 bytes (WARN when missing: "metric ingestion will be skipped"; FAIL when set-but-malformed — a wrong key silently degrades every decrypt, worse than absent); `GATEWAY_LOCAL_URL` set (WARN when missing: "defaults to http://127.0.0.1:8787/v1").
- `report.ok` = no FAIL across the selected service set. Secret VALUES never appear in any detail.

The CLI: `node scripts/preflight.mjs [service]` — imports `runPreflight` from `../dist/lib/preflight.js`, prints one line per check (`[PASS]`/`[WARN]`/`[FAIL] service/name — detail`, WARN = ok:true with the `WARN:` prefix stripped into the tag), a summary line, exit 0 iff `report.ok` (warnings do not fail the exit).

- [ ] **Step 1: failing tests** — `test/preflight.test.ts` (pure — inject env + a stub dbProbe; never touch real env):

```typescript
// Cases (write complete code):
// 1. all-green env (every var set validly, resolving probe) → ok:true, zero FAILs; WARN-free.
// 2. gateway without GATEWAY_UPSTREAM_URL → ok:false; the failing check names it; a service:"cockpit"
//    run with the same env stays ok (service scoping works).
// 3. cockpit with a 8-char COCKPIT_SESSION_SECRET → ok:false; detail does NOT contain the secret value.
// 4. nightly with DIONYSUS_CONFIG_KEY absent → ok:true but a WARN check mentions "skipped";
//    with a malformed (base64 of 5 bytes) key → ok:false.
// 5. DB probe rejecting → ok:false with the db check failing; detail does not include a stack.
// 6. SECRETS NEVER SURFACE: run with distinctive secret values (e.g. "sk-SECRETVALUE...") across
//    all services; JSON.stringify(report) does not contain any of them.
```

- [ ] **Step 2: RED → implement `preflight.ts`** (pure check builders per service, a small `check(name, ok, detail)` helper, the WARN convention `ok:true, detail: "WARN: ..."`; the default dbProbe lazily imports prisma so unit tests never touch the DB) **→ GREEN + full mcp suite + build.**
- [ ] **Step 3: CLI + package script; verify by running it against the real test DB env** (expect: gateway FAIL [no upstream url] → exit 1; then with a dummy `GATEWAY_UPSTREAM_URL` + valid key/secret env → exit 0 with WARNs). Paste the output in the task report.
- [ ] **Step 4: Commit** — `feat: preflight doctor - fail-closed per-service checks, secrets never surfaced`

---

## Task 2: Business provisioning

**Files:**
- Create: `packages/dionysus-mcp/src/tools/provision.ts`
- Create: `packages/dionysus-mcp/scripts/provision-business.mjs`
- Modify: `packages/dionysus-mcp/package.json` (add `"provision": "node scripts/provision-business.mjs"`)
- Test: `packages/dionysus-mcp/test/provision.test.ts`

**Interfaces (produces):**

```typescript
export type ProvisionInput = { id: string; name: string; ownerEmail: string; url?: string; maxTokensPerDay?: number };
export type ProvisionResult = { businessId: string; created: boolean; name: string; ownerEmail: string; maxTokensPerDay: number };
export function provisionBusiness(input: ProvisionInput): Promise<ProvisionResult>;
```

Semantics: validate FIRST (id matches `/^[a-z0-9_-]{3,40}$/`; ownerEmail matches a simple `/^\S+@\S+\.\S+$/`; maxTokensPerDay a positive integer when given, default 100000; name non-empty) — invalid throws, nothing written. Then upsert by id (`created` = whether it existed); update sets name/ownerEmail/url/maxTokensPerDay only (child rows untouched).

CLI: `node scripts/provision-business.mjs <id> <name> <ownerEmail> [url] [maxTokensPerDay]` — prints the summary (`provisioned <id> (created|updated) — owner <email>, cap <n> tokens/day`) and a NEXT-STEPS hint (issue a login link via cockpit's `issue-login-link.mjs`). Exit 1 with the validation message on bad input.

- [ ] **Step 1: failing tests** (complete code; cases: create → created:true + row fields; re-provision with a new cap → created:false + cap updated + an existing child row [seed one objective] untouched; each validation failure throws + writes nothing).
- [ ] **Step 2: RED → implement → GREEN + full mcp suite + build.**
- [ ] **Step 3: CLI; verify against the test DB** (`provision-business.mjs dogfood-co "Dogfood Co" founder@example.com` → created; re-run → updated). Paste output in the report.
- [ ] **Step 4: Commit** — `feat: provisionBusiness - validated idempotent onboarding, the operator's first step`

---

## Task 3: The runbook — written AND executed

**Files:**
- Create: `docs/DEPLOY.md`
- (No src changes. The acceptance is an EXECUTED dogfood loop on this machine.)

**The runbook covers (Windows-first, PowerShell):**
1. Prereqs (Node 22+, pnpm 9, `pnpm install`), build order (`pnpm -F dionysus-mcp build` → `pnpm -F department build` → `pnpm -F cockpit build`).
2. The production DB: pick a real path (e.g. `D:\Dionysus\data\dionysus.db` → `DATABASE_URL="file:D:/Dionysus/data/dionysus.db"` — NOTE Prisma resolves relative `file:` URLs against the schema dir, so ABSOLUTE paths are the safe choice in production); create it with `pnpm -F dionysus-mcp exec prisma db push`; back up by copying the file.
3. Secrets generation (PowerShell): `DIONYSUS_CONFIG_KEY` = `[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))` — note: prefer `RandomNumberGenerator` one-liner (give the exact command); `COCKPIT_SESSION_SECRET` similarly (≥32 chars). Where to put them (a `.env.dogfood.ps1` you dot-source; NEVER commit).
4. Services: gateway (`$env:GATEWAY_UPSTREAM_URL=...; pnpm -F dionysus-mcp start:gateway`), cockpit (`pnpm -F cockpit build; $env:COCKPIT_SESSION_SECRET=...; pnpm -F cockpit start`), each in its own terminal.
5. Provision + first login: `pnpm -F dionysus-mcp provision ...` then `node packages/cockpit/scripts/issue-login-link.mjs <id> <email>` → open the link.
6. The nightly on a schedule: the exact `schtasks /Create ...` command registering a 03:00 daily task that runs a small `run-nightly.ps1` wrapper (sets env, `pnpm --filter department nightly`, appends output to `logs\nightly-<date>.log`). Include the wrapper script INLINE in the doc.
7. Preflight: `pnpm -F dionysus-mcp preflight` before first run and after any env change.
8. Objective/route bootstrap note: the discover/propose pipelines run via the department entry points (point at the live-smoke script as the current operator path; a founder-facing onboarding flow is future work).
9. **What still needs the founder** (honest next-steps): the GitHub push (DrunkMacintosh re-auth); a real model-provider key for the gateway upstream; a real analytics source for /connect; hosting (containers/wake/webhook HMAC/TrustPolicy = the deferred platform layer).

- [ ] **Step 1: Write docs/DEPLOY.md** per the outline (complete commands, no placeholders except `<your-...>` for genuine founder secrets).
- [ ] **Step 2: EXECUTE the acceptance loop against a SCRATCH DB** (never the test DB): set `DATABASE_URL="file:D:/Dionysus/data/dogfood-scratch.db"`, `prisma db push`, `provision`, `issue-login-link` (assert a URL prints), `preflight all` with generated secrets + a dummy upstream (expect ok with WARNs or a clean FAIL taxonomy — record which), and one `pnpm --filter department nightly` run (gateway down → per-business failed/skipped, exit 0). Paste the transcript (trimmed) into the task report. Delete the scratch DB afterwards.
- [ ] **Step 3: Commit** — `docs: DEPLOY runbook - the executed dogfood bootstrap (gateway, cockpit, scheduled nightly)`

---

## Self-Review

**Coverage:** the D31 dogfood path is now operable: provision → login → objective/route (operator path) → nightly (scheduled) → cockpit review — with preflight guarding misconfiguration fail-closed and the runbook executed, not just written. Honest boundaries: hosting/analytics/OAuth/push remain founder decisions, listed as next steps; container-per-business, webhook HMAC, TrustPolicy stay deferred to the real platform layer (unchanged).

**Placeholders:** T1/T2 test steps are complete-case recipes (the established convention); T3's acceptance is an executed transcript, not prose.

**Type consistency:** `PreflightReport`/`CheckResult` (T1) consumed by its CLI; `ProvisionInput/Result` (T2) by its CLI; no cross-package changes.

## Execution Handoff

Subagent-Driven (recommended) — fresh Opus subagent per task, review between tasks, whole-branch review at the end.
