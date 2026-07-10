# Stage 4d — Verified Send (Assisted-Manual) + CSRF Mitigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop: an approved draft gets posted by the founder, the system verifies the PUBLIC URL actually carries the approved content (D29 at the publish moment), and the action lands `executed` with `verifiedAt` — never claiming an unverified send (§3). Opens with the 4a-scheduled security debt: magic-link redemption becomes a POST-only act (no more prefetch link-burn, no more login-CSRF/session-fixation).

**Architecture:** (1) Cockpit auth rewrite: `GET /auth/[token]` renders a pure interstitial (no redemption); redemption moves to a Next **server action** (origin-enforced natively) that refuses over an existing valid session and never burns a link on refusal. (2) dionysus-mcp gains `submitVerifiedSend` — a cockpit-tier server function (NOT an MCP tool; agents must never claim sends): `assertContentBound` at the publish moment → `startExecution` → safeFetch the public URL (stage-1 SSRF guard) → content-match the approved snippet → persist `postedUrl/verifiedAt/outcome` THEN `completeExecution` (retry-safe ordering). (3) Cockpit gains a Send queue page. Outcome-poller DEFERRED to 4e (nothing to poll yet — no integrations, no click infra; recorded).

**Tech Stack:** unchanged — Prisma 6, vitest, cheerio (already a dionysus-mcp dep), stage-1 `safeFetch` with its test seams; Next 15 server actions. No new dependencies.

## Global Constraints

- **CSRF/H3 posture (the 4a-recorded debt, discharged here):** redemption is POST-only via a server action (Next enforces Origin==Host on actions — a cross-site form POST is rejected before our code runs); the GET page is PURE (renders a form, never calls `verifyMagicLink` — prefetchers cannot burn links); redemption is REFUSED over an existing VALID session (an attacker's link can no longer silently swap the victim's tenant) and on host mismatch vs `COCKPIT_BASE_URL` — and a refusal NEVER consumes the token. Failure surface stays uniform (`/login?error=invalid`).
- **D29 at the publish moment (stage-5 obligation, discharged for this channel class):** `submitVerifiedSend` calls `assertContentBound` BEFORE anything else happens to the action; the public-page content-match then proves the real world carries the approved content — stronger than the hash alone.
- **§3 honesty:** `verifiedAt`/`outcome:"verified"` are set ONLY when the public URL is fetched and the approved snippet is found. A live-but-mismatched page throws; the action stays `executing` and is retryable. No founder-override at 4d (YAGNI, recorded).
- **Write ordering (retry-safe, ratified):** verify → `updateMany(postedUrl, verifiedAt, outcome)` (still `executing`) → `completeExecution` LAST. A crash between the two leaves an `executing` action whose retry re-verifies and completes — never an `executed` action missing its verification fields.
- **Agents cannot send:** `submitVerifiedSend` is NOT MCP-registered; the 11-tool whitelist gate must stay green untouched (D27.2 spirit: no agent-assertable send/outcome).
- **SSRF:** the posted URL goes through stage-1 `safeFetch` (private-IP/redirect/size guards). http(s) only. Tests use safeFetch's existing seams (`__testAllowHosts`-style — read `src/lib/ssrf.ts` for the exact seam) against a localhost fixture server; the SSRF-refusal test uses NO seam.
- **D27.1:** identity from session (cockpit) / ambient (mcp functions); every read/write scoped; cross-parent guards findFirst({id, businessId}).
- **Testing:** TDD; no API key. Env: `$env:DATABASE_URL = "file:./.tmp/test.db"` (+ `$env:COCKPIT_SESSION_SECRET = "test-secret"` for cockpit). dionysus-mcp BUILT before dependents. Baselines: mcp 141, dept 53, cockpit 31 — dept must stay green untouched. NOTE: Task 1 REPLACES the 4a auth-route tests (the GET-redeem flow they pin no longer exists) — a deliberate, reviewed deletion, not a weakening: every property they pinned is re-pinned against the new flow.
- **Commits:** conventional, no attribution footer. **Shell:** Windows/PowerShell (Git Bash broken); pnpm workspace.

## File Structure

```
packages/cockpit/
  src/lib/redeem.ts               # redeemLoginCore (host check -> live-session refusal -> redeem; never burns on refusal)
  src/app/actions-auth.ts         # "use server" redeemLogin (secret first, sets cookie, redirects)
  src/app/auth/[token]/page.tsx   # PURE interstitial (replaces route.ts — DELETED)
  src/lib/review.ts               # + listSendQueue / listExecuted
  src/lib/review-actions.ts       # + submitSendCore
  src/app/actions.ts              # + submitSend wrapper
  src/app/send/page.tsx           # Send queue + verified history
  src/app/layout.tsx              # + Send nav link
  test/redeem.test.ts             # REPLACES test/auth-route.test.ts
  test/review.test.ts             # + send-queue tests
  test/review-actions.test.ts     # + submitSendCore refusal-path tests
packages/dionysus-mcp/
  prisma/schema.prisma            # RouteAction + postedUrl/verifiedAt/outcome
  src/lib/send-verify.ts          # normalizeForMatch / verificationSnippet / htmlContainsSnippet (pure)
  src/tools/send.ts               # submitVerifiedSend (NOT MCP-registered)
  test/send-verify.test.ts
  test/send.test.ts               # localhost fixture server + seams
  test/send-eval.e2e.test.ts      # Task 6 §15 gate
```

---

### Task 1: POST-only redemption (the CSRF mitigation)

**Files:**
- Create: `packages/cockpit/src/lib/redeem.ts`, `src/app/actions-auth.ts`, `src/app/auth/[token]/page.tsx`
- Delete: `packages/cockpit/src/app/auth/[token]/route.ts`
- Replace: `packages/cockpit/test/auth-route.test.ts` → `test/redeem.test.ts`

**Interfaces:**
- Produces: `redeemLoginCore(token: string, opts: { existingCookie?: string; requestHost?: string; secret: string; now?: number }): Promise<{ ok: true; sessionToken: string } | { ok: false }>` — order: host check → live-session refusal → `verifyMagicLink` (refusals NEVER reach it); uniform `{ok:false}`. Server action `redeemLogin(formData)` — `sessionSecret()` FIRST, then core with cookie+host from request scope, sets the session cookie (same flags as 4a), redirects `/` or `/login?error=invalid`.

- [ ] **Step 1: Write the failing tests**

`packages/cockpit/test/redeem.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { issueMagicLink, verifyMagicLink } from "../src/lib/magic-link";
import { createSessionToken, verifySessionToken } from "../src/lib/session";
import { redeemLoginCore } from "../src/lib/redeem";

const BIZ = "biz_redeem";
const SECRET = "test-secret";

beforeAll(async () => {
  await prisma.magicLink.deleteMany({ where: { businessId: BIZ } });
  await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "RD" }, update: {} });
  delete process.env.COCKPIT_BASE_URL;
});

describe("redeemLoginCore (POST-only redemption)", () => {
  it("redeems a valid token into a verifiable session bound to the link's business", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const res = await redeemLoginCore(token, { secret: SECRET });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const session = verifySessionToken(res.sessionToken, SECRET);
      expect(session?.businessId).toBe(BIZ);
      expect(session?.email).toBe("f@example.com");
    }
    const replay = await redeemLoginCore(token, { secret: SECRET });
    expect(replay.ok).toBe(false); // single-use survives the rewrite
  });

  it("REFUSES over an existing VALID session — and the link is NOT consumed", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const live = createSessionToken({ businessId: "biz_other", email: "victim@example.com", exp: Date.now() + 60_000 }, SECRET);
    const refused = await redeemLoginCore(token, { secret: SECRET, existingCookie: live });
    expect(refused.ok).toBe(false);
    const after = await redeemLoginCore(token, { secret: SECRET }); // no live session now
    expect(after.ok).toBe(true); // token survived the refusal
  });

  it("a stale/invalid existing cookie does NOT block login", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const stale = createSessionToken({ businessId: BIZ, email: "f@example.com", exp: Date.now() - 1 }, SECRET);
    const res = await redeemLoginCore(token, { secret: SECRET, existingCookie: stale });
    expect(res.ok).toBe(true);
  });

  it("host mismatch vs COCKPIT_BASE_URL refuses WITHOUT consuming the token", async () => {
    process.env.COCKPIT_BASE_URL = "http://localhost:3000";
    try {
      const { token } = await issueMagicLink(BIZ, "f@example.com");
      const refused = await redeemLoginCore(token, { secret: SECRET, requestHost: "evil.example" });
      expect(refused.ok).toBe(false);
      const ok = await redeemLoginCore(token, { secret: SECRET, requestHost: "localhost:3000" });
      expect(ok.ok).toBe(true); // not burned by the forged-host attempt
    } finally {
      delete process.env.COCKPIT_BASE_URL;
    }
  });

  it("bad/expired tokens yield the uniform {ok:false}", async () => {
    expect((await redeemLoginCore("bogus", { secret: SECRET })).ok).toBe(false);
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    await prisma.magicLink.updateMany({ where: { businessId: BIZ, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeemLoginCore(token, { secret: SECRET })).ok).toBe(false);
  });

  it("the GET page is PURE: rendering the interstitial consumes nothing (structural — the page module never imports verifyMagicLink)", async () => {
    const pageSource = (await import("node:fs/promises")).readFile;
    const src = await pageSource(new URL("../src/app/auth/[token]/page.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("verifyMagicLink");
    expect(src).not.toContain("redeemLoginCore"); // redemption lives only behind the POST action
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement**

`src/lib/redeem.ts`:

```ts
import { verifyMagicLink } from "./magic-link";
import { createSessionToken, verifySessionToken } from "./session";
import { SESSION_TTL_MS } from "./auth";

export type RedeemResult = { ok: true; sessionToken: string } | { ok: false };

/**
 * H3 + CSRF posture (4a debt): redemption is a POST-only act. Refusal order matters —
 * host check, then live-session refusal, then (and only then) the single-use redemption,
 * so no refusal ever burns the founder's link.
 */
export async function redeemLoginCore(
  token: string,
  opts: { existingCookie?: string; requestHost?: string; secret: string; now?: number },
): Promise<RedeemResult> {
  const baseUrl = process.env.COCKPIT_BASE_URL;
  if (baseUrl && opts.requestHost && new URL(baseUrl).host !== opts.requestHost) return { ok: false };
  if (opts.existingCookie && verifySessionToken(opts.existingCookie, opts.secret, opts.now) !== null) {
    return { ok: false }; // a live session must never be silently replaced by a link
  }
  try {
    const { businessId, email } = await verifyMagicLink(token);
    const sessionToken = createSessionToken(
      { businessId, email, exp: (opts.now ?? Date.now()) + SESSION_TTL_MS }, opts.secret);
    return { ok: true, sessionToken };
  } catch {
    return { ok: false }; // uniform — no cause disclosure
  }
}
```

`src/app/actions-auth.ts`:

```ts
"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { redeemLoginCore } from "../lib/redeem";
import { SESSION_COOKIE, SESSION_TTL_MS, sessionSecret } from "../lib/auth";

export async function redeemLogin(formData: FormData): Promise<void> {
  const secret = sessionSecret(); // fail-closed BEFORE anything can burn
  const token = String(formData.get("token") ?? "");
  const jar = await cookies();
  const hdrs = await headers();
  const result = await redeemLoginCore(token, {
    existingCookie: jar.get(SESSION_COOKIE)?.value,
    requestHost: hdrs.get("host") ?? undefined,
    secret,
  });
  if (!result.ok) redirect("/login?error=invalid");
  jar.set(SESSION_COOKIE, result.sessionToken, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  redirect("/");
}
```

`src/app/auth/[token]/page.tsx` (and DELETE `route.ts` — a page and a route handler cannot share the segment):

```tsx
import { redeemLogin } from "../../actions-auth";

export const dynamic = "force-dynamic";

export default async function RedeemPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main>
      <h2>Sign in</h2>
      <p>Press the button to finish signing in. This link works once and expires quickly.</p>
      <form action={redeemLogin}>
        <input type="hidden" name="token" value={token} />
        <button type="submit">Sign in to the cockpit</button>
      </form>
    </main>
  );
}
```

Delete `test/auth-route.test.ts` (every property it pinned — single-use, cookie binding, origin, uniform failure — is re-pinned above against the new flow; cookie FLAGS now live in the thin action, covered by `next build` + the recorded testing judgment).

- [ ] **Step 4: Run** — cockpit suite green (31 − 4 old + 6 new = 33 expected; report actual); `pnpm exec next build` clean (the interstitial page renders, the action compiles).
- [ ] **Step 5: Commit** — `fix: magic-link redemption is POST-only - prefetch cannot burn links, links cannot hijack sessions`

---

### Task 2: RouteAction send columns (additive)

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma` (RouteAction + `postedUrl String?`, `verifiedAt DateTime?`, `outcome String?` — the §10 fields)
- Test: `packages/dionysus-mcp/test/send.test.ts` (schema portion; grows in Task 4)

- [ ] **Step 1: Failing test** — create `test/send.test.ts` with a schema describe asserting a fresh RouteAction has `postedUrl/verifiedAt/outcome` all null (fixture chain like digest.test.ts).
- [ ] **Step 2: Run → FAIL. Step 3: schema edit + `pnpm prisma generate` + `db push`. Step 4: full mcp suite (142 expected) + build + downstream dept (53) + cockpit (Task-1 count).**
- [ ] **Step 5: Commit** — `feat: RouteAction send columns - postedUrl, verifiedAt, outcome (spec §10)`

---

### Task 3: Send-verification pure lib

**Files:**
- Create: `packages/dionysus-mcp/src/lib/send-verify.ts`
- Test: `packages/dionysus-mcp/test/send-verify.test.ts`

**Interfaces:**
- Produces: `normalizeForMatch(s: string): string` (lowercase, collapse whitespace, trim); `verificationSnippet(content: { title?: string; body?: string }): string` (normalized title when ≥8 chars, else normalized first 60 chars of body, else ""); `htmlContainsSnippet(html: string, snippet: string): boolean` (cheerio text-extract wrapped in try/catch — the stage-1 tier-4 lesson — with raw-containment fallback; empty snippet → false).

- [ ] **Step 1: Failing tests** — cases: title chosen over body when meaningful; short title falls to body; both empty → "" and `htmlContainsSnippet(anything, "")` false; snippet found across tags (`<h1>Show <em>HN</em>: We built X</h1>` matches "show hn: we built x"); entity-encoded page (`&amp;` etc.) — assert the cheerio path decodes; whitespace/newline collapse; deeply-broken HTML falls back to raw containment without throwing.
- [ ] **Step 2: Run → FAIL. Step 3: Implement**

```ts
import * as cheerio from "cheerio";

export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The distinctive text a public page must carry to count as the approved post (§3: verify, never assume). */
export function verificationSnippet(content: { title?: string; body?: string }): string {
  const title = normalizeForMatch(content.title ?? "");
  if (title.length >= 8) return title;
  const body = normalizeForMatch(content.body ?? "");
  return body.slice(0, 60).trim();
}

export function htmlContainsSnippet(html: string, snippet: string): boolean {
  if (!snippet) return false;
  try {
    const $ = cheerio.load(html);
    if (normalizeForMatch($.root().text()).includes(snippet)) return true;
  } catch {
    /* stage-1 lesson: parser blowups must not escape — fall through to raw */
  }
  return normalizeForMatch(html).includes(snippet);
}
```

- [ ] **Step 4: Run → green; full mcp suite; build. Step 5: Commit** — `feat: send-verification snippet matching (pure, parser-blowup safe)`

---

### Task 4: `submitVerifiedSend` — D29 at the publish moment

**Files:**
- Create: `packages/dionysus-mcp/src/tools/send.ts`
- Test: `packages/dionysus-mcp/test/send.test.ts` (append)

**Interfaces:**
- Consumes: `assertContentBound`/`startExecution`/`completeExecution` (lifecycle), `safeFetch` (READ `src/lib/ssrf.ts` FIRST for the exact signature, return shape, and test seam — the discovery tests and stage-1 ssrf tests show the localhost-seam pattern), Task-3 lib, `prisma`, `Identity`.
- Produces: `submitVerifiedSend(identity, { routeActionId, postedUrl }, fetchOpts?): Promise<{ runId: string; verifiedAt: Date; outcome: "verified" }>` — NOT MCP-registered. Flow (order is the contract):
  1. Parse+validate URL (http/https only, invalid → throw).
  2. Scoped action load; status must be `approved` (first attempt) or `executing` (retry); anything else → `/invalid transition/`.
  3. `assertContentBound` — the publish-moment hash check (tampered binding never reaches the network).
  4. If `approved`: `startExecution` with `runId = "manual:" + randomBytes(8).toString("hex")`; if `executing`: keep the existing runId (retry).
  5. Record `postedUrl` (scoped updateMany) — auditable even when verification then fails.
  6. Load the bound asset (scoped), parse content defensively (object-guarded — the 4b parsed-null lesson), `verificationSnippet`; empty snippet → throw.
  7. `safeFetch(postedUrl, fetchOpts)` — SSRF-guarded; extract the body text per safeFetch's actual return shape.
  8. `htmlContainsSnippet` fails → throw `Verification failed: the posted page does not contain the approved content...` (action STAYS executing — retryable).
  9. Success: `updateMany(verifiedAt, outcome: "verified")` (still executing) THEN `completeExecution` LAST (crash-safe ordering per Global Constraints).

- [ ] **Step 1: Failing tests** (append to `test/send.test.ts`; spin a localhost `node:http` fixture server in the describe — mirror the ssrf/discovery test seam pattern; seed `maxTokensPerDay` irrelevant here — no budget in the cockpit-tier path, note it):

Required cases:
- happy path: approved + bound → after submit: status executed, runId `manual:` prefixed, postedUrl/verifiedAt set, outcome "verified" (page contains the title).
- content-mismatch page → throws, status stays `executing`, postedUrl recorded, verifiedAt null; then FIX the page and retry the SAME call → succeeds, SAME runId (no second startExecution).
- tampered binding: approve, then raw-update the asset contentJson → submit throws `/hash mismatch/` and status stays `approved`, and the fixture server records ZERO hits (the network is never touched — assert via a hit counter).
- SSRF: `http://127.0.0.1:9/` with NO seam → rejected by safeFetch (private address), status unchanged.
- proposed action → `/invalid transition/`; cross-tenant → `/not found|scope/`.
- invalid URL (`javascript:alert(1)`, `not a url`) → thrown before any DB/network effect.

- [ ] **Step 2: Run → FAIL. Step 3: Implement `src/tools/send.ts`** per the interface (exact code shaped by safeFetch's real signature — the flow order and error surfaces above are the contract; add the file-header comment noting NOT-MCP-registered + D27.2).

- [ ] **Step 4: Run** — mcp suite green (150 expected: 142 + ~8; report actual); build; whitelist gate untouched at 11; downstream dept (53) + cockpit.
- [ ] **Step 5: Commit** — `feat: submitVerifiedSend - public-URL verification closes the loop, content-bound at the publish moment`

---

### Task 5: Cockpit Send queue

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (+ `listSendQueue`/`listExecuted`), `src/lib/review-actions.ts` (+ `submitSendCore`), `src/app/actions.ts` (+ `submitSend` wrapper), `src/app/layout.tsx` (+ Send nav link)
- Create: `packages/cockpit/src/app/send/page.tsx`
- Test: `packages/cockpit/test/review.test.ts` + `test/review-actions.test.ts` (append)

**Interfaces:**
- `listSendQueue(identity): Promise<SendCard[]>` where `SendCard = { actionId, channel, title, body, waypointTitle, status ("approved"|"executing"), postedUrl: string | null }` — approved/executing actions with bound assets, content parsed defensively (for copy-paste).
- `listExecuted(identity): Promise<ExecutedCard[]>` where `ExecutedCard = { actionId, channel, title, postedUrl, verifiedAt, outcome }` — executed actions, newest first.
- `submitSendCore(session, routeActionId, postedUrl): Promise<ActionResult>` — empty-URL friendly refusal BEFORE any call; delegates to `submitVerifiedSend` (no fetch seam — production path); friendly error mapping. `submitSend(prev, formData)` wrapper (useActionState shape, revalidates `/send` + `/`).
- `send/page.tsx` (force-dynamic): requireSession → queue section (each card: content displayed for copying, postedUrl input + "I posted this — verify" via a small client component with useActionState + visible result) + "Verified" history section (✓ postedUrl link — `href` is founder-entered: render as an `<a>` ONLY when it parses as http(s) via `new URL`, else plain text — no javascript: hrefs).

- [ ] **Step 1: Failing tests** — review.test.ts: seed an approved-bound action + an executed one → queue/executed shapes land scoped (other tenant sees neither). review-actions.test.ts: `submitSendCore` empty URL → `{ok:false}` with no DB effect; cross-tenant id → `{ok:false, message: /not found|scope/i}`; proposed action → `{ok:false, message: /invalid transition/i}` (no network needed — refusals throw before fetch).
- [ ] **Step 2: Run → FAIL. Step 3: Implement** (verified-success is deliberately NOT tested at cockpit tier — it needs the fetch seam; the mcp suite + Task-6 gate own it; note in the test file).
- [ ] **Step 4: Run** — cockpit suite green (+~5; report actual); `next build` clean. **Step 5: Commit** — `feat: send queue - copy the approved content, paste the public URL, verify live`

---

### Task 6: §15 eval gate — the loop closes honestly

**Files:**
- Test: `packages/dionysus-mcp/test/send-eval.e2e.test.ts` (test-only; STOP and report BLOCKED if an invariant fails)

Invariants (self-check each for vacuity — seven catches in this project; fixture traps: the tamper test must assert the fixture server got ZERO hits; the mismatch page must CONTAIN plausible other text so the match failure is content-based, not empty-page-based):
1. Full loop via real functions: chain → bind → approve → `submitVerifiedSend` against a localhost page carrying the approved title → `executed` + `verifiedAt` + `outcome "verified"` + `postedUrl`; `runId` has the `manual:` prefix.
2. Honesty: a live page WITHOUT the approved content → throw, action stays `executing`, `verifiedAt` stays null (§3: never claim unverified); the SAME action then retries against a fixed page → `executed`, runId unchanged.
3. Publish-moment D29: approve → tamper the bound asset row → submit → `/hash mismatch/`, fixture server hit-count 0, status still `approved`.
4. SSRF: private-address URL without seam → refused; status unchanged; no row corruption.
5. Agent-tier separation: TOOL_SCHEMAS still the exact 11 (import + assert against the same sorted list the lifecycle gate pins — or reference-note it and assert `Object.keys(TOOL_SCHEMAS)).not.toContain("submit_verified_send")` + length 11).
6. Cross-tenant submit refused with the target existing in tenant A; ghost has zero effect on A's rows.

- [ ] **Step 1: Write the gate. Step 2: Run gate + FULL mcp suite + build; dept (53) + build; cockpit + next build. Report exact counts. Step 3: Commit** — `test: stage-4d eval gate - the loop closes only when the public page carries the approved content`

---

## Out of Scope (deliberate)

- **Outcome-poller** — deferred to 4e (no integrations/click infra exists to poll; 4d's outcome IS the verified-live confirmation; recorded).
- API-channel send via the token broker (D27.3/D19 — stage 5/6a); OAuth `Integration` model.
- Founder override for failed verification ("mark sent anyway") — YAGNI until a design partner hits a real wall (e.g. paywalled channel).
- Re-verification / link-rot monitoring (poller territory, 4e+).
- ClickEvent tracking + tracked links (needs public redirect infra — later).
- Email delivery of magic links (the interstitial makes links prefetch-safe for WHEN email lands — but delivery itself is still out).

## Self-Review Notes

- **Spec coverage:** Goals "verified posting (public-URL confirmation…, never stored cookies)" (T4); §10 outcome/verifiedAt fields (T2); §3 honesty — verified only when proven (T4/T6); stage-5 obligation `assertContentBound` at the publish moment (T4 step 3, gate inv. 3); H3/CSRF debt from 4a (T1); D27.2 no-agent-sends (NOT registered + gate inv. 5).
- **Type consistency:** `RedeemResult` (T1) self-contained; `SendCard`/`ExecutedCard` (T5) self-contained; `submitVerifiedSend`'s result consumed by `submitSendCore`; Task-3 helpers consumed by T4.
- **Judgment calls on record:** assisted-manual is THE 4d channel class (D19: Reddit/PH have no APIs anyway; API channels need the broker); snippet matching is best-effort textual containment (title-preferred) — a determined founder could fake a page, but the founder is the trusted principal here; the check defends against MISTAKES (wrong URL, unposted draft), not founder fraud; no budget gate in submitVerifiedSend (no model call; safeFetch is bounded); auth-route test file replaced wholesale (old flow deleted) with every property re-pinned; cockpit verified-success path tested only at mcp/gate tier (fetch seam lives there).
